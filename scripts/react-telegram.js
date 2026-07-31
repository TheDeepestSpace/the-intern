async function reactTelegramMessage() {
  const botToken = process.env.TG_BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  const messageId = process.env.MESSAGE_ID || process.env.REPLY_TO_MESSAGE_ID;
  const reactionEmoji = process.env.REACTION_EMOJI || '👀';

  if (!botToken || !chatId || !messageId) {
    console.error('Skipping reaction: TG_BOT_TOKEN, CHAT_ID, and MESSAGE_ID (or REPLY_TO_MESSAGE_ID) are required.');
    process.exit(0);
  }

  const payload = {
    chat_id: chatId,
    message_id: Number(messageId),
    reaction: [{ type: 'emoji', emoji: reactionEmoji }],
  };

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Telegram reaction failed (${res.status}):`, errText);
      process.exit(0);
    }

    console.log('Telegram reaction sent successfully.');
  } catch (err) {
    console.error('Telegram reaction failed:', err.message);
    process.exit(0);
  }
}

reactTelegramMessage();
