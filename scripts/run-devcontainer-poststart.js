// dispatcher.yml's `handle` job runs a dispatched agent inside the target
// repo's own dev-image, but never ran that repo's devcontainer
// `postStartCommand` — the thing a project actually relies on to install deps
// into the checked-out workspace, download browser binaries, etc. (issue
// #207). This is that step's logic, factored out of the workflow YAML since
// it needs JSONC-tolerant parsing, devcontainer variable substitution, and
// process execution — more than is reasonable to inline into a `run:` block.
//
// Only the single top-level `.devcontainer/devcontainer.json` layout is
// supported (no `.devcontainer/<name>/devcontainer.json` variants) and only
// the string and array-of-strings forms of `postStartCommand` — the object
// form (parallel named commands) is a spec-allowed nice-to-have that no repo
// in this org currently uses, so it's treated as an unsupported shape (logged
// and skipped) rather than implemented and left untested.
//
// Every failure mode here (missing file, malformed JSON, unsupported shape,
// unsupported variable, non-zero exit, timeout) is non-fatal by design: a
// broken postStartCommand in some target repo must not be able to take down
// dispatch to that repo. Callers get a warning, never a thrown error.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEVCONTAINER_RELATIVE_PATH = path.join('.devcontainer', 'devcontainer.json');
const CONTAINER_WORKSPACE_VAR = '${containerWorkspaceFolder}';
const VARIABLE_PATTERN = /\$\{[^}]*\}/g;

// Strips `//` and `/* */` comments while respecting string literals, so a
// URL or path containing `//` inside a quoted value survives untouched.
// JSONC (the devcontainer.json spec) allows both comment styles even though
// no repo in this org currently uses them.
function stripJsonComments(text) {
  let result = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      result += c;
      if (c === '\\' && i + 1 < text.length) {
        result += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

// Drops a trailing comma before a closing `}`/`]` (also JSONC-legal, also
// respecting string literals), so `JSON.parse` doesn't choke on it.
function stripTrailingCommas(text) {
  let result = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      result += c;
      if (c === '\\' && i + 1 < text.length) {
        result += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      i++;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    result += c;
    i++;
  }
  return result;
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

// Replaces `${containerWorkspaceFolder}` with the real checkout path.
// `${localWorkspaceFolder}`, `${localEnv:...}`, and friends are host-side
// devcontainer concepts with no meaning inside this already-running
// container — if one is still present after substitution, the caller must
// skip running that command rather than pass the literal placeholder to a
// shell.
function substituteVariables(value, workspaceFolder) {
  const substituted = value.split(CONTAINER_WORKSPACE_VAR).join(workspaceFolder);
  const remaining = substituted.match(VARIABLE_PATTERN);
  if (remaining) {
    return { ok: false, unsupported: remaining };
  }
  return { ok: true, value: substituted };
}

// String -> one shell command. Array of strings -> one exec-form command
// (no shell). Anything else (object form, mixed-type array, etc.) is an
// unsupported shape.
function normalizePostStartCommand(postStartCommand) {
  if (typeof postStartCommand === 'string') {
    return [{ type: 'shell', command: postStartCommand }];
  }
  if (
    Array.isArray(postStartCommand) &&
    postStartCommand.length > 0 &&
    postStartCommand.every((item) => typeof item === 'string')
  ) {
    return [{ type: 'exec', args: postStartCommand }];
  }
  return null;
}

function substituteSpec(spec, workspaceFolder) {
  if (spec.type === 'shell') {
    const result = substituteVariables(spec.command, workspaceFolder);
    return result.ok ? { ok: true, spec: { ...spec, command: result.value } } : result;
  }
  const args = [];
  const unsupported = [];
  for (const arg of spec.args) {
    const result = substituteVariables(arg, workspaceFolder);
    if (result.ok) args.push(result.value);
    else unsupported.push(...result.unsupported);
  }
  return unsupported.length > 0 ? { ok: false, unsupported } : { ok: true, spec: { ...spec, args } };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Exec-form args are joined into a single quoted shell string rather than
// run shell-free, because `su`'s `-c` always hands its argument to the
// target user's shell — there's no shell-free equivalent available here
// without assuming `sudo` is configured in every target image. Quoting each
// arg individually still gets exec form's actual safety property (no
// word-splitting/globbing within an arg).
function commandToShellString(spec) {
  return spec.type === 'shell' ? spec.command : spec.args.map(shellQuote).join(' ');
}

// Runs as the `dev` user (never root) via `su`, matching the same user
// "Run agent" runs the agent CLI as. Assumes the workspace is already
// chown'd to dev:dev by the "Ensure dev user and workspace ownership" step
// that now runs ahead of both this script and "Run agent".
function runAsDev(spec, { cwd, execFn = execFileSync } = {}) {
  const command = commandToShellString(spec);
  return execFn('su', ['dev', '-c', command], {
    cwd,
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/home/dev',
    },
  });
}

function run({ targetDir, devcontainerPath, execFn = execFileSync, log = console.log, warn = console.warn } = {}) {
  const filePath = devcontainerPath || path.join(targetDir, DEVCONTAINER_RELATIVE_PATH);

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log(`No devcontainer.json found at ${filePath}; skipping postStartCommand.`);
    return { ran: false, reason: 'missing-file' };
  }

  let parsed;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    warn(`::warning::Failed to parse ${filePath} as JSONC (${err.message}); skipping postStartCommand.`);
    return { ran: false, reason: 'parse-error' };
  }

  const postStartCommand = parsed && parsed.postStartCommand;
  if (postStartCommand === undefined || postStartCommand === null || postStartCommand === '') {
    log(`No postStartCommand in ${filePath}; nothing to run.`);
    return { ran: false, reason: 'no-command' };
  }

  const specs = normalizePostStartCommand(postStartCommand);
  if (!specs) {
    warn(`::warning::Unsupported postStartCommand shape in ${filePath} (expected a string or array of strings); skipping.`);
    return { ran: false, reason: 'unsupported-shape' };
  }

  let ok = true;
  for (const spec of specs) {
    const substitution = substituteSpec(spec, targetDir);
    if (!substitution.ok) {
      warn(
        `::warning::postStartCommand references unsupported variable(s) ${substitution.unsupported.join(', ')} ` +
          '— these are host-side devcontainer concepts with no meaning in this container; skipping.'
      );
      ok = false;
      continue;
    }
    try {
      runAsDev(substitution.spec, { cwd: targetDir, execFn });
    } catch (err) {
      warn(`::warning::devcontainer postStartCommand failed: ${err.message}`);
      ok = false;
    }
  }

  return { ran: true, ok };
}

module.exports = {
  DEVCONTAINER_RELATIVE_PATH,
  CONTAINER_WORKSPACE_VAR,
  stripJsonComments,
  stripTrailingCommas,
  parseJsonc,
  substituteVariables,
  normalizePostStartCommand,
  substituteSpec,
  shellQuote,
  commandToShellString,
  run,
};

if (require.main === module) {
  const targetDir = process.env.TARGET_DIR;
  if (!targetDir) {
    console.warn('::warning::TARGET_DIR is not set; skipping devcontainer postStartCommand.');
    process.exit(0);
  }
  try {
    run({ targetDir });
  } catch (err) {
    console.warn(`::warning::Unexpected error running devcontainer postStartCommand: ${err.message}`);
  }
  process.exit(0);
}
