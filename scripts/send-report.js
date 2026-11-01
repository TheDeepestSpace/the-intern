// Delivers the nightly-crawl report to the owner (issue #257). GitHub Apps
// and Actions have no API for sending arbitrary email, so the report is
// posted as a comment on one static, open "Nightly crawl reports" issue in
// this repo that @-mentions the owner — GitHub's own notification system
// then emails them. No third-party services. The issue is created on first
// use (and re-created if someone closes it); the Telegram admin chat is
// pinged separately by the driver.
//
// Needs REPORT_TOKEN with `issues: write` on REPORT_REPO (the workflow's
// GITHUB_TOKEN works). Optional: REPORT_MENTION (default TheDeepestSpace).
const FETCH_TIMEOUT_MS = 30_000;
const ISSUE_TITLE = 'Nightly crawl reports';
const ISSUE_BODY = 'Static issue: the nightly crawl posts its report here as a comment so the owner gets a notification email. Keep it open.';

async function gh(path, env, fetchImpl, init = {}) {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.REPORT_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'the-intern-bot-nightly-crawl',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub ${init.method || 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function findOrCreateIssue(repo, env, fetchImpl) {
  for (let page = 1; page <= 10; page++) {
    const issues = await gh(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`, env, fetchImpl);
    const hit = issues.find((i) => !i.pull_request && i.title === ISSUE_TITLE);
    if (hit) return hit.number;
    if (issues.length < 100) break;
  }
  const created = await gh(`/repos/${repo}/issues`, env, fetchImpl, {
    method: 'POST',
    body: JSON.stringify({ title: ISSUE_TITLE, body: ISSUE_BODY }),
  });
  return created.number;
}

async function postReportComment({ subject, text }, env = process.env, fetchImpl = fetch) {
  if (!env.REPORT_TOKEN) throw new Error('REPORT_TOKEN is required to post the report');
  const repo = env.REPORT_REPO || 'TheDeepestSpace/the-intern';
  const mention = env.REPORT_MENTION || 'TheDeepestSpace';
  const number = await findOrCreateIssue(repo, env, fetchImpl);
  const body = `@${mention} **${subject}**\n\n\`\`\`\n${text}\n\`\`\``;
  const data = await gh(`/repos/${repo}/issues/${number}/comments`, env, fetchImpl, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return { url: data.html_url || null };
}

module.exports = { postReportComment, ISSUE_TITLE };
