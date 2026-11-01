const fs = require('fs');

// Parses a `specage_push` repository_dispatch: client_payload carries the
// project repo, its App installation id and the instruction text directly —
// no issue/PR is attached, so there's nothing to restore or key per-issue.
function parseSpecageTrigger() {
  const rawPayloadPath = process.env.GITHUB_EVENT_PATH;

  let payload = {};
  if (rawPayloadPath && fs.existsSync(rawPayloadPath)) {
    payload = JSON.parse(fs.readFileSync(rawPayloadPath, 'utf8')).client_payload || {};
  }

  const text = String(payload.text || '');
  let backend = 'claude';
  let model = 'default';
  const matchBackend = text.match(/\bbackend=([^\s]+)/i);
  if (matchBackend) backend = matchBackend[1];
  const matchModel = text.match(/\bmodel=([^\s]+)/i);
  if (matchModel) model = matchModel[1];

  const cleanText = text
    .replace(/\b(?:backend|model)=([^\s]+)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const result = {
    target_repo: String(payload.target_repo || ''),
    installation_id: String(payload.installation_id || ''),
    backend,
    model,
    clean_prompt: cleanText,
  };

  // clean_prompt must never be logged: this step's stdout streams to the
  // public Actions log (issue #226 follow-up).
  const { clean_prompt, ...loggableResult } = result;
  console.log('Parsed specage trigger:', JSON.stringify(loggableResult, null, 2));

  // File rather than a step `env:` key — see parse-trigger.js (issue #226).
  if (process.env.CLEAN_PROMPT_FILE) {
    fs.writeFileSync(process.env.CLEAN_PROMPT_FILE, result.clean_prompt, 'utf8');
  }

  if (process.env.GITHUB_OUTPUT) {
    for (const [k, v] of Object.entries(result)) {
      if (v.includes('\n')) {
        const delimiter = `EOF_${Math.random().toString(36).substring(2, 10)}`;
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}<<${delimiter}\n${v}\n${delimiter}\n`);
      } else {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
      }
    }
  }

  return result;
}

if (require.main === module) {
  parseSpecageTrigger();
}

module.exports = { parseSpecageTrigger };
