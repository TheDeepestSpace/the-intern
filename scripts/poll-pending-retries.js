// Scheduled-workflow driver: reads pending-retries.json, re-fires the
// original dispatch payload for any entry that's due, and alerts the admin
// when an entry has used up its retry budget. No blind hourly polling —
// only entries whose retry_after has actually passed are touched.
const path = require('path');
const { execFileSync } = require('child_process');
const { readEntries, updateEntries } = require('./manage-pending-retries');
const { findDue, markFired, removeExhausted } = require('./pending-retries-store');

const LOCK_MS = Number(process.env.RETRY_LOCK_MINUTES || 25) * 60 * 1000;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'the-intern-bot-usage-limit-poller',
    'Content-Type': 'application/json',
  };
}

async function fireDispatch(dispatch, token, { owner, repo }) {
  if (dispatch.type === 'workflow_dispatch') {
    return fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${dispatch.workflow}/dispatches`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ ref: dispatch.ref, inputs: dispatch.inputs }),
    });
  }
  if (dispatch.type === 'repository_dispatch') {
    return fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ event_type: dispatch.eventType, client_payload: dispatch.clientPayload }),
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
      env: { ...process.env, CHAT_ID: process.env.TG_ADMIN_CHAT_ID },
    });
  } catch (err) {
    console.error(`Failed to send admin Telegram notification: ${err.message}`);
  }
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GH_TOKEN/GITHUB_TOKEN is required to re-fire dispatches.');
    process.exitCode = 1;
    return;
  }
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) {
    console.error('GITHUB_REPOSITORY must be set as owner/repo.');
    process.exitCode = 1;
    return;
  }

  const entries = readEntries();
  const due = findDue(entries, Date.now());
  console.log(`${due.length} of ${entries.length} pending retr${entries.length === 1 ? 'y is' : 'ies are'} due.`);

  for (const entry of due) {
    const label = describeEntry(entry);

    if (entry.retryCount >= entry.maxRetries) {
      // Defense-in-depth: shouldn't normally happen (see pending-retries-store.js),
      // but don't let a stray entry poll forever.
      updateEntries((current) => removeExhausted(current, entry.key));
      notifyAdmin(
        `🛑 the-intern-bot: giving up auto-resuming ${label} after ${entry.retryCount} retries — this may be a genuine bug, not a usage-limit reset. Manual re-trigger needed.`
      );
      continue;
    }

    let res;
    try {
      res = await fireDispatch(entry.dispatch, token, { owner, repo });
    } catch (err) {
      console.error(`Failed to re-fire ${label}: ${err.message}`);
      continue; // leave the entry as-is; the next poll cycle will retry firing it
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`Failed to re-fire ${label} (${res.status}): ${body}`);
      continue; // leave the entry as-is; the next poll cycle will retry firing it
    }

    updateEntries((current) => markFired(current, entry.key, { lockMs: LOCK_MS }));
    console.log(`Re-fired ${label} (attempt ${entry.retryCount + 1}/${entry.maxRetries}).`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error in usage-limit poller:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { fireDispatch, describeEntry };
