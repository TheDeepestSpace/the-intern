// Sends a Telegram message to the admin chat whenever a dispatch/telegram
// workflow run fails, regardless of who or what triggered that run — the
// owner's Telegram chat is a fixed destination we can always reach, unlike
// a GitHub thread tied to whatever triggered this specific run.
const path = require('path');
const { execFileSync } = require('child_process');

function main() {
  const workflowName = process.env.WORKFLOW_NAME || 'workflow';
  const repo = process.env.REPO || '';
  const runUrl = process.env.RUN_URL;
  const failedJobs = (process.env.FAILED_JOBS || '').trim().replace(/\s+/g, ', ') || 'unknown job';
  const targetRepo = process.env.TARGET_REPO || '';
  const issueNumber = process.env.ISSUE_NUMBER || '';

  if (!runUrl) {
    console.error('Error: RUN_URL environment variable is required.');
    process.exit(1);
  }

  const context = targetRepo
    ? `${targetRepo}${issueNumber ? `#${issueNumber}` : ''}`
    : 'unknown (failed before trigger was parsed)';

  const messageText = [
    `⚠️ ${repo} — ${workflowName} workflow failed`,
    '',
    `Failed job(s): ${failedJobs}`,
    `Triggered by: ${context}`,
    `Run: ${runUrl}`,
  ].join('\n');

  execFileSync(process.execPath, [path.join(__dirname, 'send-telegram.js'), messageText], {
    stdio: 'inherit',
    env: { ...process.env, CHAT_ID: process.env.TG_ADMIN_CHAT_ID },
  });
}

main();
