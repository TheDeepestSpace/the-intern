// Persists pending-retries.json on a dedicated orphan branch, the same
// git-branch-as-datastore approach manage-summaries.js uses for session
// summaries (and telegram-session.yml uses for convo.md) — except this
// branch is global (one file, one array) rather than per-issue, since the
// scheduled poller needs to see every pending entry across all
// issues/PRs/chats in a single read.
//
// This module owns only the git I/O; handle-agent-outcome.js and
// poll-pending-retries.js call it in-process with mutator functions from
// pending-retries-store.js (which is pure and independently unit tested).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const BRANCH_NAME = 'pending-retries';
const FILE_NAME = 'pending-retries.json';

function runGit(cmd, options = {}) {
  const { allowFailure = false, ...execOptions } = options;
  try {
    // stdio defaults to inheriting stderr straight to the job log even when
    // execSync's own error is caught — without this, an expected failure
    // (e.g. `show pending-retries:...` before the branch has ever been
    // created) prints a raw `fatal: ...` line that reads as an unhandled
    // error during incident triage, even though allowFailure below handles
    // it correctly.
    const stdio = allowFailure ? ['pipe', 'pipe', 'pipe'] : undefined;
    return execSync(`git ${cmd}`, { encoding: 'utf8', stdio, ...execOptions }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`git ${cmd} failed: ${(err.stderr || err.message || '').toString().trim()}`);
  }
}

function ensureSafeDirectory(dir = process.cwd()) {
  runGit(`config --global --add safe.directory "${dir}"`, { allowFailure: true });
}

function parseEntries(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Never fall back to [] here: updateEntries would commit that over the
    // branch and delete every queued retry.
    throw new Error(`${FILE_NAME} on ${BRANCH_NAME} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${FILE_NAME} on ${BRANCH_NAME} must contain a JSON array.`);
  }
  return parsed;
}

function readEntries() {
  ensureSafeDirectory();
  runGit(`fetch origin ${BRANCH_NAME}:${BRANCH_NAME}`, { allowFailure: true });
  const raw = runGit(`show ${BRANCH_NAME}:${FILE_NAME}`, { allowFailure: true });
  try {
    return parseEntries(raw);
  } catch (err) {
    // The poller must keep running even if the branch is somehow corrupt;
    // updateEntries (which can overwrite the branch) still throws on this.
    console.error(`::error::${err.message}`);
    return [];
  }
}

// Fetches the branch's current tip, applies `mutate(entries) -> { entries, ...rest }`,
// and pushes. Retries on non-fast-forward like manage-summaries.js's
// saveSummary, since the failure path (writing a new stall) and the
// scheduled poller (firing/removing entries) legitimately race on this
// branch.
//
// Runs entirely inside a temporary git worktree rather than the caller's own
// checkout: handle-agent-outcome.js calls this from the same checkout that
// later steps (rotate-codex-auth.js, manage-summaries.js) still need intact,
// and switching that checkout onto the orphan pending-retries branch (whose
// tree holds only pending-retries.json) would delete scripts/ out from under
// them.
function updateEntries(mutate) {
  ensureSafeDirectory();
  const hasToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const maxAttempts = 3;

  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-retries-'));
  const worktreeFile = path.join(worktreeDir, FILE_NAME);
  const gitOpts = { cwd: worktreeDir };

  try {
    runGit(`worktree add --detach "${worktreeDir}"`);
    ensureSafeDirectory(worktreeDir);

    runGit('config user.name "the-intern-bot[bot]"', { ...gitOpts, allowFailure: true });
    runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"', { ...gitOpts, allowFailure: true });

    let result;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        runGit('checkout --detach', { ...gitOpts, allowFailure: true });
        runGit(`branch -D ${BRANCH_NAME}`, { ...gitOpts, allowFailure: true });
      }
      runGit(`fetch origin ${BRANCH_NAME}:${BRANCH_NAME}`, { ...gitOpts, allowFailure: true });

      try {
        runGit(`checkout ${BRANCH_NAME}`, gitOpts);
      } catch {
        runGit(`checkout --orphan ${BRANCH_NAME}`, gitOpts);
        runGit('rm -rf .', { ...gitOpts, allowFailure: true });
      }

      const raw = fs.existsSync(worktreeFile) ? fs.readFileSync(worktreeFile, 'utf8') : '';
      const entries = parseEntries(raw);

      const { entries: nextEntries, ...rest } = mutate(entries);
      result = rest;

      // No-op mutation (e.g. resolving a key that was never queued) — skip
      // creating a commit (and, on a first-ever call, skip creating the branch
      // at all) rather than comparing git status after the fact, since an
      // orphan checkout has no prior committed content to diff against.
      if (JSON.stringify(nextEntries) === JSON.stringify(entries)) return result;

      fs.writeFileSync(worktreeFile, `${JSON.stringify(nextEntries, null, 2)}\n`, 'utf8');
      runGit(`add ${FILE_NAME}`, gitOpts);
      runGit(`commit -m "pending-retries: update ${new Date().toISOString()}"`, gitOpts);

      if (!hasToken) {
        console.log('No GITHUB_TOKEN/GH_TOKEN set; skipping push of pending-retries branch.');
        return result;
      }

      try {
        runGit(`push origin ${BRANCH_NAME}`, gitOpts);
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
    runGit(`worktree remove --force "${worktreeDir}"`, { allowFailure: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

// Builds the replayable dispatch payload from the triggering GitHub Actions
// event itself, rather than requiring the caller to hand-reconstruct
// target_repo/comment_body/client_payload fields — this stays correct even
// as parse-trigger.js/parse-telegram-trigger.js's field set evolves, since
// the poller replays the original event verbatim.
function buildDispatchPayload({ eventName, eventPath, workflowFile, ref }) {
  let raw = {};
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    } catch (err) {
      // Returning null lets the caller fall back to the generic failure
      // notification instead of throwing out of handle-agent-outcome.js's
      // main() before that notification is sent.
      console.error(`Could not read the triggering event payload: ${err.message}`);
      return null;
    }
  }
  if (eventName === 'workflow_dispatch') {
    if (!workflowFile) return null;
    return { type: 'workflow_dispatch', workflow: workflowFile, ref: ref || 'main', inputs: raw.inputs || {} };
  }
  if (eventName === 'repository_dispatch') {
    const eventType = raw.action || raw.event_type || '';
    if (!eventType) return null;
    return { type: 'repository_dispatch', eventType, clientPayload: raw.client_payload || {} };
  }
  return null;
}

module.exports = { readEntries, updateEntries, buildDispatchPayload, BRANCH_NAME, FILE_NAME };
