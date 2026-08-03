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

  console.log('Parsed Telegram trigger:', JSON.stringify(result, null, 2));

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
