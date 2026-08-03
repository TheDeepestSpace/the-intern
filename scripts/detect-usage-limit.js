// Detects a Claude usage-limit (subscription quota) stall from the text the
// dispatcher/telegram-session jobs already capture (session_result.txt /
// the raw claude CLI stdout), and estimates when it's safe to retry.
//
// Provenance (issue #100's "first slice"): `claude -p ... --output-format
// json` has no dedicated result subtype for this — a live capture wasn't
// available, so this was grounded by inspecting the installed claude-code
// CLI binary (v2.1.220) for the literal strings it actually emits. Its
// non-interactive `result` subtype is one of error_during_execution /
// error_max_turns / error_max_budget_usd / error_max_structured_output_retries
// (no usage-limit-specific subtype), so a stall surfaces as
// error_during_execution with the underlying error folded into the
// `result`/`errors` text. Confirmed literal phrases in the binary:
// "usage limit reached", "usage limit reached — check plan", "reached your
// specified...usage limits", "usage_cap_reached", "org's monthly usage
// limit", "group's usage limit is set to $0", and the "session limit" /
// "weekly limit" labels for the 5-hour/7-day subscription windows. None of
// these came with a machine-parseable reset timestamp in the CLI's textual
// output (the raw `resets_at` field only appears in the interactive
// statusline JSON, not stdout) — `parseRetryAfterMs` below is deliberately
// layered with fallbacks for that reason and should be tightened once a
// real non-interactive capture exists.
//
// Deliberately excludes generic `rate_limit_error` / 429 text: the Anthropic
// SDK already retries those with backoff, so if one still surfaces here it's
// more likely a genuine transient failure than a multi-hour quota stall.
//
// The "you've hit your ... limit" pattern below is the literal, live-captured
// `result` text (job run 30848127490, two separate stalls on the same PR:
// "You've hit your session limit · resets 6:20pm (UTC)" and "... resets
// 11:20pm (UTC)") — none of the speculative binary-derived patterns above it
// match this phrasing (no "reached" verb), so real stalls fell through to
// the generic failure path instead of queuing a retry.
const USAGE_LIMIT_PATTERNS = [
  /\busage[\s-]?(?:limit|credit limit|cap)s?\s+(?:reached|exceeded)\b/i,
  /reached\s+(?:your\s+)?(?:specified[\w\s-]*?)?usage\s+limits?\b/i,
  /\b(?:5-hour|five-hour|session|weekly|monthly)\s+limit\s+reached\b/i,
  /\busage_cap_reached\b/i,
  /org'?s monthly usage limit/i,
  /group'?s usage limit is set to \$0/i,
  /you'?ve hit your (?:5-hour|five-hour|session|weekly|monthly) limit\b/i,
];

const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000; // 1 hour fallback when no reset time can be parsed.
const MIN_RETRY_DELAY_MS = 5 * 60 * 1000; // never schedule a retry in the past or immediately.

function detectUsageLimit(text, now = Date.now()) {
  if (!text) return null;
  for (const pattern of USAGE_LIMIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        matchedText: match[0],
        retryAfter: new Date(parseRetryAfterMs(text, now)).toISOString(),
      };
    }
  }
  return null;
}

function parseRetryAfterMs(text, now) {
  // Guarded so a stale epoch, an already-elapsed reset timestamp, or "retry
  // after 0" can never resolve to now (or the past) — findDue in
  // pending-retries-store.js would treat that as immediately due and the
  // poller would re-fire while the usage limit is still active.
  return Math.max(parseRetryAfterMsRaw(text, now), now + MIN_RETRY_DELAY_MS);
}

function parseRetryAfterMsRaw(text, now) {
  // 1. Explicit epoch, e.g. "reached|1735689600" (possible future CLI shape,
  // modeled after the community-documented "Claude AI usage limit
  // reached|<epoch>" pattern seen in other Claude Code tooling).
  let m = text.match(/reached\|(\d{10,13})\b/);
  if (m) {
    const n = Number(m[1]);
    return n > 1e12 ? n : n * 1000;
  }

  // 2. ISO-8601 timestamp near the word "reset(s)".
  m = text.match(/resets?\D{0,15}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i);
  if (m) {
    const parsed = Date.parse(m[1]);
    if (!Number.isNaN(parsed)) return parsed;
  }

  // 3. Human clock time, e.g. "resets at 3pm" / "resets 3:00 PM" — the shape
  // the interactive CLI actually renders (see module docstring).
  m = text.match(/resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (m) {
    const parsed = parseClockTime(m[1], now);
    if (parsed !== null) return parsed;
  }

  // 4. Explicit retry-after seconds, e.g. "retry after 3600 seconds".
  m = text.match(/retry[\s-]?after[:\s]+(\d+)/i);
  if (m) return now + Number(m[1]) * 1000;

  return now + DEFAULT_RETRY_DELAY_MS;
}

function parseClockTime(clock, now) {
  const m = clock.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  const minute = m[2] ? Number(m[2]) : 0;

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  // The parsed clock time may already be in the past today (e.g. "resets
  // 3pm" read at 5pm) — a stall's reset is always in the future, so roll to
  // tomorrow.
  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

module.exports = { detectUsageLimit, parseRetryAfterMs, USAGE_LIMIT_PATTERNS };
