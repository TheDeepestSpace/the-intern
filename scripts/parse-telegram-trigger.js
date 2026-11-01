const fs = require('fs');

function parseTelegramTrigger() {
  const rawPayloadPath = process.env.GITHUB_EVENT_PATH;

  let text = '';
  if (rawPayloadPath && fs.existsSync(rawPayloadPath)) {
    const raw = JSON.parse(fs.readFileSync(rawPayloadPath, 'utf8'));
    text = raw.client_payload?.text || '';
  }

  // Parse backend/model/effort parameters from the message if present, mirroring
  // parse-trigger.js's key=value convention for the GH-comment trigger path.
  let backend = 'claude';
  const matchBackend = text.match(/\bbackend=([^\s]+)/i);
  if (matchBackend) backend = matchBackend[1];

  const cleanText = text
    .replace(/\bbackend=([^\s]+)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const result = {
    backend,
    clean_text: cleanText,
  };

  // clean_text is raw Telegram message content and must never be logged here:
  // this step's stdout streams straight to the public Actions log (unlike the
  // `respond` job, which redirects into $LOG_FILE), so an unredacted dump
  // would leak that content to anyone with read access to the run (issue #226
  // follow-up). ::add-mask:: isn't a substitute here — GitHub Actions can't
  // mask a value containing newlines, and arbitrary message text routinely
  // does.
  const { clean_text, ...loggableResult } = result;
  console.log('Parsed Telegram trigger:', JSON.stringify(loggableResult, null, 2));

  // Written to a file rather than a step `env:` key (issue #226) — a step-level
  // `env:` mapping referencing this content gets auto-echoed by the Actions
  // runner as plaintext before the step's script ever runs, regardless of any
  // stdout/stderr redirect the script itself does.
  if (process.env.CLEAN_TEXT_FILE) {
    fs.writeFileSync(process.env.CLEAN_TEXT_FILE, result.clean_text, 'utf8');
  }

  if (process.env.GITHUB_OUTPUT) {
    for (const [k, v] of Object.entries(result)) {
      if (typeof v === 'string' && v.includes('\n')) {
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
  parseTelegramTrigger();
}

module.exports = { parseTelegramTrigger };
