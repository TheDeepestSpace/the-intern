// Pushes the raw codex event log (/tmp/codex-events.jsonl) to the-intern-data
// on a codex-backend failure (issue #134), so an intermittent crash is
// debuggable after the ephemeral container is torn down. Replaces #94's
// approach (closed unmerged): that PR inlined a log snippet into the Telegram
// alert and uploaded the full log as a GitHub Actions artifact, and
// CodeRabbit flagged both as a credential-disclosure risk since codex has
// access to the restored GitHub auth file. Here the raw log never reaches
// Telegram (the alert stays generic) or a GH Actions artifact (semi-shared
// visibility); the only sink is the-intern-data, which is private, so no
// redaction pass is needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveDataRepoRemoteUrl, redactUrl } = require('./data-repo-remote.js');

// Single shared branch (like pending-retries.json) rather than one branch per
// issue (like summaries/workspace backups): failures are rare and diagnostic,
// so there is no benefit to per-issue branch proliferation here, and a single
// branch keeps every log path-browsable under one tree.
const BRANCH_NAME = 'codex-logs';
// Caps what gets pushed, not what codex wrote to disk: keeps a single
// pathological run from ballooning the-intern-data. The tail is what matters
// for debugging a crash anyway (mirrors manage-workspace-backup.js's
// TRANSCRIPT_TAIL_BYTES reasoning).
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function sanitizeSlug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function getLogPath(targetRepo, issueNumber, runId) {
  return path.join(sanitizeSlug(targetRepo), sanitizeSlug(issueNumber), `${sanitizeSlug(runId)}.jsonl`);
}

// Args are passed as an array (execFileSync, not a shell) so none of
// remoteUrl/targetRepo/issueNumber/runId/commit-message ever go through shell
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

// Same retry-on-non-fast-forward shape as manage-workspace-backup.js's
// pushWithRetry: concurrent codex failures across different runs can race on
// this single shared branch.
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

// Best-effort: a failure here must never fail the caller's own failure-
// handling flow (the Telegram alert still needs to go out), so every error
// path here only warns.
async function saveCodexLog({ targetRepo, issueNumber, runId, logFile = '/tmp/codex-events.jsonl' } = {}) {
  if (!targetRepo || !issueNumber || !runId) {
    console.log('Skipping codex log upload: missing targetRepo, issueNumber, or runId.');
    return;
  }
  if (!fs.existsSync(logFile)) {
    console.log(`No codex event log at ${logFile}; nothing to save.`);
    return;
  }

  let content;
  try {
    content = fs.readFileSync(logFile, 'utf8');
  } catch (err) {
    console.warn(`::warning::Could not read codex log ${logFile}: ${err.message}`);
    return;
  }
  if (!content.trim()) {
    console.log('Codex event log is empty; nothing to save.');
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
    console.warn(`::warning::Skipping codex log upload: ${err.message}`);
    return;
  }

  const relPath = getLogPath(targetRepo, issueNumber, runId);

  // Runs in a temporary worktree rather than the caller's own checkout: this
  // is called mid-job from a step (handle-agent-outcome.js) whose caller
  // still needs the outer agent-infra checkout intact for later steps —
  // same constraint manage-pending-retries.js's updateEntries documents.
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-log-'));
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
      runGit(['commit', '-m', `codex-log: ${targetRepo} #${issueNumber} run ${runId}`], gitOpts);
    });
    console.log(`Pushed codex event log to the-intern-data:${BRANCH_NAME}/${relPath}`);
  } catch (err) {
    console.warn(`::warning::Failed to push codex event log: ${err.message}`);
  } finally {
    runGit(['branch', '-D', BRANCH_NAME], { ...gitOpts, allowFailure: true });
    runGit(['worktree', 'remove', '--force', worktreeDir], { allowFailure: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

module.exports = { BRANCH_NAME, MAX_LOG_BYTES, getLogPath, saveCodexLog };
