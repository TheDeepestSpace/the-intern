// Pure array-manipulation helpers over the pending-retries.json entry list.
// No git/filesystem I/O here (that lives in manage-pending-retries.js) so
// the retry-cap / dedup / due-time logic can be unit tested directly.

const DEFAULT_MAX_RETRIES = 3;

function findIndex(entries, key) {
  return entries.findIndex((e) => e.key === key);
}

// Called from the dispatcher/telegram-session failure path when a usage-limit
// stall is detected. Upserts by `key` (one entry per issue/PR or telegram
// chat) and never increments retryCount itself — only the poller does that,
// at the moment it actually re-fires a retry (see markFired below). If the
// existing entry already used up its retry budget, this is itself a retry
// that stalled again: report `exhausted` so the caller can alert the admin
// and stop, instead of silently re-queuing forever.
function upsertStall(entries, params, now = Date.now()) {
  const { key, maxRetries = DEFAULT_MAX_RETRIES } = params;
  const idx = findIndex(entries, key);
  const existing = idx === -1 ? null : entries[idx];

  if (existing && existing.retryCount >= maxRetries) {
    return {
      entries: entries.filter((e) => e.key !== key),
      entry: existing,
      isNew: false,
      exhausted: true,
    };
  }

  const nowIso = new Date(now).toISOString();
  const entry = {
    key,
    source: params.source,
    targetRepo: params.targetRepo || null,
    issueNumber: params.issueNumber || null,
    chatId: params.chatId || null,
    dispatch: params.dispatch,
    retryCount: existing ? existing.retryCount : 0,
    maxRetries,
    retryAfter: params.retryAfter,
    matchedText: params.matchedText || null,
    createdAt: existing ? existing.createdAt : nowIso,
    updatedAt: nowIso,
  };

  const nextEntries = existing
    ? entries.map((e) => (e.key === key ? entry : e))
    : [...entries, entry];

  return { entries: nextEntries, entry, isNew: !existing, exhausted: false };
}

// Called from the dispatcher/telegram-session success path. Removes the
// entry for `key` if present (meaning this run resumed from a queued
// retry) so the caller can send a "resumed" notification.
function resolveEntry(entries, key) {
  const idx = findIndex(entries, key);
  if (idx === -1) return { entries, removed: null };
  return { entries: entries.filter((e) => e.key !== key), removed: entries[idx] };
}

// Poller: entries whose retry_after has passed. No blind polling — only
// entries that are actually due come back.
function findDue(entries, now = Date.now()) {
  return entries.filter((e) => Date.parse(e.retryAfter) <= now);
}

// Poller: called right before re-firing a due entry's dispatch. Bumps
// retryCount and pushes retryAfter forward by `lockMs` as a lease so a
// second poller run within the same cycle can't double-fire the same entry
// while the re-fired job is still running.
function markFired(entries, key, { lockMs, now = Date.now() }) {
  const idx = findIndex(entries, key);
  if (idx === -1) return { entries, entry: null };
  const entry = {
    ...entries[idx],
    retryCount: entries[idx].retryCount + 1,
    retryAfter: new Date(now + lockMs).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  return { entries: entries.map((e) => (e.key === key ? entry : e)), entry };
}

// Poller defense-in-depth: an entry that is due but already at its retry cap
// (shouldn't normally happen, since upsertStall/markFired keep count <=
// maxRetries before ever re-queuing, but a run that fires without ever
// reaching the failure/success path — e.g. a killed runner — could leave
// one behind). Remove it and let the caller alert the admin.
function removeExhausted(entries, key) {
  const idx = findIndex(entries, key);
  if (idx === -1) return { entries, entry: null };
  return { entries: entries.filter((e) => e.key !== key), entry: entries[idx] };
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  upsertStall,
  resolveEntry,
  findDue,
  markFired,
  removeExhausted,
};
