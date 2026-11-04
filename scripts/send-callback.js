const fs = require('fs');
const { getInstallationToken, getPrivateKey } = require('./mint-installation-token.js');

// Fires the callback requested through dispatch_agent: a workflow_dispatch of
// `callback.workflow` on `callback.repo` (both allowlisted by resolve-agent.js
// and read back from agent.json, which the detect-image job wrote) with small
// string inputs: status, run_url, pr, issue, branch, head_sha, context. Runs
// with `if: always()` so failure and cancellation are reported too.
//
// The payload is a hint: pr/branch/head_sha are looked up best-effort and may
// be empty; receivers must re-read GitHub state. Dispatched with the app's
// token (Actions: write on the callback repo), so the-intern itself is never
// re-triggered by it.
//
// Env: AGENT_FILE, RUN_RESULT (needs.handle.result), RUN_URL, APP_ID,
// APP_PRIVATE_KEY, DISPATCH_REF (optional; default: callback repo default branch).
const STATUSES = { success: 'success', cancelled: 'cancelled' };

function statusFrom(result) {
  // failure, skipped (the run never started) and anything unknown are failures.
  return STATUSES[result] || 'failure';
}

async function gh(url, token, init = {}) {
  const res = await fetch(`https://api.github.com${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-intern-bot',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

// Best effort: the PR the run worked on. `pr` given -> that PR; otherwise the
// newest PR by the bot in the target repo that references the issue.
async function findPr({ repo, pr, issue, botLogin }, token) {
  if (pr) return (await (await gh(`/repos/${repo}/pulls/${pr}`, token)).json());
  if (!issue) return null;
  const list = await (await gh(`/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=30`, token)).json();
  const ref = new RegExp(`(?:^|[^\\w])#${issue}(?!\\d)`);
  return list.find((p) => (p.user?.login || '').toLowerCase() === botLogin.toLowerCase() && ref.test(`${p.title}\n${p.body || ''}`)) || null;
}

async function sendCallback(env = process.env, { mint = getInstallationToken, findPrFn = findPr } = {}) {
  const agent = JSON.parse(fs.readFileSync(env.AGENT_FILE, 'utf8'));
  const d = agent.dispatch;
  if (!d || !d.callback) {
    console.log('No callback requested.');
    return null;
  }
  const appId = env.APP_ID;
  const privateKey = getPrivateKey(env);

  let pr = null;
  // Repo and issue/PR are optional in the request; without them there is nothing to look up.
  if (d.repo && (d.pr || d.issue)) try {
    const readToken = await mint({
      appId, privateKey,
      access: [{ repo: d.repo, scope: 'read' }],
      permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' },
    });
    pr = await findPrFn({ repo: d.repo, pr: d.pr, issue: d.issue, botLogin: agent.bot_login || '' }, readToken);
  } catch (e) {
    console.error(`::warning::send-callback: could not look up the PR (${e.message}); sending without it`);
  }

  const inputs = {
    status: statusFrom(env.RUN_RESULT),
    run_url: env.RUN_URL || '',
    pr: String(pr?.number ?? d.pr ?? ''),
    issue: String(d.issue ?? ''),
    branch: pr?.head?.ref || '',
    head_sha: pr?.head?.sha || '',
    context: JSON.stringify(d.context || {}),
  };

  const token = await mint({
    appId, privateKey,
    access: [{ repo: d.callback.repo, scope: 'read/write' }],
    permissions: { actions: 'write', metadata: 'read' },
  });
  let ref = env.DISPATCH_REF;
  if (!ref) ref = (await (await gh(`/repos/${d.callback.repo}`, token)).json()).default_branch;
  await gh(`/repos/${d.callback.repo}/actions/workflows/${d.callback.workflow}/dispatches`, token, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });
  console.log(`Callback ${d.callback.repo}/${d.callback.workflow}@${ref}: status=${inputs.status} pr=${inputs.pr || '-'}`);
  return inputs;
}

if (require.main === module) {
  sendCallback().catch((err) => {
    console.error(`::error::send-callback: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { sendCallback, statusFrom, findPr };
