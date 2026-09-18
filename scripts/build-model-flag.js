// Model IDs are unrestricted free text from an issue/PR comment (`model=...`
// in parse-trigger.js), but every real model ID (see the PR description for
// the current list) is alphanumeric plus dots/underscores/hyphens. Anything
// outside that shape is rejected rather than risking it reaching a shell
// command string.
const MODEL_ALLOWLIST_PATTERN = /^[a-zA-Z0-9._-]+$/;

// Shared allowlist-and-shell-variable-indirection logic behind both
// buildModelFlag (claude) and buildCodexModelFlag (codex) below. Never
// returns the raw model value for interpolation into a command string —
// callers get back a flag that references a shell variable (`$MODEL`),
// which the caller is responsible for populating from a file (mirroring
// how `$PROMPT` is threaded through /tmp/prompt.txt) rather than baking
// the value into the command literal.
function resolveModelFlag(model, { flag, defaultDescription }) {
  const trimmed = typeof model === 'string' ? model.trim() : '';

  if (!trimmed || trimmed === 'default') {
    return { valid: false, flag: '', warning: null };
  }

  if (!MODEL_ALLOWLIST_PATTERN.test(trimmed)) {
    return {
      valid: false,
      flag: '',
      warning: `::warning::Ignoring model="${trimmed}" — must match ${MODEL_ALLOWLIST_PATTERN}; proceeding with ${defaultDescription}.`,
    };
  }

  return { valid: true, flag, warning: null };
}

// Decides whether/how to add `--model` to the generated `claude -p ...`
// invocation in dispatcher.yml.
function buildModelFlag(model) {
  return resolveModelFlag(model, { flag: '--model "$MODEL"', defaultDescription: "the CLI's default model" });
}

// Decides whether/how to add a `-c model=...` override to the generated
// `codex exec ...` invocation in dispatcher.yml. The flag text uses the same
// backslash-escaped-quote shape as the hardcoded default codex model flag
// (`-c model=\"gpt-5.6-sol\"`) so the value reaches codex as an explicit TOML
// string (`-c` values are TOML-parsed) rather than relying on codex's
// undocumented-for-our-purposes "falls back to a raw string on TOML parse
// failure" behavior. $MODEL is expanded unquoted here (not inside the
// escaped quotes), which is only safe because MODEL_ALLOWLIST_PATTERN
// already excludes whitespace and glob metacharacters.
function buildCodexModelFlag(model) {
  return resolveModelFlag(model, { flag: '-c model=\\"$MODEL\\"', defaultDescription: 'the default codex model' });
}

module.exports = { buildModelFlag, buildCodexModelFlag, MODEL_ALLOWLIST_PATTERN };
