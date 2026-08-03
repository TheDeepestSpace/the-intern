// Scheduled-workflow driver: reads pending-retries.json, re-fires the
// original dispatch payload for any entry that's due, and alerts the admin
// when an entry has used up its retry budget. No blind hourly polling —
// only entries whose retry_after has actually passed are touched.
const path = require('path');
const { execFileSync } = require('child_process');
const { readEntries, updateEntries } = require('./manage-pending-retries');
const { findDue, markFired, removeExhausted } = require('./pending-retries-store');

const DEFAULT_RETRY_LOCK_MINUTES = 25;

function resolveRetryLockMinutes(rawValue) {
  const parsed = Number(rawValue ?? DEFAULT_RETRY_LOCK_MINUTES);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`::warning::Ignoring invalid RETRY_LOCK_MINUTES="${rawValue}"; using ${DEFAULT_RETRY_LOCK_MINUTES}.`);
  return DEFAULT_RETRY_LOCK_MINUTES;
}

const LOCK_MS = resolveRetryLockMinutes(process.env.RETRY_LOCK_MINUTES) * 60 * 1000;

// Well beyond the */15 min cron cadence and the 25 min re-fire lock — an
// entry this overdue means multiple poll ticks were missed, not ordinary lateness.
const STALE_THRESHOLD_MINUTES = 120;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_MINUTES * 60 * 1000;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'the-intern-bot-usage-limit-poller',
    'Content-Type': 'application/json',
  };
}

const FETCH_TIMEOUT_MS = 30_000;

async function fireDispatch(dispatch, token, { owner, repo }) {
  if (dispatch.type === 'workflow_dispatch') {
    return fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${dispatch.workflow}/dispatches`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ ref: dispatch.ref, inputs: dispatch.inputs }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }
  if (dispatch.type === 'repository_dispatch') {
    return fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ event_type: dispatch.eventType, client_payload: dispatch.clientPayload }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }
  throw new Error(`Unknown dispatch type: ${dispatch.type}`);
}

function describeEntry(entry) {
  if (entry.targetRepo) return `${entry.targetRepo}${entry.issueNumber ? `#${entry.issueNumber}` : ''}`;
  if (entry.chatId) return `telegram chat ${entry.chatId}`;
  return entry.key;
}

function notifyAdmin(text) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'send-telegram.js'), text], {
      stdio: 'inherit',
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, CHAT_ID: process.env.TG_ADMIN_CHAT_ID },
    });
  } catch (err) {
    console.error(`Failed to send admin Telegram notification: ${err.message}`);
  }
}

// Processes one due entry: fires its dispatch and reports what happened, but
// leaves all persistence (markFired/removeExhausted) to the caller so a
// single poll tick's writes don't race each other over separate updateEntries
// calls sharing one fetched `entries` snapshot.
async function processEntry(entry, token, { owner, repo }, deps) {
  const { fireDispatch: fireDispatchFn, describeEntry: describeEntryFn } = deps;
  const label = describeEntryFn(entry);

  let res;
  let dispatchError = null;
  try {
    res = await fireDispatchFn(entry.dispatch, token, { owner, repo });
  } catch (err) {
    dispatchError = err;
  }

  // An unsupported dispatch type can never succeed on any retry — it's a
  // malformed entry, not a transient delivery failure.
  if (dispatchError && /^Unknown dispatch type/.test(dispatchError.message)) {
    console.error(`Failed to re-fire ${label}: ${dispatchError.message}`);
    return { label, outcome: 'invalid', error: dispatchError };
  }

  if (dispatchError) {
    console.error(`Failed to re-fire ${label}: ${dispatchError.message}`);
    return { label, outcome: 'failed' };
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to re-fire ${label} (${res.status}): ${body}`);
    return { label, outcome: 'failed' };
  }

  return { label, outcome: 'fired' };
}

async function main(deps = {}) {
  const {
    readEntries: readEntriesFn = readEntries,
    updateEntries: updateEntriesFn = updateEntries,
    fireDispatch: fireDispatchFn = fireDispatch,
    describeEntry: describeEntryFn = describeEntry,
    notifyAdmin: notifyAdminFn = notifyAdmin,
    env = process.env,
  } = deps;

  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    console.error('GH_TOKEN/GITHUB_TOKEN is required to re-fire dispatches.');
    process.exitCode = 1;
    return;
  }
  const [owner, repo] = (env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) {
    console.error('GITHUB_REPOSITORY must be set as owner/repo.');
    process.exitCode = 1;
    return;
  }

  const entries = readEntriesFn();
  const now = Date.now();
  const due = findDue(entries, now);
  console.log(`${due.length} of ${entries.length} pending retr${entries.length === 1 ? 'y is' : 'ies are'} due.`);

  // A schedule this stale means the poller itself was silently disabled or
  // starved (GitHub auto-disables `schedule` triggers after enough repo
  // inactivity) — surface that as a visible alert instead of just a very
  // late, otherwise-unremarkable resume.
  const stale = due.filter((entry) => now - Date.parse(entry.retryAfter) > STALE_THRESHOLD_MS);
  if (stale.length > 0) {
    notifyAdminFn(
      `⚠️ the-intern-bot: ${stale.length} pending retr${stale.length === 1 ? 'y is' : 'ies are'} over ${STALE_THRESHOLD_MINUTES} minutes overdue (${stale.map(describeEntryFn).join(', ')}) — check that the usage-limit poller's schedule is still enabled.`
    );
  }

  for (const entry of due) {
    if (entry.retryCount >= entry.maxRetries) {
      // Defense-in-depth: shouldn't normally happen (see pending-retries-store.js),
      // but don't let a stray entry poll forever.
      updateEntriesFn((current) => removeExhausted(current, entry.key));
      notifyAdminFn(
        `🛑 the-intern-bot: giving up auto-resuming ${describeEntryFn(entry)} after ${entry.retryCount} retries — this may be a genuine bug, not a usage-limit reset. Manual re-trigger needed.`
      );
      continue;
    }

    const result = await processEntry(entry, token, { owner, repo }, { fireDispatch: fireDispatchFn, describeEntry: describeEntryFn });

    if (result.outcome === 'invalid') {
      updateEntriesFn((current) => removeExhausted(current, entry.key));
      notifyAdminFn(
        `🛑 the-intern-bot: ${result.label} has an unsupported dispatch type and can never be re-fired. Removed from the queue — check pending-retries.json.`
      );
      continue;
    }

    if (result.outcome === 'failed') {
      // Bound a persistently-failing delivery the same way a fired attempt is
      // bounded, instead of leaving the entry due forever: bump retryCount and
      // push retryAfter forward as backoff. The exhausted-entry guard above
      // removes it and alerts once the budget runs out.
      updateEntriesFn((current) => markFired(current, entry.key, { lockMs: LOCK_MS }));
      continue;
    }

    updateEntriesFn((current) => markFired(current, entry.key, { lockMs: LOCK_MS }));
    console.log(`Re-fired ${result.label} (attempt ${entry.retryCount + 1}/${entry.maxRetries}).`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error in usage-limit poller:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { fireDispatch, describeEntry, main };
