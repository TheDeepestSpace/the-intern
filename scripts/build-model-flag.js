// Model IDs are unrestricted free text from an issue/PR comment (`model=...`
// in parse-trigger.js), but every real model ID (see the PR description for
// the current list) is alphanumeric plus dots/underscores/hyphens. Anything
// outside that shape is rejected rather than risking it reaching a shell
// command string.
const MODEL_ALLOWLIST_PATTERN = /^[a-zA-Z0-9._-]+$/;

// Decides whether/how to add `--model` to the generated `claude -p ...`
// invocation in dispatcher.yml. Never returns the raw model value for
// interpolation into a command string — callers get back a flag that
// references a shell variable (`$MODEL`), which the caller is responsible
// for populating from a file (mirroring how `$PROMPT` is threaded through
// /tmp/prompt.txt) rather than baking the value into the command literal.
function buildModelFlag(model) {
  const trimmed = typeof model === 'string' ? model.trim() : '';

  if (!trimmed || trimmed === 'default') {
    return { valid: false, flag: '', warning: null };
  }

  if (!MODEL_ALLOWLIST_PATTERN.test(trimmed)) {
    return {
      valid: false,
      flag: '',
      warning: `::warning::Ignoring model="${trimmed}" — must match ${MODEL_ALLOWLIST_PATTERN}; proceeding with the CLI's default model.`,
    };
  }

  return { valid: true, flag: '--model "$MODEL"', warning: null };
}

module.exports = { buildModelFlag, MODEL_ALLOWLIST_PATTERN };
