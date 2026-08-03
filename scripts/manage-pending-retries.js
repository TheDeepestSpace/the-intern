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
const { execSync } = require('child_process');

const BRANCH_NAME = 'pending-retries';
const FILE_NAME = 'pending-retries.json';

function runGit(cmd, options = {}) {
  const { allowFailure = false, ...execOptions } = options;
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', ...execOptions }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`git ${cmd} failed: ${(err.stderr || err.message || '').toString().trim()}`);
  }
}

function ensureSafeDirectory() {
  runGit(`config --global --add safe.directory "${process.cwd()}"`, { allowFailure: true });
}

function parseEntries(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readEntries() {
  ensureSafeDirectory();
  runGit(`fetch origin ${BRANCH_NAME}:${BRANCH_NAME}`, { allowFailure: true });
  const raw = runGit(`show ${BRANCH_NAME}:${FILE_NAME}`, { allowFailure: true });
  return parseEntries(raw);
}

// Fetches the branch's current tip, applies `mutate(entries) -> { entries, ...rest }`,
// and pushes. Retries on non-fast-forward like manage-summaries.js's
// saveSummary, since the failure path (writing a new stall) and the
// scheduled poller (firing/removing entries) legitimately race on this
// branch.
function updateEntries(mutate) {
  ensureSafeDirectory();
  const hasToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const maxAttempts = 3;

  runGit('config user.name "the-intern-bot[bot]"', { allowFailure: true });
  runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"', { allowFailure: true });

  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      runGit('checkout --detach', { allowFailure: true });
      runGit(`branch -D ${BRANCH_NAME}`, { allowFailure: true });
    }
    runGit(`fetch origin ${BRANCH_NAME}:${BRANCH_NAME}`, { allowFailure: true });

    try {
      runGit(`checkout ${BRANCH_NAME}`);
    } catch {
      runGit(`checkout --orphan ${BRANCH_NAME}`);
      runGit('rm -rf .', { allowFailure: true });
    }

    const raw = fs.existsSync(FILE_NAME) ? fs.readFileSync(FILE_NAME, 'utf8') : '';
    const entries = parseEntries(raw);

    const { entries: nextEntries, ...rest } = mutate(entries);
    result = rest;

    // No-op mutation (e.g. resolving a key that was never queued) — skip
    // creating a commit (and, on a first-ever call, skip creating the branch
    // at all) rather than comparing git status after the fact, since an
    // orphan checkout has no prior committed content to diff against.
    if (JSON.stringify(nextEntries) === JSON.stringify(entries)) return result;

    fs.writeFileSync(FILE_NAME, `${JSON.stringify(nextEntries, null, 2)}\n`, 'utf8');
    runGit(`add ${FILE_NAME}`);
    runGit(`commit -m "pending-retries: update ${new Date().toISOString()}"`);

    if (!hasToken) {
      console.log('No GITHUB_TOKEN/GH_TOKEN set; skipping push of pending-retries branch.');
      return result;
    }

    try {
      runGit(`push origin ${BRANCH_NAME}`);
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
}

// Builds the replayable dispatch payload from the triggering GitHub Actions
// event itself, rather than requiring the caller to hand-reconstruct
// target_repo/comment_body/client_payload fields — this stays correct even
// as parse-trigger.js/parse-telegram-trigger.js's field set evolves, since
// the poller replays the original event verbatim.
function buildDispatchPayload({ eventName, eventPath, workflowFile, ref }) {
  let raw = {};
  if (eventPath && fs.existsSync(eventPath)) {
    raw = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  }
  if (eventName === 'workflow_dispatch') {
    return { type: 'workflow_dispatch', workflow: workflowFile, ref: ref || 'main', inputs: raw.inputs || {} };
  }
  if (eventName === 'repository_dispatch') {
    return { type: 'repository_dispatch', eventType: raw.action || raw.event_type || '', clientPayload: raw.client_payload || {} };
  }
  return null;
}

module.exports = { readEntries, updateEntries, buildDispatchPayload, BRANCH_NAME, FILE_NAME };
