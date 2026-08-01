const fs = require('fs');

async function downloadTelegramPhoto() {
  const botToken = process.env.TG_BOT_TOKEN;
  const fileId = process.env.PHOTO_FILE_ID;
  const outputPath = process.env.OUTPUT_PATH || process.argv[2];

  if (!botToken || !fileId) {
    console.error('Error: TG_BOT_TOKEN and PHOTO_FILE_ID environment variables are required.');
    process.exit(1);
  }

  if (!outputPath) {
    console.error('Error: No output path provided via OUTPUT_PATH or argument.');
    process.exit(1);
  }

  const getFileRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );

  if (!getFileRes.ok) {
    const errText = await getFileRes.text();
    console.error(`Telegram getFile failed (${getFileRes.status}):`, errText);
    process.exit(1);
  }

  const getFileData = await getFileRes.json();
  const filePath = getFileData.result?.file_path;
  if (!filePath) {
    console.error('Telegram getFile response missing file_path:', JSON.stringify(getFileData));
    process.exit(1);
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!fileRes.ok) {
    const errText = await fileRes.text();
    console.error(`Telegram file download failed (${fileRes.status}):`, errText);
    process.exit(1);
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  console.log(`Telegram photo downloaded to ${outputPath}`);
}

downloadTelegramPhoto().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
