// Persists the silenced, accumulated stdout/stderr log of a workflow run to
// the-intern-data (private) at the end of every run (issue #224, extended by
// #335). Every `run:` step in those jobs redirects its output into a single
// on-disk log file instead of streaming it to the public Actions log; the
// final `if: always()` step calls this module so a post-mortem is possible
// after success, failure or cancellation alike. Nothing here ever echoes the
// log to the public run log, uploads an artifact, or writes a step summary.
//
// Layout on the `action-logs` branch:
//   action-logs/<YYYY-MM-DD>/<run_id>-<attempt>-<target-slug>-<issue>.log
// Content is redacted (known token patterns + values of secret-looking env
// vars) and prefixed with a small header. `--prune` mode (daily cron) deletes
// day directories older than RETENTION_DAYS and squashes the branch to a
// single orphan commit so deleted logs don't live on in history.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveDataRepoRemoteUrl, redactUrl } = require('./data-repo-remote.js');

const BRANCH_NAME = 'action-logs';
const LOG_DIR = 'action-logs';
const RETENTION_DAYS = 7;
// Caps what gets pushed, not what the job wrote to disk: keeps a single
// pathological run from ballooning the-intern-data. The tail is what matters
// for debugging a failure anyway (mirrors manage-codex-log.js's
// MAX_LOG_BYTES/manage-workspace-backup.js's TRANSCRIPT_TAIL_BYTES reasoning).
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function sanitizeSlug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// action-logs/<YYYY-MM-DD>/<run_id>-<attempt>-<target-slug>-<issue>.log
// `target` is a repo ("owner/name") or a workflow label; `issue` is optional.
function getLogPath({ date = new Date(), runId, attempt = '1', target, issue } = {}) {
  const name = [runId, attempt, target || 'unknown', issue]
    .filter(part => part !== undefined && part !== null && String(part) !== '')
    .map(sanitizeSlug)
    .join('-');
  return `${LOG_DIR}/${formatDate(date)}/${name}.log`;
}

// Known token shapes. Order matters little; each is replaced independently.
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bbot\d{6,}:[A-Za-z0-9_-]{30,}/g,
  /\b\d{6,}:[A-Za-z0-9_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+\/=-]{16,}/gi,
];
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|_KEY$|CREDENTIAL|AUTH)/i;
const MIN_SECRET_LEN = 8;

function redactSecrets(text, env = process.env) {
  let out = redactUrl(String(text));
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (m, scheme) => (typeof scheme === 'string' ? `${scheme} ***` : '***'));
  }
  // Env secret values, longest first so a value containing another is fully masked.
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_NAME.test(name)) continue;
    for (const v of [value, ...String(value).split(/\r?\n/)]) {
      if (v.length >= MIN_SECRET_LEN) values.add(v);
    }
  }
  for (const v of [...values].sort((x, y) => y.length - x.length)) {
    out = out.split(v).join('***');
  }
  return out;
}

function buildHeader(info = {}) {
  const lines = [
    ['run', info.runUrl],
    ['trigger', info.trigger],
    ['backend', info.backend],
    ['model', info.model],
    ['target', [info.target, info.issue].filter(Boolean).join('#')],
    ['started', info.startedAt],
    ['finished', info.finishedAt],
    ['status', info.status],
  ].map(([k, v]) => `# ${k}: ${v || 'unknown'}`);
  return `${lines.join('\n')}\n${'#'.repeat(40)}\n`;
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

function isExpiredDir(dirName, now = new Date(), days = RETENTION_DAYS) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dirName)) return false;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return dirName < formatDate(cutoff);
}

// Runs `fn(worktreeDir, gitOpts)` in a throwaway detached worktree so the
// caller's own checkout never ends up on the log branch.
async function withWorktree(fn) {
  ensureSafeDirectory();
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
  const gitOpts = { cwd: worktreeDir };
  try {
    runGit(['worktree', 'add', '--detach', worktreeDir]);
    ensureSafeDirectory(worktreeDir);
    runGit(['config', 'user.name', 'the-intern-bot[bot]'], { ...gitOpts, allowFailure: true });
    runGit(['config', 'user.email', '308992161+the-intern-bot[bot]@users.noreply.github.com'], { ...gitOpts, allowFailure: true });
    return await fn(worktreeDir, gitOpts);
  } finally {
    runGit(['branch', '-D', BRANCH_NAME], { ...gitOpts, allowFailure: true });
    runGit(['worktree', 'remove', '--force', worktreeDir], { allowFailure: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

// Best-effort: a failure here must never fail the job — it only warns.
async function saveRunLog({ logFile = '/tmp/run.log', info = {}, env = process.env, now = new Date() } = {}) {
  if (!info.runId) {
    console.log('Skipping run log upload: missing runId.');
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
  // Redact before truncating so a token straddling the cut can't survive.
  content = redactSecrets(content, env);
  const contentBytes = Buffer.from(content, 'utf8');
  if (contentBytes.length > MAX_LOG_BYTES) {
    let start = contentBytes.length - MAX_LOG_BYTES;
    // Slicing by raw byte count can land mid-character; skip forward past any
    // leading UTF-8 continuation bytes (10xxxxxx) so the kept tail decodes cleanly.
    while (start < contentBytes.length && (contentBytes[start] & 0xc0) === 0x80) start++;
    content = contentBytes.subarray(start).toString('utf8');
  }
  let startedAt = info.startedAt;
  if (!startedAt) {
    try { startedAt = fs.statSync(logFile).birthtime.toISOString(); } catch { /* unknown */ }
  }
  const body = redactSecrets(buildHeader({ ...info, startedAt, finishedAt: info.finishedAt || now.toISOString() }), env) + content;

  let remoteUrl;
  try {
    remoteUrl = await resolveRemoteUrl();
  } catch (err) {
    console.warn(`::warning::Skipping run log upload: ${err.message}`);
    return;
  }

  const relPath = getLogPath({ date: now, runId: info.runId, attempt: info.attempt, target: info.target, issue: info.issue });
  try {
    await withWorktree((worktreeDir, gitOpts) => {
      pushWithRetry(remoteUrl, gitOpts, () => {
        try {
          runGit(['checkout', '--orphan', BRANCH_NAME], gitOpts);
          runGit(['rm', '-rf', '--ignore-unmatch', '.'], gitOpts);
        } catch {
          runGit(['checkout', BRANCH_NAME], gitOpts);
        }

        const destPath = path.join(worktreeDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, body, 'utf8');

        runGit(['add', '--', relPath], gitOpts);
        runGit(['commit', '-m', `action-log: run ${info.runId}`], gitOpts);
      });
    });
    console.log(`Pushed run log to the-intern-data:${BRANCH_NAME}/${relPath}`);
  } catch (err) {
    console.warn(`::warning::Failed to push run log: ${redactSecrets(err.message, env)}`);
  }
}

// Daily retention: drop day directories older than RETENTION_DAYS and squash
// the branch into one orphan commit (force-push guarded by a lease), so the
// deleted logs are no longer reachable from the branch's history. Tradeoff:
// no history of the log branch itself, which is fine for ephemeral logs.
async function pruneRunLogs({ now = new Date(), days = RETENTION_DAYS, maxAttempts = 3 } = {}) {
  let remoteUrl;
  try {
    remoteUrl = await resolveRemoteUrl();
  } catch (err) {
    console.warn(`::warning::Skipping run log prune: ${err.message}`);
    return { deleted: [] };
  }
  try {
    return await withWorktree((worktreeDir, gitOpts) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        runGit(['branch', '-D', BRANCH_NAME], { ...gitOpts, allowFailure: true });
        runGit(['fetch', remoteUrl, `${BRANCH_NAME}:${BRANCH_NAME}`], { ...gitOpts, allowFailure: true });
        const oldSha = runGit(['rev-parse', '--verify', '-q', BRANCH_NAME], { ...gitOpts, allowFailure: true });
        if (!oldSha) {
          console.log(`No ${BRANCH_NAME} branch; nothing to prune.`);
          return { deleted: [] };
        }
        runGit(['checkout', BRANCH_NAME], gitOpts);

        const logRoot = path.join(worktreeDir, LOG_DIR);
        const dirs = fs.existsSync(logRoot) ? fs.readdirSync(logRoot) : [];
        const expired = dirs.filter(d => isExpiredDir(d, now, days));
        if (expired.length === 0) {
          console.log('No expired action-log directories.');
          return { deleted: [] };
        }
        for (const d of expired) runGit(['rm', '-rq', '--', `${LOG_DIR}/${d}`], gitOpts);

        runGit(['checkout', '--orphan', `${BRANCH_NAME}-squashed`], gitOpts);
        runGit(['commit', '--allow-empty', '-m', `action-logs: prune logs older than ${days} days`], gitOpts);
        try {
          runGit(['push', `--force-with-lease=refs/heads/${BRANCH_NAME}:${oldSha}`, remoteUrl, `HEAD:refs/heads/${BRANCH_NAME}`], gitOpts);
          console.log(`Pruned ${expired.length} action-log day director${expired.length === 1 ? 'y' : 'ies'}: ${expired.join(', ')}`);
          return { deleted: expired };
        } catch (err) {
          if (attempt < maxAttempts) {
            console.warn(`Prune push rejected (attempt ${attempt}/${maxAttempts}), retrying: ${err.message}`);
            runGit(['checkout', '--detach'], { ...gitOpts, allowFailure: true });
            runGit(['branch', '-D', `${BRANCH_NAME}-squashed`], { ...gitOpts, allowFailure: true });
            continue;
          }
          throw err;
        }
      }
    });
  } catch (err) {
    console.warn(`::warning::Failed to prune run logs: ${err.message}`);
    return { deleted: [] };
  }
}

function infoFromEnv(env = process.env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  return {
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT || '1',
    runUrl: env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '',
    trigger: env.RUN_LOG_TRIGGER || env.GITHUB_EVENT_NAME,
    backend: env.RUN_LOG_BACKEND,
    model: env.RUN_LOG_MODEL,
    target: env.RUN_LOG_TARGET,
    issue: env.RUN_LOG_ISSUE,
    startedAt: env.RUN_LOG_STARTED,
    status: env.RUN_LOG_STATUS,
  };
}

if (require.main === module) {
  const task = process.argv.includes('--prune')
    ? pruneRunLogs()
    : saveRunLog({ logFile: process.env.LOG_FILE || undefined, info: infoFromEnv() });
  task.catch(err => {
    // Best-effort contract: never fail the job over a debugging aid.
    console.warn(`::warning::Unexpected error handling run log: ${err.message}`);
  });
}

module.exports = {
  BRANCH_NAME, LOG_DIR, RETENTION_DAYS, MAX_LOG_BYTES,
  getLogPath, redactSecrets, buildHeader, isExpiredDir, saveRunLog, pruneRunLogs, infoFromEnv,
};
