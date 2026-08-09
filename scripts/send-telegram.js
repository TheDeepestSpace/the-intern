const fs = require('fs');

const RESERVED_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapePlain(text) {
  return text.replace(RESERVED_CHARS, '\\$&');
}

function escapeCodeContent(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

// Converts the small subset of Markdown Claude actually emits (**bold**,
// `code`, ```code blocks```, [text](url)) into Telegram MarkdownV2, escaping
// everything else so stray punctuation (periods, hyphens, underscores in
// snake_case, etc.) doesn't get misread as formatting.
function toTelegramMarkdownV2(text) {
  const tokenPattern = /```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\([^)\s]+\)/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    result += escapePlain(text.slice(lastIndex, match.index));
    result += convertToken(match[0]);
    lastIndex = match.index + match[0].length;
  }
  result += escapePlain(text.slice(lastIndex));
  return result;
}

function convertToken(token) {
  if (token.startsWith('```')) {
    return '```' + escapeCodeContent(token.slice(3, -3)) + '```';
  }
  if (token.startsWith('`')) {
    return '`' + escapeCodeContent(token.slice(1, -1)) + '`';
  }
  if (token.startsWith('**')) {
    return '*' + escapePlain(token.slice(2, -2)) + '*';
  }
  const linkMatch = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
  const [, linkText, url] = linkMatch;
  const escapedUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
  return '[' + escapePlain(linkText) + '](' + escapedUrl + ')';
}

async function postToTelegram(botToken, payload) {
  return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendTelegramMessage() {
  const botToken = process.env.TG_BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  const replyToMessageId = process.env.REPLY_TO_MESSAGE_ID;
  let messageText = process.env.MESSAGE_TEXT || process.argv[2];

  if (!botToken || !chatId) {
    console.error('Error: TG_BOT_TOKEN and CHAT_ID environment variables are required.');
    process.exit(1);
  }

  // If input is piped or passed via file
  if (!messageText && !process.stdin.isTTY) {
    messageText = fs.readFileSync(0, 'utf-8').trim();
  }

  if (!messageText) {
    console.error('Error: No message text provided via MESSAGE_TEXT, argument, or stdin.');
    process.exit(1);
  }

  let replyParameters;
  if (replyToMessageId) {
    // allow_sending_without_reply falls back to a plain send if the original
    // message was deleted mid-session, instead of failing the whole request.
    replyParameters = {
      message_id: Number(replyToMessageId),
      allow_sending_without_reply: true,
    };
  }

  const payload = {
    chat_id: chatId,
    text: toTelegramMarkdownV2(messageText),
    parse_mode: 'MarkdownV2',
  };
  if (replyParameters) {
    payload.reply_parameters = replyParameters;
  }

  const res = await postToTelegram(botToken, payload);

  if (!res.ok) {
    const errText = await res.text();

    if (res.status === 400 && /can't parse entities/i.test(errText)) {
      // Converter missed an edge case — fall back to a plain send rather
      // than dropping the message.
      const plainPayload = { chat_id: chatId, text: messageText };
      if (replyParameters) {
        plainPayload.reply_parameters = replyParameters;
      }
      const plainRes = await postToTelegram(botToken, plainPayload);
      if (plainRes.ok) {
        console.log('Telegram message sent successfully (plain fallback).');
        return;
      }
      const plainErrText = await plainRes.text();
      console.error(`Telegram send failed (${plainRes.status}):`, plainErrText);
      process.exit(1);
    }

    console.error(`Telegram send failed (${res.status}):`, errText);
    process.exit(1);
  }

  console.log('Telegram message sent successfully.');
}

sendTelegramMessage().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
