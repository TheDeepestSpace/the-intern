const fs = require('fs');

// Fetches an agent's `prompt_file` (agentic.yaml) from GitHub and writes it to
// OUT_FILE. The ref is resolved to a commit sha first — the pinned ref when
// the agent gives one, otherwise the repo's default branch — and that sha is
// logged and emitted as the `prompt_sha` output so a run can always be traced
// back to the exact prompt it ran with. Any failure exits non-zero: an agent
// never runs with a missing or partial prompt.
//
// Env: PROMPT_REPO (owner/repo), PROMPT_PATH, PROMPT_REF (optional), GH_TOKEN
// (must be able to read PROMPT_REPO), OUT_FILE.
async function gh(url, token, accept = 'application/vnd.github+json') {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, 'User-Agent': 'the-intern-bot' },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function fetchPromptFile({ repo, path, ref, token }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error(`PROMPT_REPO '${repo}' is not owner/repo`);
  if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`PROMPT_PATH '${path}' is not a relative path`);
  if (!token) throw new Error('GH_TOKEN is required');
  let at = ref;
  if (!at) {
    const info = await (await gh(`https://api.github.com/repos/${repo}`, token)).json();
    at = info.default_branch;
    if (!at) throw new Error(`could not determine the default branch of ${repo}`);
  }
  const commit = await (await gh(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(at)}`, token)).json();
  const sha = commit.sha;
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error(`could not resolve ${repo}@${at} to a commit`);
  const text = await (await gh(
    `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
    token,
    'application/vnd.github.raw+json'
  )).text();
  if (!text.trim()) throw new Error(`${repo}/${path}@${sha} is empty`);
  return { text, sha, ref: at };
}

async function main(env = process.env) {
  const { text, sha, ref } = await fetchPromptFile({
    repo: env.PROMPT_REPO, path: env.PROMPT_PATH, ref: env.PROMPT_REF || '', token: env.GH_TOKEN,
  });
  fs.writeFileSync(env.OUT_FILE || 'prompt_file.txt', text, 'utf8');
  console.log(`Prompt file ${env.PROMPT_REPO}/${env.PROMPT_PATH} @ ${sha} (${env.PROMPT_REF ? 'pinned ref' : 'default branch'} ${ref}), ${text.length} chars`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `prompt_sha=${sha}\n`);
  // Visible on the run page, so a dispatched run can be traced to the exact prompt.
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Prompt \`${env.PROMPT_REPO}/${env.PROMPT_PATH}\` resolved from \`${ref}\` to \`${sha}\`\n`);
  return sha;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`::error::fetch-prompt-file: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { fetchPromptFile, main };
