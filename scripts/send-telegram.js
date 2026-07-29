const fs = require('fs');

async function sendTelegramMessage() {
  const botToken = process.env.TG_BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
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

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: messageText,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Telegram send failed (${res.status}):`, errText);
    process.exit(1);
  }

  console.log('Telegram message sent successfully.');
}

sendTelegramMessage().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
