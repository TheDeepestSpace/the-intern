// Opens an issue in this repo (agent-infra) mentioning + assigning a fixed
// GitHub user so they get emailed whenever a dispatch/telegram workflow run
// fails — regardless of who or what triggered that run. GitHub has no direct
// "send email" API; a mention/assignment notification is the closest native
// equivalent and is delivered by email regardless of repo-watch settings.
const https = require('https');

function apiRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'the-intern-bot-notify-failure',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : {});
          } else {
            reject(new Error(`GitHub API ${method} ${path} failed (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const token = process.env.GH_TOKEN;
  const repo = process.env.REPO;
  const notifyUser = process.env.NOTIFY_GITHUB_USER || 'TheDeepestSpace';
  const workflowName = process.env.WORKFLOW_NAME || 'workflow';
  const runUrl = process.env.RUN_URL;
  const failedJobs = (process.env.FAILED_JOBS || '').trim().replace(/\s+/g, ', ') || 'unknown job';
  const targetRepo = process.env.TARGET_REPO || '';
  const issueNumber = process.env.ISSUE_NUMBER || '';

  if (!token || !repo || !runUrl) {
    console.error('Error: GH_TOKEN, REPO, and RUN_URL environment variables are required.');
    process.exit(1);
  }

  const context = targetRepo
    ? `${targetRepo}${issueNumber ? `#${issueNumber}` : ''}`
    : 'unknown (failed before trigger was parsed)';

  const title = `⚠️ ${workflowName} failure: ${failedJobs}`;
  const body = [
    `@${notifyUser} the **${workflowName}** workflow failed.`,
    '',
    `- Failed job(s): ${failedJobs}`,
    `- Triggered by: ${context}`,
    `- Run: ${runUrl}`,
  ].join('\n');

  await apiRequest('POST', `/repos/${repo}/issues`, token, {
    title,
    body,
    assignees: [notifyUser],
  });

  console.log('Failure notification issue created.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
