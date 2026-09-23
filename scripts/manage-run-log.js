// Uploads the silenced, accumulated stdout/stderr log for a dispatcher/
// telegram-session run to the-intern-data (private) when the job fails
// (issue #224). Every `run:` step in those jobs redirects its own output into
// a single on-disk log file instead of streaming it to the public Actions
// log; this module is the "always() ... if: failure()" step at the end of
// each job that pushes whatever accumulated there before the container tears
// down. On a successful run nothing calls this, so nothing is ever uploaded
// and the public log stays empty.
//
// Same shared-branch-per-log pattern as manage-codex-log.js: failures are
// rare and diagnostic, so there's no benefit to per-issue branch
// proliferation, and a single branch keeps every log path-browsable under
// one tree. Kept as a separate module (rather than generalizing
// manage-codex-log.js) since the two are wired up on different triggers —
// this one fires on any job failure regardless of backend or step, while
// manage-codex-log.js fires only on a detected codex-backend agent failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveDataRepoRemoteUrl, redactUrl } = require('./data-repo-remote.js');

const BRANCH_NAME = 'run-logs';
// Caps what gets pushed, not what the job wrote to disk: keeps a single
// pathological run from ballooning the-intern-data. The tail is what matters
// for debugging a failure anyway (mirrors manage-codex-log.js's
// MAX_LOG_BYTES/manage-workspace-backup.js's TRANSCRIPT_TAIL_BYTES reasoning).
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function sanitizeSlug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
}

// `prefix` is a caller-supplied, already-slash-delimited namespace (e.g.
// "dispatcher/acme-widgets/42" or "telegram-session") — each segment is
// sanitized individually so the slashes stay meaningful path separators
// instead of being collapsed into dashes.
function sanitizePrefix(prefix) {
  return String(prefix || 'unknown')
    .split('/')
    .filter(Boolean)
    .map(sanitizeSlug)
    .join('/');
}

function getLogPath(prefix, runId) {
  return path.join(sanitizePrefix(prefix), `${sanitizeSlug(runId)}.log`);
}

// Args are passed as an array (execFileSync, not a shell) so none of
// remoteUrl/prefix/runId/commit-message ever go through shell
// interpretation, however they're generated upstream.
function runGit(args, options = {}) {
  const { allowFailure = false, stdio: callerStdio, ...execOptions } = options;
  try {
    const stdio = allowFailure ? ['pipe', 'pipe', 'pipe'] : callerStdio;
    return execFileSync('git', args, { encoding: 'utf8', ...execOptions, stdio }).trim();
  } catch (err) {
    if (allowFailure) return '';
    const cmd = args.join(' ');
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${redactUrl(cmd)} failed: ${redactUrl(detail)}`);
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

// Same retry-on-non-fast-forward shape as manage-codex-log.js's
// pushWithRetry: concurrent failures across different runs can race on this
// single shared branch.
function pushWithRetry(remoteUrl, gitOpts, prepare, { maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    runGit(['checkout', '--detach'], { ...gitOpts, allowFailure: true });
    runGit(['branch', '-D', BRANCH_NAME], { ...gitOpts, allowFailure: true });
    runGit(['fetch', remoteUrl, `${BRANCH_NAME}:${BRANCH_NAME}`], { ...gitOpts, allowFailure: true });

    prepare();

    try {
      runGit(['push', remoteUrl, BRANCH_NAME], gitOpts);
      return;
    } catch (err) {
      const isRejected = /non-fast-forward|fetch first/i.test(err.message);
      if (isRejected && attempt < maxAttempts) {
        console.warn(`Push to ${BRANCH_NAME} was rejected (attempt ${attempt}/${maxAttempts}), retrying: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
}

// Best-effort: a failure here must never fail the caller's own failure
// handling — the job is already in a failed state, and the Telegram alert
// (if any) doesn't depend on this succeeding. Every error path here only
// warns.
async function saveRunLog({ prefix, runId, logFile = '/tmp/run.log' } = {}) {
  if (!prefix || !runId) {
    console.log('Skipping run log upload: missing prefix or runId.');
    return;
  }
  if (!fs.existsSync(logFile)) {
    console.log(`No run log at ${logFile}; nothing to save.`);
    return;
  }

  let content;
  try {
    content = fs.readFileSync(logFile, 'utf8');
  } catch (err) {
    console.warn(`::warning::Could not read run log ${logFile}: ${err.message}`);
    return;
  }
  if (!content.trim()) {
    console.log('Run log is empty; nothing to save.');
    return;
  }
  const contentBytes = Buffer.from(content, 'utf8');
  if (contentBytes.length > MAX_LOG_BYTES) {
    let start = contentBytes.length - MAX_LOG_BYTES;
    // Slicing by raw byte count can land mid-character; skip forward past any
    // leading UTF-8 continuation bytes (10xxxxxx) so the kept tail decodes cleanly.
    while (start < contentBytes.length && (contentBytes[start] & 0xc0) === 0x80) start++;
    content = contentBytes.subarray(start).toString('utf8');
  }

  ensureSafeDirectory();
  let remoteUrl;
  try {
    remoteUrl = await resolveRemoteUrl();
  } catch (err) {
    console.warn(`::warning::Skipping run log upload: ${err.message}`);
    return;
  }

  const relPath = getLogPath(prefix, runId);

  // Runs in a temporary worktree rather than the caller's own checkout: this
  // is called from a job's final step, whose caller (the outer agent-infra
  // checkout) doesn't need to end up on this orphan branch.
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
  const gitOpts = { cwd: worktreeDir };
  try {
    runGit(['worktree', 'add', '--detach', worktreeDir]);
    ensureSafeDirectory(worktreeDir);
    runGit(['config', 'user.name', 'the-intern-bot[bot]'], { ...gitOpts, allowFailure: true });
    runGit(['config', 'user.email', 'the-intern-bot[bot]@users.noreply.github.com'], { ...gitOpts, allowFailure: true });

    pushWithRetry(remoteUrl, gitOpts, () => {
      try {
        runGit(['checkout', '--orphan', BRANCH_NAME], gitOpts);
        runGit(['rm', '-rf', '--ignore-unmatch', '.'], gitOpts);
      } catch {
        runGit(['checkout', BRANCH_NAME], gitOpts);
      }

      const destPath = path.join(worktreeDir, relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content, 'utf8');

      runGit(['add', '--', relPath], gitOpts);
      runGit(['commit', '-m', `run-log: ${prefix} run ${runId}`], gitOpts);
    });
    console.log(`Pushed run log to the-intern-data:${BRANCH_NAME}/${relPath}`);
  } catch (err) {
    console.warn(`::warning::Failed to push run log: ${err.message}`);
  } finally {
    runGit(['branch', '-D', BRANCH_NAME], { ...gitOpts, allowFailure: true });
    runGit(['worktree', 'remove', '--force', worktreeDir], { allowFailure: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  saveRunLog({
    prefix: process.env.RUN_LOG_PREFIX,
    runId: process.env.GITHUB_RUN_ID,
    logFile: process.env.LOG_FILE || undefined,
  }).catch(err => {
    // Mirrors the best-effort contract above: log it, but don't flip the
    // step (and thus the already-failed job) into a harder failure over a
    // debugging aid that didn't make it out.
    console.warn(`::warning::Unexpected error saving run log: ${err.message}`);
  });
}

module.exports = { BRANCH_NAME, MAX_LOG_BYTES, getLogPath, saveRunLog };
