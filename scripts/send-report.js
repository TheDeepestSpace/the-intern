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

// Neutralizes user/LLM-derived text so it renders literally in a GitHub
// comment: no mentions, HTML, autolinks, or markdown formatting.
function escapeMd(str) {
  return String(str)
    .replace(/[\\`*_{}\[\]()<>#+!|~&"]/g, '\\$&')
    .replace(/@/g, '@\u200b')
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/\s*\n\s*/g, ' ');
}

const URL_RE = /^https?:\/\/[^\s<>()]+$/;

// Converts the plain-text report (report.txt format, shared with other
// consumers) into regular Markdown for the GitHub comment. The subject line
// is dropped (the comment header already carries it).
function reportToMarkdown(text) {
  const lines = String(text).replace(/\n+$/, '').split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    let m;
    if ((m = line.match(/^Run: (\S+)$/)) && URL_RE.test(m[1])) {
      out.push('', `Run: [${m[1]}](${m[1]})`);
    } else if ((m = line.match(/^ {4}• (.*)$/))) {
      out.push(`  - ${escapeMd(m[1])}`);
    } else if ((m = line.match(/^- (.*)$/))) {
      let rest = m[1];
      let url = null;
      const k = rest.match(/^([\w.-]+\/[\w.-]+)#(\d+)(.*)$/s);
      // Keyed PR entries swallow every continuation URL line (a multiline
      // summary may inject extra ones) but never link to them.
      while (lines[i + 1] && /^ {2}\S/.test(lines[i + 1]) && URL_RE.test(lines[i + 1].trim())) {
        if (!url) url = lines[i + 1].trim();
        i++;
        if (!k) break;
      }
      if (k) {
        const label = `${k[1]}#${k[2]}`;
        const href = `https://github.com/${k[1]}/pull/${k[2]}`;
        out.push(`- [${escapeMd(label)}](${href})${escapeMd(k[3])}`);
      } else {
        out.push(`- ${escapeMd(rest)}${url ? ` ([link](${url}))` : ''}`);
      }
    } else {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`### ${escapeMd(line)}`, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function postReportComment({ subject, text }, env = process.env, fetchImpl = fetch) {
  if (!env.REPORT_TOKEN) throw new Error('REPORT_TOKEN is required to post the report');
  const repo = env.REPORT_REPO || 'TheDeepestSpace/the-intern';
  const mention = env.REPORT_MENTION || 'TheDeepestSpace';
  const number = await findOrCreateIssue(repo, env, fetchImpl);
  const body = `@${mention} **${escapeMd(subject)}**\n\n${reportToMarkdown(text)}`;
  const data = await gh(`/repos/${repo}/issues/${number}/comments`, env, fetchImpl, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return { url: data.html_url || null };
}

module.exports = { postReportComment, reportToMarkdown, escapeMd, ISSUE_TITLE };
