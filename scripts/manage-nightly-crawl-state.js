// Persists nightly-crawl.json on a dedicated branch of the-intern-data
// (issue #257), the same git-branch-as-datastore approach
// manage-pending-retries.js uses for pending-retries.json. One global file
// (an object keyed by "owner/repo#number") rather than per-issue branches,
// since the crawl needs every Dependabot confirmation clock and every
// recent conflict dispatch in a single read. The 2-day "confirmed safe"
// clock has to survive between runs, which is the whole reason this lives
// on the-intern-data instead of in a run artifact.
//
// Only the git I/O lives here; every mutation is a pure function from
// nightly-crawl-store.js applied through updateState(mutate).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveDataRepoRemoteUrl, redactUrl, runWithRetryOnNotFound } = require('./data-repo-remote.js');
const { parseState, emptyState } = require('./nightly-crawl-store.js');

const BRANCH_NAME = 'nightly-crawl';
const FILE_NAME = 'nightly-crawl.json';

// Args are passed as an array (execFileSync, not a shell) so the remote URL
// (which embeds a token) never goes through shell interpretation.
function runGit(args, options = {}) {
  const { allowFailure = false, stdio: callerStdio, ...execOptions } = options;
  try {
    const stdio = allowFailure ? ['pipe', 'pipe', 'pipe'] : callerStdio;
    return execFileSync('git', args, { encoding: 'utf8', ...execOptions, stdio }).trim();
  } catch (err) {
    if (allowFailure) return '';
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${redactUrl(args.join(' '))} failed: ${redactUrl(detail)}`);
  }
}

function ensureSafeDirectory(dir = process.cwd()) {
  runGit(['config', '--global', '--add', 'safe.directory', dir], { allowFailure: true });
}

async function resolveRemoteUrl() {
  const remoteUrl = await resolveDataRepoRemoteUrl();
  if (!remoteUrl) {
    throw new Error('the-intern-data remote is not configured (DATA_REPO_TOKEN or DATA_REPO_REMOTE_URL)');
  }
  return remoteUrl;
}

// Read-only snapshot. A missing branch (first-ever run) is an empty state;
// a corrupt file throws, since acting on an empty state would restart every
// confirmation clock and re-dispatch every conflict fix.
async function readState() {
  ensureSafeDirectory();
  const remoteUrl = await resolveRemoteUrl();
  try {
    await runWithRetryOnNotFound(remoteUrl, (url) =>
      runGit(['fetch', url, `${BRANCH_NAME}:${BRANCH_NAME}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    );
  } catch (err) {
    if (/couldn't find remote ref/i.test(err.message)) return emptyState();
    throw err;
  }
  const raw = runGit(['show', `${BRANCH_NAME}:${FILE_NAME}`], { allowFailure: true });
  return parseState(raw);
}

// An orphan checkout inherits the detached HEAD's index (the whole
// the-intern tree, including .github/workflows, which the data-repo PAT may
// not push). Start from an empty index and wipe the working files so the
// state branch can only ever contain what we stage explicitly. Errors here
// must propagate: a swallowed failure would leak the source tree.
function resetToEmptyTree(dir) {
  runGit(['read-tree', '--empty'], { cwd: dir });
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function assertOnlyStateFileStaged(dir) {
  // Full index, not the cached diff: files inherited from an existing branch
  // tip are unchanged and would be invisible to a diff.
  const tracked = runGit(['ls-files'], { cwd: dir })
    .split('\n')
    .filter(Boolean);
  if (tracked.length !== 1 || tracked[0] !== FILE_NAME) {
    throw new Error(`refusing to commit to ${BRANCH_NAME}: expected only ${FILE_NAME} in the tree, got [${tracked.join(', ')}]`);
  }
}

// Fetches the branch tip, applies `mutate(state) -> { state, ...rest }`, and
// pushes; retries on non-fast-forward since the plan and act jobs of one run
// (and the next night's run, if a run overran) can race on this branch.
// Runs inside a temporary worktree so the caller's checkout stays intact.
async function updateState(mutate) {
  ensureSafeDirectory();
  let remoteUrl = await resolveRemoteUrl();
  const maxAttempts = 3;

  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-crawl-state-'));
  const worktreeFile = path.join(worktreeDir, FILE_NAME);
  const gitOpts = { cwd: worktreeDir };

  try {
    runGit(['worktree', 'add', '--detach', worktreeDir]);
    ensureSafeDirectory(worktreeDir);
    runGit(['config', 'user.name', 'the-intern-bot[bot]'], { ...gitOpts, allowFailure: true });
    runGit(['config', 'user.email', 'the-intern-bot[bot]@users.noreply.github.com'], { ...gitOpts, allowFailure: true });

    let result;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Always drop any local ref first so a stale branch is never reused
      // when the remote branch is absent.
      runGit(['checkout', '--detach'], { ...gitOpts, allowFailure: true });
      runGit(['branch', '-D', BRANCH_NAME], { ...gitOpts, allowFailure: true });
      try {
        await runWithRetryOnNotFound(remoteUrl, (url) => {
          remoteUrl = url;
          return runGit(['fetch', url, `${BRANCH_NAME}:${BRANCH_NAME}`], { ...gitOpts, stdio: ['pipe', 'pipe', 'pipe'] });
        });
      } catch (err) {
        // Branch may not exist yet (first-ever write); the orphan checkout
        // below creates it. Any other fetch failure must not fall through
        // to a fresh orphan branch.
        if (!/couldn't find remote ref/i.test(err.message)) throw err;
      }

      try {
        runGit(['checkout', BRANCH_NAME], { ...gitOpts, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        runGit(['checkout', '--orphan', BRANCH_NAME], gitOpts);
        resetToEmptyTree(worktreeDir);
      }

      const raw = fs.existsSync(worktreeFile) ? fs.readFileSync(worktreeFile, 'utf8') : '';
      const state = parseState(raw);

      const { state: nextState, ...rest } = mutate(state);
      result = rest;

      if (JSON.stringify(nextState) === JSON.stringify(state)) return result;

      fs.writeFileSync(worktreeFile, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
      runGit(['add', FILE_NAME], gitOpts);
      assertOnlyStateFileStaged(worktreeDir);
      runGit(['commit', '-m', `nightly-crawl: update ${new Date().toISOString()}`], gitOpts);

      try {
        await runWithRetryOnNotFound(remoteUrl, (url) => {
          remoteUrl = url;
          return runGit(['push', url, BRANCH_NAME], gitOpts);
        });
        return result;
      } catch (err) {
        const isRejected = /non-fast-forward|fetch first/i.test(err.message);
        if (isRejected && attempt < maxAttempts) {
          console.warn(`Push to ${BRANCH_NAME} was rejected (attempt ${attempt}/${maxAttempts}), retrying: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    return result;
  } finally {
    runGit(['worktree', 'remove', '--force', worktreeDir], { allowFailure: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

module.exports = { readState, updateState, BRANCH_NAME, FILE_NAME };
