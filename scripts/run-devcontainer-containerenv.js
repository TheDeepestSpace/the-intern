// dispatcher.yml runs the resolved custom image as a raw GitHub Actions job —
// it never shells out to the devcontainer CLI or `docker run`, so none of
// devcontainer.json's fields apply automatically. `postStartCommand` got this
// treatment in run-devcontainer-poststart.js (issue #207); `containerEnv`
// needs the same treatment (issue #222) so that values like svsch's
// `SVSCH_LOCAL_NO_VIDEO=1` actually reach the dispatched session instead of
// being silently dropped.
//
// Unlike postStartCommand, `containerEnv` has only one spec-legal shape: a
// flat `{ [key: string]: string }` map — no array/object-of-commands
// variants to normalize.
//
// Resolved vars are written to $GITHUB_ENV so they become normal job-level
// env vars, visible to every later step (including both `su dev -c`
// invocations in dispatcher.yml) without per-step threading. Every failure
// mode here (missing file, malformed JSON, unsupported shape, unsupported
// variable, non-string value) is non-fatal by design, matching
// run-devcontainer-poststart.js: a broken devcontainer.json in some target
// repo must not be able to take down dispatch.
const fs = require('fs');
const path = require('path');
const { DEVCONTAINER_RELATIVE_PATH, parseJsonc, substituteVariables } = require('./run-devcontainer-poststart');

// Runs each value through the same substituteVariables() used for
// postStartCommand, so ${containerWorkspaceFolder} etc. resolve consistently.
// Non-string values and values referencing unsupported host-side variables
// are skipped (never silently pass a literal placeholder or non-string
// through), leaving `resolved` containing only the vars safe to export.
function resolveContainerEnv(containerEnv, workspaceFolder) {
  const resolved = {};
  const skipped = [];
  for (const [key, value] of Object.entries(containerEnv)) {
    if (typeof value !== 'string') {
      skipped.push({ key, reason: 'non-string-value' });
      continue;
    }
    const result = substituteVariables(value, workspaceFolder);
    if (!result.ok) {
      skipped.push({ key, reason: 'unsupported-variable', unsupported: result.unsupported });
      continue;
    }
    resolved[key] = result.value;
  }
  return { resolved, skipped };
}

// KEY<<DELIMITER / value / DELIMITER form (rather than KEY=value) for every
// var, not just ones known to contain newlines — containerEnv values are
// arbitrary target-repo-authored strings, so this is the safe default asked
// for in issue #222 rather than something to special-case per value.
function appendToGithubEnv(resolved, githubEnvPath, appendFn = fs.appendFileSync) {
  for (const [key, value] of Object.entries(resolved)) {
    const delimiter = `GHENV_${Math.random().toString(36).slice(2)}`;
    appendFn(githubEnvPath, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

function run({ targetDir, devcontainerPath, githubEnvPath, log = console.log, warn = console.warn } = {}) {
  const filePath = devcontainerPath || path.join(targetDir, DEVCONTAINER_RELATIVE_PATH);

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log(`No devcontainer.json found at ${filePath}; skipping containerEnv.`);
    return { loaded: false, reason: 'missing-file' };
  }

  let parsed;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    warn(`::warning::Failed to parse ${filePath} as JSONC (${err.message}); skipping containerEnv.`);
    return { loaded: false, reason: 'parse-error' };
  }

  const containerEnv = parsed && parsed.containerEnv;
  if (containerEnv === undefined || containerEnv === null) {
    log(`No containerEnv in ${filePath}; nothing to load.`);
    return { loaded: false, reason: 'no-container-env' };
  }

  if (typeof containerEnv !== 'object' || Array.isArray(containerEnv)) {
    warn(`::warning::Unsupported containerEnv shape in ${filePath} (expected a flat string map); skipping.`);
    return { loaded: false, reason: 'unsupported-shape' };
  }

  const { resolved, skipped } = resolveContainerEnv(containerEnv, targetDir);

  for (const item of skipped) {
    if (item.reason === 'unsupported-variable') {
      warn(
        `::warning::containerEnv.${item.key} references unsupported variable(s) ${item.unsupported.join(', ')} ` +
          '— these are host-side devcontainer concepts with no meaning in this container; skipping.'
      );
    } else {
      warn(`::warning::containerEnv.${item.key} is not a string; skipping.`);
    }
  }

  const keys = Object.keys(resolved);
  if (keys.length === 0) {
    return { loaded: true, ok: skipped.length === 0, keys: [] };
  }

  const envFile = githubEnvPath || process.env.GITHUB_ENV;
  if (!envFile) {
    warn('::warning::GITHUB_ENV is not set; cannot export containerEnv variables.');
    return { loaded: true, ok: false, keys: [] };
  }

  appendToGithubEnv(resolved, envFile);
  log(`Loaded containerEnv vars into GITHUB_ENV: ${keys.join(', ')}`);
  return { loaded: true, ok: skipped.length === 0, keys };
}

module.exports = {
  resolveContainerEnv,
  appendToGithubEnv,
  run,
};

if (require.main === module) {
  const targetDir = process.env.TARGET_DIR;
  if (!targetDir) {
    console.warn('::warning::TARGET_DIR is not set; skipping devcontainer containerEnv.');
    process.exit(0);
  }
  try {
    run({ targetDir });
  } catch (err) {
    console.warn(`::warning::Unexpected error loading devcontainer containerEnv: ${err.message}`);
  }
  process.exit(0);
}
