// Nightly maintenance (issue #161): the-intern-data accumulates two branches
// per dispatched issue/PR forever — summaries/<repo-slug>/<n> (written by
// manage-summaries.js) and workspace/<repo-slug>/<n> (written by
// manage-workspace-backup.js) — and nothing ever prunes them. Once the PR
// they were scaffolding is merged, that state has no further purpose: an
// open or closed-but-unmerged PR (or a plain tracking issue, which never had
// branches worth touching) may still be re-dispatched and needs its
// resumable summary/workspace state, so only merged PRs are safe to clean up.
const { execSync } = require('child_process');
const { resolveDataRepoRemoteUrl, redactUrl } = require('./data-repo-remote.js');
const { getInstallationToken, getPrivateKey } = require('./mint-installation-token.js');

// The org owning every target repo the-intern dispatches into. slugToOwnerRepo
// strips this exact, known string as a literal prefix rather than splitting
// the slug on its first hyphen, so recovery stays unambiguous regardless of
// hyphens in either the org or repo name — don't swap in a hyphen-split
// shortcut, that's what would actually break if TARGET_ORG ever gets one.
const TARGET_ORG = 'TheDeepestSpace';
const BRANCH_KINDS = ['summaries', 'workspace'];
const FETCH_TIMEOUT_MS = 30_000;

function runGit(cmd, options = {}) {
  const { allowFailure = false, ...execOptions } = options;
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', ...execOptions }).trim();
  } catch (err) {
    if (allowFailure) return '';
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${redactUrl(cmd)} failed: ${redactUrl(detail)}`);
  }
}

function ensureSafeDirectory(dir = process.cwd()) {
  runGit(`config --global --add safe.directory "${dir}"`, { allowFailure: true });
}

function slugToOwnerRepo(slug, org = TARGET_ORG) {
  const prefix = `${org}-`;
  if (!slug.startsWith(prefix)) return null;
  const repo = slug.slice(prefix.length);
  if (!repo) return null;
  return `${org}/${repo}`;
}

// Parses `git ls-remote --heads` output into per-(repo, issue#) groups,
// picking out only the summaries/ and workspace/ branches those two scripts
// manage, and dropping any slug that can't be mapped back to an owner/repo
// (left untouched rather than guessed at).
function parseCandidates(lsRemoteOutput, org = TARGET_ORG) {
  const candidates = new Map();
  const skippedSlugs = new Set();

  for (const line of lsRemoteOutput.split('\n')) {
    const match = line.match(/refs\/heads\/(summaries|workspace)\/(.+)\/([^/]+)$/);
    if (!match) continue;
    const [, kind, slug, issueNumber] = match;

    const targetRepo = slugToOwnerRepo(slug, org);
    if (!targetRepo) {
      skippedSlugs.add(slug);
      continue;
    }

    const key = `${targetRepo}#${issueNumber}`;
    const entry = candidates.get(key) || { targetRepo, issueNumber, branches: {} };
    entry.branches[kind] = `${kind}/${slug}/${issueNumber}`;
    candidates.set(key, entry);
  }

  return { candidates: [...candidates.values()], skippedSlugs: [...skippedSlugs] };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'the-intern-bot-cleanup-data-branches',
  };
}

// A 404 means this issue number was never a PR (or the PR/repo is gone) —
// that's a normal skip, not an error, per issue #161. Any other non-2xx is a
// real problem the caller should surface instead of silently treating as
// "not merged".
async function isMergedPr(targetRepo, issueNumber, token, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${targetRepo}/pulls/${issueNumber}`, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`GitHub API error checking ${targetRepo}#${issueNumber} (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.merged === true;
}

// Returns true if the branch was actually deleted, false if it was already
// gone (e.g. deleted by a concurrent run) — both are success outcomes; only a
// genuine push failure throws.
function deleteBranch(remoteUrl, branchName) {
  try {
    runGit(`push ${remoteUrl} :${branchName}`);
    return true;
  } catch (err) {
    if (/remote ref does not exist/i.test(err.message)) return false;
    throw err;
  }
}

// One installation token per target repo, minted lazily and reused across
// every issue# found for that repo — a repo with several stale branch groups
// shouldn't mint a fresh token per issue. Caches a mint failure too (as
// null) so a repo whose installation is gone (deleted/renamed/uninstalled)
// isn't retried for every candidate that references it.
async function getTokenForRepo(targetRepo, env, cache, mintFn = getInstallationToken) {
  if (cache.has(targetRepo)) return cache.get(targetRepo);
  let token = null;
  try {
    token = await mintFn({
      appId: env.APP_ID,
      privateKey: getPrivateKey(env),
      targetRepo,
      permissions: { pull_requests: 'read' },
    });
  } catch (err) {
    console.warn(`::warning::Could not mint an installation token for ${targetRepo}, leaving its branches untouched: ${err.message}`);
  }
  cache.set(targetRepo, token);
  return token;
}

async function main(env = process.env, deps = {}) {
  const {
    isMergedPrFn = isMergedPr,
    deleteBranchFn = deleteBranch,
    getTokenForRepoFn = getTokenForRepo,
  } = deps;

  let remoteUrl;
  try {
    remoteUrl = await resolveDataRepoRemoteUrl();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!remoteUrl) {
    console.error('::error::the-intern-data remote is not configured (DATA_REPO_TOKEN or DATA_REPO_REMOTE_URL); cannot clean up.');
    process.exitCode = 1;
    return;
  }
  if (!env.APP_ID || !getPrivateKey(env)) {
    console.error('::error::APP_ID/APP_PRIVATE_KEY secrets are required to check PR merge state.');
    process.exitCode = 1;
    return;
  }

  ensureSafeDirectory();

  let lsRemoteOutput;
  try {
    lsRemoteOutput = runGit(`ls-remote --heads ${remoteUrl}`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { candidates, skippedSlugs } = parseCandidates(lsRemoteOutput);
  if (skippedSlugs.length > 0) {
    console.warn(`::warning::Could not recover owner/repo for ${skippedSlugs.length} branch slug(s), left untouched: ${skippedSlugs.join(', ')}`);
  }
  console.log(`Found ${candidates.length} summaries/workspace branch group(s) across ${new Set(candidates.map((c) => c.targetRepo)).size} repo(s).`);

  const tokenCache = new Map();
  let deletedBranchCount = 0;
  let mergedPrCount = 0;

  for (const candidate of candidates) {
    const { targetRepo, issueNumber, branches } = candidate;

    const token = await getTokenForRepoFn(targetRepo, env, tokenCache);
    if (!token) continue;

    let merged;
    try {
      merged = await isMergedPrFn(targetRepo, issueNumber, token);
    } catch (err) {
      console.warn(`::warning::Could not check merge state for ${targetRepo}#${issueNumber}, leaving its branches untouched: ${err.message}`);
      continue;
    }
    if (!merged) continue;

    mergedPrCount++;
    const deleted = [];
    for (const kind of BRANCH_KINDS) {
      const branchName = branches[kind];
      if (!branchName) continue;
      try {
        if (await deleteBranchFn(remoteUrl, branchName)) {
          deleted.push(branchName);
          deletedBranchCount++;
        }
      } catch (err) {
        console.error(`::error::Failed to delete ${branchName}: ${redactUrl(err.message)}`);
        process.exitCode = 1;
      }
    }
    if (deleted.length > 0) {
      console.log(`Merged PR ${targetRepo}#${issueNumber}: deleted ${deleted.join(', ')}`);
    }
  }

  console.log(`Done. Deleted ${deletedBranchCount} branch(es) for ${mergedPrCount} merged PR(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error in cleanup-data-branches:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { slugToOwnerRepo, parseCandidates, isMergedPr, deleteBranch, getTokenForRepo, main };
