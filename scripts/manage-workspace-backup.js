// Backs up uncommitted/unpushed work left in the target-repo checkout when a
// dispatcher run ends without cleanly finishing (crash, timeout, killed
// runner, silent stall — issue #115), and restores it at the start of the
// next run for the same target repo/issue. Same git-branch-as-datastore
// pattern manage-summaries.js and manage-pending-retries.js use for
// the-intern-data, this time on a per-key orphan branch
// `workspace/<repo-slug>/<issue#>`.
//
// Two things can be left behind, and both are covered:
//   - uncommitted changes in the working tree (staged or not)
//   - local commits that were never pushed (agent committed, then the run
//     died before `git push` — a clean working tree alone does not mean
//     there is nothing to lose)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { resolveDataRepoRemoteUrl, redactUrl } = require('./data-repo-remote.js');

const DIFF_FILE = 'diff.patch';
const COMMITS_FILE = 'commits.patch';
const TRANSCRIPT_DIR = 'transcript';
const LARGE_BUFFER = 1024 * 1024 * 50;

function sanitizeSlug(repo) {
  return repo.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function getBranchName(targetRepo, issueNumber) {
  return `workspace/${sanitizeSlug(targetRepo)}/${issueNumber}`;
}

// Mirrors manage-pending-retries.js's runGit: stdio is suppressed on an
// allowed failure so an expected miss (e.g. probing a branch that may not
// exist yet) doesn't print a raw `fatal: ...` line into the job log.
//
// trim defaults to true (fine for branch names/shas/single-line output), but
// must be turned off for anything that becomes patch content: a trailing
// newline in a diff/format-patch hunk is meaningful to `git apply`/`git am` —
// stripping it silently corrupts the last line of the last hunk.
function runGit(cmd, options = {}) {
  const { allowFailure = false, stdio: callerStdio, trim = true, ...execOptions } = options;
  try {
    const stdio = allowFailure ? ['pipe', 'pipe', 'pipe'] : callerStdio;
    const output = execSync(`git ${cmd}`, { encoding: 'utf8', maxBuffer: LARGE_BUFFER, ...execOptions, stdio });
    return trim ? output.trim() : output;
  } catch (err) {
    if (allowFailure) return '';
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${redactUrl(cmd)} failed: ${redactUrl(detail)}`);
  }
}

function ensureSafeDirectory(dir = process.cwd()) {
  runGit(`config --global --add safe.directory "${dir}"`, { allowFailure: true });
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function resolveRemoteUrl() {
  const remoteUrl = await resolveDataRepoRemoteUrl();
  if (!remoteUrl) {
    throw new Error('the-intern-data remote is not configured (APP_ID/APP_PRIVATE_KEY or DATA_REPO_REMOTE_URL)');
  }
  return remoteUrl;
}

// Local commits are only recoverable if we know what to diff against. Prefer
// the branch's real upstream (accounts for anything the agent fetched/pulled
// mid-run); fall back to the HEAD sha captured before the agent started
// (dispatcher.yml writes this to /tmp/stop_hook_baseline_sha.txt already, for
// the stop hook) so a brand-new local branch that was never pushed is still
// covered.
function resolveAheadBase(baselineShaFile) {
  const upstream = runGit('rev-parse --abbrev-ref --symbolic-full-name @{u}', { allowFailure: true });
  if (upstream) return upstream;
  if (baselineShaFile && fs.existsSync(baselineShaFile)) {
    const sha = fs.readFileSync(baselineShaFile, 'utf8').trim();
    if (sha && runGit(`cat-file -t ${sha}`, { allowFailure: true }) === 'commit') return sha;
  }
  return '';
}

// Runs against whatever git repo is cwd (the target-repo checkout in
// production). Stages everything so the diff below also picks up untracked
// files, same as the design in issue #115.
function collectWorkspaceState({ baselineShaFile } = {}) {
  runGit('add -A');
  const diffPatch = runGit(`diff --cached HEAD --binary`, { allowFailure: true, trim: false });

  const base = resolveAheadBase(baselineShaFile);
  const commitsPatch = base
    ? runGit(`format-patch ${base}..HEAD --binary --stdout`, { allowFailure: true, trim: false })
    : '';

  return { diffPatch, commitsPatch };
}

// Best-effort: picks up the newest Claude session transcript (if any) plus
// codex's own event log (if any). Debugging aid only — restore never reads
// these back, so a miss here must never fail the backup.
function collectTranscriptFiles({ homeDir = '/home/dev', codexEventsFile = '/tmp/codex-events.jsonl' } = {}) {
  const files = [];

  const projectsDir = path.join(homeDir, '.claude', 'projects');
  let newestClaude = null;
  try {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const mtime = fs.statSync(full).mtimeMs;
          if (!newestClaude || mtime > newestClaude.mtime) newestClaude = { path: full, mtime };
        }
      }
    };
    walk(projectsDir);
  } catch {
    // No Claude session directory (codex backend, or nothing ever ran) — fine.
  }
  if (newestClaude) files.push({ name: 'claude-session.jsonl', path: newestClaude.path });

  if (codexEventsFile && fs.existsSync(codexEventsFile)) {
    files.push({ name: 'codex-events.jsonl', path: codexEventsFile });
  }

  return files;
}

// Pushes an empty tree to the backup branch (or does nothing if it's already
// empty/absent), so a later run never re-applies stale content. Uses a
// detached worktree rather than checking out the orphan branch in cwd —
// cwd is the target-repo checkout, which the caller (or a later workflow
// step) still needs intact.
async function clearBackup(targetRepo, issueNumber) {
  if (!targetRepo || !issueNumber) return;
  ensureSafeDirectory();

  let remoteUrl;
  try {
    remoteUrl = await resolveRemoteUrl();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
    return;
  }

  const branchName = getBranchName(targetRepo, issueNumber);
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-clear-'));
  const gitOpts = { cwd: worktreeDir };
  try {
    runGit(`worktree add --detach "${worktreeDir}"`);
    ensureSafeDirectory(worktreeDir);
    runGit('config user.name "the-intern-bot[bot]"', { ...gitOpts, allowFailure: true });
    runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"', { ...gitOpts, allowFailure: true });

    try {
      runGit(`fetch ${remoteUrl} ${branchName}:${branchName}`, gitOpts);
    } catch (err) {
      if (/couldn't find remote ref/i.test(err.message)) {
        console.log(`No backup branch ${branchName} to clear.`);
        return;
      }
      throw err;
    }
    runGit(`checkout ${branchName}`, gitOpts);

    const tracked = runGit('ls-files', { ...gitOpts, allowFailure: true });
    if (!tracked) {
      console.log(`Backup branch ${branchName} is already empty.`);
      return;
    }

    runGit('rm -rf .', gitOpts);
    runGit(`commit --allow-empty -m "workspace-backup: cleared ${new Date().toISOString()}"`, gitOpts);
    runGit(`push ${remoteUrl} ${branchName}`, gitOpts);
    console.log(`Cleared backup branch ${branchName}.`);
  } catch (err) {
    console.error(`::error::Failed to clear backup branch ${branchName}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    runGit(`worktree remove --force "${worktreeDir}"`, { allowFailure: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

// Pushes the collected diff/commits/transcript to the backup branch. Retries
// on non-fast-forward like manage-summaries.js/manage-pending-retries.js —
// a stray leftover branch from an ancient run and this run's write can race.
async function saveBackup(targetRepo, issueNumber, { diffPatch, commitsPatch, transcriptFiles = [] }) {
  if (!targetRepo || !issueNumber) return;
  if (!diffPatch && !commitsPatch) {
    console.log('Nothing uncommitted or unpushed to back up; clearing any stale backup instead.');
    await clearBackup(targetRepo, issueNumber);
    return;
  }

  ensureSafeDirectory();
  let remoteUrl;
  try {
    remoteUrl = await resolveRemoteUrl();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
    return;
  }

  const branchName = getBranchName(targetRepo, issueNumber);
  const maxAttempts = 3;
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-save-'));
  const gitOpts = { cwd: worktreeDir };

  try {
    runGit(`worktree add --detach "${worktreeDir}"`);
    ensureSafeDirectory(worktreeDir);
    runGit('config user.name "the-intern-bot[bot]"', { ...gitOpts, allowFailure: true });
    runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"', { ...gitOpts, allowFailure: true });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        runGit('checkout --detach', { ...gitOpts, allowFailure: true });
        runGit(`branch -D ${branchName}`, { ...gitOpts, allowFailure: true });
        runGit(`fetch ${remoteUrl} ${branchName}:${branchName}`, { ...gitOpts, allowFailure: true });
      }

      try {
        runGit(`checkout --orphan ${branchName}`, gitOpts);
        runGit('rm -rf .', { ...gitOpts, allowFailure: true });
      } catch {
        runGit(`checkout ${branchName}`, gitOpts);
        runGit('rm -rf .', { ...gitOpts, allowFailure: true });
      }

      if (diffPatch) fs.writeFileSync(path.join(worktreeDir, DIFF_FILE), diffPatch, 'utf8');
      if (commitsPatch) fs.writeFileSync(path.join(worktreeDir, COMMITS_FILE), commitsPatch, 'utf8');
      if (transcriptFiles.length > 0) {
        const transcriptDir = path.join(worktreeDir, TRANSCRIPT_DIR);
        fs.mkdirSync(transcriptDir, { recursive: true });
        for (const file of transcriptFiles) {
          try {
            fs.copyFileSync(file.path, path.join(transcriptDir, file.name));
          } catch (err) {
            console.warn(`::warning::Could not copy transcript ${file.path}: ${err.message}`);
          }
        }
      }

      runGit('add -A', gitOpts);
      runGit(`commit -m "workspace-backup: ${targetRepo} #${issueNumber} at ${new Date().toISOString()}"`, gitOpts);

      try {
        runGit(`push ${remoteUrl} ${branchName}`, gitOpts);
        console.log(`Pushed workspace backup to the-intern-data:${branchName}`);
        return;
      } catch (err) {
        const isRejected = /non-fast-forward|fetch first/i.test(err.message);
        if (isRejected && attempt < maxAttempts) {
          console.warn(`Push to ${branchName} was rejected (attempt ${attempt}/${maxAttempts}), retrying: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error(`::error::Failed to save workspace backup for ${targetRepo} #${issueNumber}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    runGit(`worktree remove --force "${worktreeDir}"`, { allowFailure: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

// Reads (never checks out) diff.patch/commits.patch off the backup branch, if
// it exists. Safe to call from any git repo, including the target checkout
// the restore step is about to apply onto.
async function fetchBackup(targetRepo, issueNumber) {
  if (!targetRepo || !issueNumber) return { found: false, diffPatch: '', commitsPatch: '' };
  ensureSafeDirectory();

  let remoteUrl;
  try {
    remoteUrl = await resolveDataRepoRemoteUrl();
  } catch (err) {
    console.warn(`Skipping workspace-backup fetch: ${err.message}`);
    return { found: false, diffPatch: '', commitsPatch: '' };
  }
  if (!remoteUrl) return { found: false, diffPatch: '', commitsPatch: '' };

  const branchName = getBranchName(targetRepo, issueNumber);
  try {
    runGit(`fetch ${remoteUrl} ${branchName}:${branchName}`);
  } catch (err) {
    if (!/couldn't find remote ref/i.test(err.message)) {
      console.warn(`::warning::Could not fetch workspace backup branch ${branchName}: ${err.message}`);
    } else {
      console.log(`No workspace backup found for ${branchName}`);
    }
    return { found: false, diffPatch: '', commitsPatch: '' };
  }

  const diffPatch = runGit(`show ${branchName}:${DIFF_FILE}`, { allowFailure: true, trim: false });
  const commitsPatch = runGit(`show ${branchName}:${COMMITS_FILE}`, { allowFailure: true, trim: false });
  const found = Boolean(diffPatch || commitsPatch);
  if (found) console.log(`Retrieved workspace backup from the-intern-data: ${branchName}`);
  else console.log(`Workspace backup branch ${branchName} exists but has nothing to restore.`);

  return { found, diffPatch, commitsPatch, branchName };
}

// Orchestrates the `always()` post-agent workflow step: decide what (if
// anything) needs backing up in the current cwd (the target-repo checkout),
// then save or clear accordingly.
async function runBackupStep(env = process.env) {
  const targetRepo = env.TARGET_REPO || '';
  const issueNumber = env.ISSUE_NUMBER || '';
  if (!targetRepo || !issueNumber) return;

  ensureSafeDirectory();
  const { diffPatch, commitsPatch } = collectWorkspaceState({
    baselineShaFile: env.BASELINE_SHA_FILE || '/tmp/stop_hook_baseline_sha.txt',
  });

  if (!diffPatch && !commitsPatch) {
    console.log('Working tree is clean and there are no unpushed commits; clearing any stale backup.');
    await clearBackup(targetRepo, issueNumber);
    return;
  }

  const transcriptFiles = collectTranscriptFiles({
    homeDir: env.AGENT_HOME_DIR,
    codexEventsFile: env.CODEX_EVENTS_FILE,
  });
  console.log(`Backing up ${diffPatch ? 'uncommitted changes' : ''}${diffPatch && commitsPatch ? ' and ' : ''}${commitsPatch ? 'unpushed commits' : ''} for ${targetRepo}#${issueNumber}.`);
  await saveBackup(targetRepo, issueNumber, { diffPatch, commitsPatch, transcriptFiles });
}

// Orchestrates the pre-agent restore step: fetch, replay commits then apply
// the uncommitted diff onto cwd (the fresh target-repo checkout), and clear
// the backup branch once done — regardless of whether the replay/apply
// applied cleanly — so a third stalled run never reapplies the same stale
// patch on top of newer work (issue #115).
async function runRestoreStep(env = process.env) {
  const targetRepo = env.TARGET_REPO || '';
  const issueNumber = env.ISSUE_NUMBER || '';
  if (!targetRepo || !issueNumber) {
    writeOutput('restored', 'false');
    return;
  }

  ensureSafeDirectory();
  const backup = await fetchBackup(targetRepo, issueNumber);
  if (!backup.found) {
    writeOutput('restored', 'false');
    return;
  }

  let restoredSomething = false;

  if (backup.commitsPatch) {
    const patchFile = path.join(os.tmpdir(), 'workspace-backup-commits.patch');
    fs.writeFileSync(patchFile, backup.commitsPatch, 'utf8');
    try {
      runGit(`am --3way "${patchFile}"`);
      restoredSomething = true;
      console.log('Restored previously unpushed commits from backup.');
    } catch (err) {
      runGit('am --abort', { allowFailure: true });
      console.warn(`::warning::Could not replay backed-up commits cleanly, they were left on the backup branch's history but not applied: ${err.message}`);
    }
  }

  if (backup.diffPatch) {
    const patchFile = path.join(os.tmpdir(), 'workspace-backup-diff.patch');
    fs.writeFileSync(patchFile, backup.diffPatch, 'utf8');
    try {
      runGit(`apply --whitespace=nowarn "${patchFile}"`);
      restoredSomething = true;
      console.log('Restored previously uncommitted changes from backup.');
    } catch (err) {
      console.warn(`::warning::Could not apply backed-up uncommitted diff cleanly: ${err.message}`);
    }
  }

  writeOutput('restored', restoredSomething ? 'true' : 'false');
  await clearBackup(targetRepo, issueNumber);
}

if (require.main === module) {
  const mode = process.argv[2];

  (async () => {
    if (mode === 'backup') {
      await runBackupStep(process.env);
    } else if (mode === 'restore') {
      await runRestoreStep(process.env);
    } else {
      console.error(`Unknown mode "${mode}"; expected "backup" or "restore".`);
      process.exitCode = 1;
    }
  })().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  getBranchName,
  collectWorkspaceState,
  collectTranscriptFiles,
  saveBackup,
  fetchBackup,
  clearBackup,
  runBackupStep,
  runRestoreStep,
};
