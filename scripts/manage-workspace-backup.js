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
// GitHub hard-rejects any pushed file over 100MB (GH001) — the exact
// rejection that paged the maintainer in issue #167, for a session whose
// real diff was <60 lines. A commits.patch anywhere near that size is a
// signal that resolveAheadBase() picked an implausible base (e.g. `@{u}`
// pointing somewhere unrelated, or a stale baseline sha) rather than real
// unpushed work, so it's treated as a skip-and-warn instead of a value to
// push and let fail downstream.
const MAX_COMMITS_PATCH_BYTES = 1024 * 1024 * 90;
// Agent-infra bookkeeping that must never enter the backup: it's written into
// the target checkout by the dispatcher's "Run agent" step, not by the agent,
// and restoring it on the next dispatch would dump it back as an uncommitted
// change for the agent to (wrongly) review and commit.
const EXCLUDED_PATHS = ['session_result.txt'];
// Debugging aid only (see collectTranscriptFiles below) — capped so a crash
// mid-session doesn't push an unbounded, possibly secret-containing
// transcript into the-intern-data. The tail is what matters for debugging a
// stall anyway.
const TRANSCRIPT_MAX_LINES = 500;
// The target-repo checkout (this module's cwd/worktree source in production)
// has its own installation token persisted as a global-matching
// `http.https://github.com/.extraheader` (dispatcher.yml's "Checkout target
// repository" step can't set persist-credentials: false — the agent's own
// push back to the target repo relies on it, see issue #128). That header
// wins over the DATA_REPO_TOKEN embedded in remoteUrl's basic-auth userinfo,
// so every fetch/push aimed at the-intern-data must explicitly clear it for
// just that command.
const CLEAR_TARGET_REPO_EXTRAHEADER = '-c http.https://github.com/.extraheader=';

function sanitizeSlug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function getBranchName(targetRepo, issueNumber) {
  return `workspace/${sanitizeSlug(targetRepo)}/${sanitizeSlug(issueNumber)}`;
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

// Same as runGit, but for commands whose stdout can be large/binary (diff,
// format-patch). execSync's default stdio pipes stdout through Node, which
// reads it synchronously in a tight loop; on Linux, a child that produces
// output faster than that loop drains the pipe can overflow it and crash
// with ENOBUFS — an OS pipe-capacity error, not the maxBuffer Node-side
// limit, so raising maxBuffer does not help (issue #149). Redirecting stdout
// straight to a file descriptor sidesteps Node's pipe entirely; the OS
// writes the file directly and there is no synchronous reader to overrun.
function runGitToFile(cmd, options = {}) {
  const { allowFailure = false, trim = true, ...execOptions } = options;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-git-'));
  const outFile = path.join(tmpDir, 'output');
  const fd = fs.openSync(outFile, 'w');
  try {
    execSync(`git ${cmd}`, { maxBuffer: LARGE_BUFFER, ...execOptions, stdio: ['ignore', fd, 'pipe'] });
    const output = fs.readFileSync(outFile, 'utf8');
    return trim ? output.trim() : output;
  } catch (err) {
    if (allowFailure) return '';
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${redactUrl(cmd)} failed: ${redactUrl(detail)}`);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Same as runGitToFile, but for callers that need to enforce a size ceiling
// without paying for it: an implausible ahead-base can turn format-patch's
// output into a multi-hundred-MB patch, and reading that whole thing into a
// string just to immediately discover it's over the limit and throw it away
// defeats the point of the sanity check. Stats the file on disk first and,
// when it's over maxBytes, returns only the size — the caller never pays for
// fs.readFileSync on the oversized patch.
function runGitToFileSized(cmd, maxBytes, options = {}) {
  const { allowFailure = false, trim = true, ...execOptions } = options;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-git-'));
  const outFile = path.join(tmpDir, 'output');
  const fd = fs.openSync(outFile, 'w');
  try {
    execSync(`git ${cmd}`, { maxBuffer: LARGE_BUFFER, ...execOptions, stdio: ['ignore', fd, 'pipe'] });
    const { size } = fs.statSync(outFile);
    if (size > maxBytes) return { tooLarge: true, size, content: '' };
    const output = fs.readFileSync(outFile, 'utf8');
    return { tooLarge: false, size, content: trim ? output.trim() : output };
  } catch (err) {
    if (allowFailure) return { tooLarge: false, size: 0, content: '' };
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${redactUrl(cmd)} failed: ${redactUrl(detail)}`);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    throw new Error('the-intern-data remote is not configured (DATA_REPO_TOKEN or DATA_REPO_REMOTE_URL)');
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
  // Resolve to the immutable commit sha, not the symbolic `origin/main`-style
  // ref: rev-list and format-patch below are two separate git invocations,
  // and a concurrent fetch updating the remote-tracking ref between them
  // could otherwise make the reported commit count and the patch content
  // disagree about what "ahead" means.
  const upstream = runGit('rev-parse --verify @{u}', { allowFailure: true });
  if (upstream) return upstream;
  if (baselineShaFile && fs.existsSync(baselineShaFile)) {
    const sha = fs.readFileSync(baselineShaFile, 'utf8').trim();
    if (sha && runGit(`cat-file -t ${sha}`, { allowFailure: true }) === 'commit') return sha;
  }
  return '';
}

// Runs against whatever git repo is cwd (the target-repo checkout in
// production). Stages everything so the diff below also picks up untracked
// files, same as the design in issue #115. Neither git call here is allowed
// to fail silently: `git diff`/`git format-patch` without --exit-code exit 0
// even when there's nothing to show, so a real failure (e.g. ENOBUFS on a
// huge diff) is a genuine error, not "nothing to back up" — swallowing it
// would make the caller believe the tree is clean and delete any existing
// backup instead of preserving it.
function collectWorkspaceState({ baselineShaFile, maxCommitsPatchBytes = MAX_COMMITS_PATCH_BYTES } = {}) {
  const pathspec = ['.', ...EXCLUDED_PATHS.map(p => `":(exclude)${p}"`)].join(' ');
  runGit(`add -A -- ${pathspec}`);
  const diffPatch = runGitToFile(`diff --cached HEAD --binary`, { trim: false });

  const base = resolveAheadBase(baselineShaFile);
  let commitsPatch = '';
  if (base) {
    const commitCount = runGit(`rev-list --count ${base}..HEAD`, { allowFailure: true }) || '(unknown)';
    console.log(`workspace-backup: ahead-base=${base} commits-ahead=${commitCount}`);

    const { tooLarge, size, content } = runGitToFileSized(
      `format-patch ${base}..HEAD --binary --stdout`,
      maxCommitsPatchBytes,
      { trim: false }
    );
    if (tooLarge) {
      console.warn(
        `::warning::workspace-backup: commits.patch would be ${(size / (1024 * 1024)).toFixed(1)}MB ` +
        `(base=${base}, commits-ahead=${commitCount}), over the ${(maxCommitsPatchBytes / (1024 * 1024)).toFixed(0)}MB ` +
        `sanity threshold. This almost always means the ahead-base is wrong, not that there is really this much ` +
        `unpushed work. Skipping the commits backup instead of pushing a patch that GitHub would reject.`
      );
    } else {
      commitsPatch = content;
    }
  }

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

// Copies only the last TRANSCRIPT_MAX_LINES lines of a transcript file rather
// than the whole thing — see TRANSCRIPT_MAX_LINES above. Reads only a bounded
// tail of the file itself first: a stalled session is exactly the case that
// produces a huge transcript, and reading the whole thing into a string risks
// high memory use or ERR_STRING_TOO_LONG just to throw most of it away.
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

function copyTranscriptTruncated(srcPath, destPath, maxLines = TRANSCRIPT_MAX_LINES) {
  const { size } = fs.statSync(srcPath);
  const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const fd = fs.openSync(srcPath, 'r');
  let chunk;
  try {
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    chunk = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = chunk.split('\n');
  if (start > 0) lines.shift();
  const tail = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  fs.writeFileSync(destPath, tail.join('\n'));
}

// Fetches the backup branch, runs `prepare()` to build its new content, and
// pushes with retry on non-fast-forward — the same race
// manage-summaries.js/manage-pending-retries.js guard against: another run
// can push to this backup branch between our fetch and our push. Always
// fetches first (even on attempt 1), so a push against an already-existing
// remote branch doesn't waste a guaranteed-to-be-rejected round trip.
function pushWithRetry(remoteUrl, branchName, gitOpts, prepare, { maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    runGit('checkout --detach', { ...gitOpts, allowFailure: true });
    runGit(`branch -D ${branchName}`, { ...gitOpts, allowFailure: true });
    runGit(`${CLEAR_TARGET_REPO_EXTRAHEADER} fetch ${remoteUrl} ${branchName}:${branchName}`, { ...gitOpts, allowFailure: true });

    prepare();

    try {
      runGit(`${CLEAR_TARGET_REPO_EXTRAHEADER} push ${remoteUrl} ${branchName}`, gitOpts);
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
      runGit(`${CLEAR_TARGET_REPO_EXTRAHEADER} fetch ${remoteUrl} ${branchName}:${branchName}`, gitOpts);
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

    pushWithRetry(remoteUrl, branchName, gitOpts, () => {
      runGit(`checkout ${branchName}`, gitOpts);
      runGit('rm -rf --ignore-unmatch .', gitOpts);
      runGit(`commit --allow-empty -m "workspace-backup: cleared ${new Date().toISOString()}"`, gitOpts);
    });
    console.log(`Cleared backup branch ${branchName}.`);
  } catch (err) {
    console.error(`::error::Failed to clear backup branch ${branchName}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // Deletes only the local ref inside the worktree's shared object store
    // (the target-repo checkout in production) — the backup branch itself
    // lives on the-intern-data's remote and is untouched. A linked worktree
    // shares refs with the repo it was created from, so leaving this ref
    // around would make the backup content (including transcripts) fetchable
    // from within the target checkout, and thus pushable by a subsequent
    // `git push --all`/`--mirror`.
    runGit(`branch -D ${branchName}`, { ...gitOpts, allowFailure: true });
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
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-save-'));
  const gitOpts = { cwd: worktreeDir };

  try {
    runGit(`worktree add --detach "${worktreeDir}"`);
    ensureSafeDirectory(worktreeDir);
    runGit('config user.name "the-intern-bot[bot]"', { ...gitOpts, allowFailure: true });
    runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"', { ...gitOpts, allowFailure: true });

    pushWithRetry(remoteUrl, branchName, gitOpts, () => {
      try {
        runGit(`checkout --orphan ${branchName}`, gitOpts);
      } catch {
        runGit(`checkout ${branchName}`, gitOpts);
      }
      // --ignore-unmatch (not allowFailure) so a brand-new orphan with
      // nothing tracked yet is fine, but any other rm failure still throws
      // instead of silently leaving the target repo's own tree staged below.
      runGit('rm -rf --ignore-unmatch .', gitOpts);

      if (diffPatch) fs.writeFileSync(path.join(worktreeDir, DIFF_FILE), diffPatch, 'utf8');
      if (commitsPatch) fs.writeFileSync(path.join(worktreeDir, COMMITS_FILE), commitsPatch, 'utf8');
      if (transcriptFiles.length > 0) {
        const transcriptDir = path.join(worktreeDir, TRANSCRIPT_DIR);
        fs.mkdirSync(transcriptDir, { recursive: true });
        for (const file of transcriptFiles) {
          try {
            copyTranscriptTruncated(file.path, path.join(transcriptDir, file.name));
          } catch (err) {
            console.warn(`::warning::Could not copy transcript ${file.path}: ${err.message}`);
          }
        }
      }

      runGit('add -A', gitOpts);
      // --allow-empty: re-backing up an identical stalled state (e.g. a
      // retained backup after a failed restore, then a run that changes
      // nothing) would otherwise fail with "nothing to commit" and
      // red-flag a backup that's already correctly stored. clearBackup
      // already does the same.
      runGit(`commit --allow-empty -m "workspace-backup: ${targetRepo} #${issueNumber} at ${new Date().toISOString()}"`, gitOpts);
    });
    console.log(`Pushed workspace backup to the-intern-data:${branchName}`);
  } catch (err) {
    console.error(`::error::Failed to save workspace backup for ${targetRepo} #${issueNumber}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // See the matching comment in clearBackup: don't leave the backup branch
    // fetchable from inside the worktree's (target checkout's) object store.
    runGit(`branch -D ${branchName}`, { ...gitOpts, allowFailure: true });
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

  // Fetched into a scratch ref outside refs/heads rather than a same-named
  // local branch: this runs directly in cwd, the target-repo checkout, right
  // before the agent runs with a push token for that repo. A normal branch
  // ref would sit in target/.git and be reachable — and pushable (`git push
  // --all`/`--mirror`) — by the agent for the rest of the run. The ref is
  // deleted again once we're done reading from it, below.
  const branchName = getBranchName(targetRepo, issueNumber);
  const scratchRef = `refs/workspace-backup-fetch/${sanitizeSlug(issueNumber)}`;
  try {
    runGit(`${CLEAR_TARGET_REPO_EXTRAHEADER} fetch ${remoteUrl} ${branchName}:${scratchRef}`);
  } catch (err) {
    if (!/couldn't find remote ref/i.test(err.message)) {
      console.warn(`::warning::Could not fetch workspace backup branch ${branchName}: ${err.message}`);
    } else {
      console.log(`No workspace backup found for ${branchName}`);
    }
    return { found: false, diffPatch: '', commitsPatch: '' };
  }

  try {
    const diffPatch = runGit(`show ${scratchRef}:${DIFF_FILE}`, { allowFailure: true, trim: false });
    const commitsPatch = runGit(`show ${scratchRef}:${COMMITS_FILE}`, { allowFailure: true, trim: false });
    const found = Boolean(diffPatch || commitsPatch);
    if (found) console.log(`Retrieved workspace backup from the-intern-data: ${branchName}`);
    else console.log(`Workspace backup branch ${branchName} exists but has nothing to restore.`);

    return { found, diffPatch, commitsPatch, branchName };
  } finally {
    runGit(`update-ref -d ${scratchRef}`, { allowFailure: true });
  }
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
// the uncommitted diff onto cwd (the fresh target-repo checkout). Clears the
// backup branch only once everything that was present replayed/applied
// cleanly — so a third stalled run never reapplies the same stale patch on
// top of newer work (issue #115) — but leaves it in place on any failure, so
// a conflicting apply doesn't silently discard the only copy of the agent's
// prior work; a human can recover it from the backup branch manually.
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
  let restoreFailed = false;

  if (backup.commitsPatch) {
    const patchFile = path.join(os.tmpdir(), 'workspace-backup-commits.patch');
    fs.writeFileSync(patchFile, backup.commitsPatch, 'utf8');
    try {
      // `git am` needs a committer identity even though the patch carries
      // its own author, and this restore step runs before the dispatcher
      // configures one in the target checkout (that happens later, inside
      // "Run agent") — set it inline for just this command instead.
      runGit(`-c user.name="the-intern-bot[bot]" -c user.email="the-intern-bot[bot]@users.noreply.github.com" am --3way "${patchFile}"`);
      restoredSomething = true;
      console.log('Restored previously unpushed commits from backup.');
    } catch (err) {
      runGit('am --abort', { allowFailure: true });
      restoreFailed = true;
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
      restoreFailed = true;
      console.warn(`::warning::Could not apply backed-up uncommitted diff cleanly: ${err.message}`);
    }
  }

  writeOutput('restored', restoredSomething ? 'true' : 'false');

  if (restoreFailed) {
    console.warn(`::warning::Leaving backup branch ${backup.branchName} in place — part of the restore failed, so it needs manual recovery instead of being auto-cleared.`);
    return;
  }

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
