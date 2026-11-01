// Delivers the nightly-crawl report to the owner (issue #257). GitHub Apps
// and Actions have no API for sending arbitrary email, so this goes through
// a transactional provider: Resend's HTTP API when RESEND_API_KEY is set.
// When it isn't (or the send fails), the fallback is an issue on
// the-intern-data that @-mentions the owner — GitHub's own notification
// system then emails them — plus the Telegram admin chat, which the driver
// sends regardless.
//
// Required for email: RESEND_API_KEY, REPORT_EMAIL_TO. Optional:
// REPORT_EMAIL_FROM (defaults to Resend's shared onboarding sender, which
// only delivers to the account's own verified address — set a verified
// domain sender for anything else).
const RESEND_URL = 'https://api.resend.com/emails';
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_FROM = 'the-intern <onboarding@resend.dev>';

function emailConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY && env.REPORT_EMAIL_TO);
}

async function sendEmail({ subject, text, html }, env = process.env, fetchImpl = fetch) {
  if (!emailConfigured(env)) {
    throw new Error('email not configured: RESEND_API_KEY and REPORT_EMAIL_TO are required');
  }
  const to = env.REPORT_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetchImpl(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'the-intern-bot-nightly-crawl',
    },
    body: JSON.stringify({ from: env.REPORT_EMAIL_FROM || DEFAULT_FROM, to, subject, text, html }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json().catch(() => ({}));
  return { id: data.id || null };
}

// Zero-infra fallback (b): an issue in the data repo mentioning the owner.
// Needs DATA_REPO_TOKEN to carry `issues: write` on the-intern-data.
async function postReportIssue({ subject, text }, env = process.env, fetchImpl = fetch) {
  const repo = env.DATA_REPO || 'TheDeepestSpace/the-intern-data';
  const token = env.DATA_REPO_TOKEN;
  if (!token) throw new Error('DATA_REPO_TOKEN is required to post the report as an issue');
  const mention = env.REPORT_MENTION || 'TheDeepestSpace';
  const body = `@${mention}\n\n\`\`\`\n${text}\n\`\`\``;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'the-intern-bot-nightly-crawl',
    },
    body: JSON.stringify({ title: subject, body, labels: ['nightly-crawl'] }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Report issue creation failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return { url: data.html_url || null };
}

module.exports = { emailConfigured, sendEmail, postReportIssue, RESEND_URL, DEFAULT_FROM };
