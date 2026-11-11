// Pure decision logic for the nightly crawl (issue #257): conflict-sweep
// dedupe, Dependabot PR classification (security vs regular), the 2-day
// "confirmed safe" clock, verdict parsing, CI-green checks, and the
// report text. No git, filesystem, or network I/O here — that lives in
// nightly-crawl.js (driver) and manage-nightly-crawl-state.js (persistence) —
// so every rule below can be unit tested directly.
const crypto = require('crypto');

const DEPENDABOT_LOGIN = 'dependabot[bot]';
const BOT_LOGIN = 'the-intern-bot[bot]';
const CONFIRMED_LABEL = 'dep-confirmed';
const SUSPICIOUS_LABEL = 'dep-suspicious';
const DAY_MS = 24 * 60 * 60 * 1000;
// A regular (non-security) update merges only once it has sat "confirmed
// safe" for at least this long — gives upstream a window to yank a bad
// release before it lands here.
const CONFIRMATION_DELAY_MS = 2 * DAY_MS;
// A conflict-fix / CI-fix dispatch for the same PR (and head sha) is not
// repeated within this window, and a failing head is only retried by the crawl
// once it has been red this long. Slightly under 24h so a daily cron whose run
// starts a few seconds earlier than the last one still counts as "a day later".
const CONFLICT_DEDUPE_MS = 20 * 60 * 60 * 1000;
const STALE_FAILURE_MS = CONFLICT_DEDUPE_MS;
const STATE_VERSION = 1;
// Dependabot maintenance nudges (rebase request / CI-fix dispatch): at most
// this many per PR, and a rebase request is not repeated within the window.
const MAX_REBASE_ATTEMPTS = 3;
const MAX_CI_FIX_ATTEMPTS = 3;
const REBASE_DEDUPE_MS = DAY_MS;

// Marker embedded in every comment the crawl posts, so a later run can tell
// its own comments apart from the agent's / humans' without parsing prose.
const COMMENT_MARKER = '<!-- the-intern-nightly-crawl -->';

function prKey(repo, number) {
  return `${repo}#${number}`;
}

function emptyState() {
  return { version: STATE_VERSION, conflicts: {}, botCi: {}, dependabot: {}, depActions: {} };
}

// Never falls back to an empty state on malformed input: the caller would
// commit that over the branch and lose every confirmation clock.
function parseState(raw) {
  if (!raw || !raw.trim()) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`nightly-crawl state is not valid JSON: ${err.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('nightly-crawl state must contain a JSON object.');
  }
  return {
    version: STATE_VERSION,
    conflicts: parsed.conflicts && typeof parsed.conflicts === 'object' ? parsed.conflicts : {},
    botCi: parsed.botCi && typeof parsed.botCi === 'object' ? parsed.botCi : {},
    dependabot: parsed.dependabot && typeof parsed.dependabot === 'object' ? parsed.dependabot : {},
    depActions: parsed.depActions && typeof parsed.depActions === 'object' ? parsed.depActions : {},
  };
}

function isDependabotPr(pr) {
  return (pr.user?.login || '').toLowerCase() === DEPENDABOT_LOGIN;
}

function isBotPr(pr, botLogin = BOT_LOGIN) {
  return (pr.user?.login || '').toLowerCase() === botLogin.toLowerCase();
}

// REST `mergeable_state: dirty` is the equivalent of GraphQL's
// `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY`. `mergeable === false`
// is checked too in case GitHub reports the boolean before the state string.
function isConflicting(pr) {
  return pr.mergeable_state === 'dirty' || pr.mergeable === false;
}

// ---------------------------------------------------------------- conflicts

// Dedupe for the conflict sweep: skip only when this crawl itself dispatched a
// fix for the PR within the window. Bot comments are deliberately ignored: a
// failed agent run leaves its own "conflict" comment behind, and that must not
// suppress the retry. (`botComments` is accepted for compatibility, unused.)
function shouldDispatchConflictFix({ key, state, now = Date.now() }) {
  const previous = state.conflicts?.[key];
  if (previous?.dispatchedAt && now - Date.parse(previous.dispatchedAt) < CONFLICT_DEDUPE_MS) {
    return { dispatch: false, reason: `conflict fix already dispatched at ${previous.dispatchedAt}` };
  }
  return { dispatch: true, reason: null };
}

function markConflictDispatched(state, key, now = Date.now()) {
  return {
    ...state,
    conflicts: { ...state.conflicts, [key]: { dispatchedAt: new Date(now).toISOString() } },
  };
}

// ------------------------------------------------------- bot PR CI failures

/**
 * Safety net for a bot PR whose head has been red for a while: the worker's
 * check_suite dispatch fires once per failure, so if that agent run died the
 * PR would stay red forever. Re-dispatch when the head commit is older than
 * STALE_FAILURE_MS and the crawl hasn't already dispatched for that sha within
 * the window. Bot comments are ignored, same as for conflicts.
 */
function shouldDispatchBotCiFix({ key, state, headSha, headDate, now = Date.now() }) {
  const t = Date.parse(headDate || '');
  if (!Number.isFinite(t) || now - t < STALE_FAILURE_MS) {
    return { dispatch: false, reason: 'head commit is recent; the worker path owns it' };
  }
  const previous = state.botCi?.[key];
  if (previous?.sha === headSha && now - Date.parse(previous.dispatchedAt) < CONFLICT_DEDUPE_MS) {
    return { dispatch: false, reason: `CI fix already dispatched at ${previous.dispatchedAt}` };
  }
  return { dispatch: true, reason: null };
}

function markBotCiDispatched(state, key, headSha, now = Date.now()) {
  return { ...state, botCi: { ...state.botCi, [key]: { sha: headSha, dispatchedAt: new Date(now).toISOString() } } };
}

// --------------------------------------------------------------- dependabot

// Pulls package / from / to out of Dependabot's PR title shapes:
//   "Bump foo from 1.2.3 to 1.2.4", "build(deps): bump foo from 1 to 2 in /x",
//   "Update foo requirement from ~=1.0 to ~=2.0", "Bump the npm group with 3 updates".
function parseDependabotTitle(title) {
  const text = String(title || '').trim();
  let m = text.match(/\b(?:bump|update)\s+(.+?)\s+(?:requirement\s+)?from\s+(\S+)\s+to\s+(\S+)/i);
  if (m) return { package: m[1], from: m[2], to: m[3] };
  m = text.match(/\b(?:bump|update)\s+(.+?)\s*$/i);
  if (m) return { package: m[1].replace(/\s+in\s+\/\S*$/i, ''), from: null, to: null };
  return { package: text || null, from: null, to: null };
}

// Security vs regular. Dependabot labels its security-advisory PRs with
// `security` by default; the body phrase is a belt-and-braces check, and an
// open Dependabot alert for the same package (when the alerts API is
// readable) catches repos that stripped the default labels. Deliberately
// does NOT match CVE/GHSA ids anywhere in the body — package changelogs
// routinely mention those for unrelated fixes, and misclassifying a regular
// bump as security skips the 2-day wait.
function classifyDependabotPr(pr, openAlerts = []) {
  const labels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name || '').toLowerCase());
  if (labels.includes('security')) return 'security';
  const body = `${pr.title || ''}\n${pr.body || ''}`;
  if (/dependabot security update/i.test(body)) return 'security';
  const { package: pkg } = parseDependabotTitle(pr.title);
  if (pkg && openAlerts.some((a) => (a.dependency?.package?.name || '').toLowerCase() === pkg.toLowerCase())) {
    return 'security';
  }
  return 'regular';
}

function computeDiffHash(diffText) {
  return crypto.createHash('sha256').update(String(diffText || ''), 'utf8').digest('hex');
}

// A stored verdict is reused only while the PR's diff is byte-identical to
// what was reviewed. Dependabot rebases change the head SHA without changing
// the diff, so the hash (not the SHA) is what gates a re-review.
function needsReview(record, diffHash) {
  if (!record || !record.verdict) return true;
  if (record.verdict !== 'safe' && record.verdict !== 'suspicious') return true;
  return record.diffHash !== diffHash;
}

const VERDICTS = new Set(['safe', 'suspicious']);

function extractJsonObjects(text) {
  const objects = [];
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < source.length; j++) {
      const ch = source[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            objects.push(JSON.parse(source.slice(i, j + 1)));
            // Parsed as a whole: don't re-scan the objects nested inside it.
            i = j;
          } catch {
            // not JSON — keep scanning from the next brace
          }
          break;
        }
      }
    }
  }
  return objects;
}

// The agent is asked to end with a JSON object {verdict, reasons, summary};
// this tolerates prose/code fences around it by taking the last JSON object
// that carries a `verdict`. Anything unparseable or outside safe/suspicious
// is an `error` verdict, which never merges and is re-reviewed next night.
function parseVerdict(text) {
  const candidates = extractJsonObjects(text).filter((o) => o && typeof o === 'object' && 'verdict' in o);
  const last = candidates[candidates.length - 1];
  if (!last) {
    return { verdict: 'error', reasons: ['agent output contained no JSON verdict'], summary: '' };
  }
  const verdict = String(last.verdict || '').trim().toLowerCase();
  if (!VERDICTS.has(verdict)) {
    return { verdict: 'error', reasons: [`unrecognized verdict "${last.verdict}"`], summary: String(last.summary || '') };
  }
  const reasons = Array.isArray(last.reasons) ? last.reasons.map((r) => String(r)).filter(Boolean) : [];
  return { verdict, reasons, summary: String(last.summary || '').trim() };
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

// "CI green" = every check run on the head commit completed without a
// failing conclusion and the legacy combined status isn't failing/pending.
// A commit with no checks at all is not green: there's nothing vouching for
// it, and auto-merging on "no CI ran" is exactly the gap this should close.
function isCiGreen({ checkRuns = [], combinedStatus = null } = {}) {
  const pending = checkRuns.filter((c) => c.status !== 'completed');
  if (pending.length > 0) {
    return { green: false, reason: `checks still running: ${pending.map((c) => c.name).join(', ')}` };
  }
  const failed = checkRuns.filter((c) => FAILED_CONCLUSIONS.has(c.conclusion));
  if (failed.length > 0) {
    return { green: false, reason: `failing checks: ${failed.map((c) => c.name).join(', ')}` };
  }
  const statusCount = combinedStatus?.total_count || 0;
  if (statusCount > 0) {
    if (combinedStatus.state === 'failure' || combinedStatus.state === 'error') {
      return { green: false, reason: `commit status ${combinedStatus.state}` };
    }
    if (combinedStatus.state === 'pending') {
      return { green: false, reason: 'commit status pending' };
    }
  }
  if (checkRuns.length === 0 && statusCount === 0) {
    return { green: false, reason: 'no CI checks found on head commit' };
  }
  return { green: true, reason: null };
}

// True only for a definite failure on the head commit. Running checks, or no
// checks at all, are not failures: there is nothing to investigate yet.
function isCiFailing({ checkRuns = [], combinedStatus = null } = {}) {
  if (checkRuns.some((c) => c.status === 'completed' && FAILED_CONCLUSIONS.has(c.conclusion))) return true;
  return combinedStatus?.total_count > 0 && (combinedStatus.state === 'failure' || combinedStatus.state === 'error');
}

const CI_FAILURE_MARKER = '<!-- the-intern-nightly-crawl:ci-failure -->';

// Conclusions that say "the run didn't give a verdict" (infra, timeout,
// cancelled, needs approval) rather than "the code is broken": a rerun is the
// remedy, so they never dispatch the agent.
const RERUNNABLE_CONCLUSIONS = new Set(['timed_out', 'cancelled', 'startup_failure', 'stale', 'action_required']);

/**
 * Splits the head commit's failures into `failing` (a definite failure an
 * agent could fix) and `rerunnable` (infra/flaky-looking). Legacy commit
 * statuses in failure/error state count as failing.
 */
function classifyCiFailures({ checkRuns = [], combinedStatus = null } = {}) {
  const done = checkRuns.filter((c) => c.status === 'completed');
  const failing = done.filter((c) => c.conclusion === 'failure').map((c) => c.name);
  const rerunnable = done.filter((c) => RERUNNABLE_CONCLUSIONS.has(c.conclusion)).map((c) => c.name);
  if (combinedStatus?.total_count > 0) {
    for (const st of combinedStatus.statuses || []) {
      if (st.state === 'failure' || st.state === 'error') failing.push(st.context);
    }
    if ((combinedStatus.state === 'failure' || combinedStatus.state === 'error') && !(combinedStatus.statuses || []).length) {
      failing.push('commit status');
    }
  }
  return { failing, rerunnable };
}

/** Builds the comment body asking the bot to fix the listed failing checks on `sha`. */
function ciFailureComment({ checks = [], sha = '' } = {}) {
  const names = checks.length ? ` Failing check${checks.length === 1 ? '' : 's'}: ${checks.map((c) => `\`${c}\``).join(', ')}.` : '';
  const at = sha ? ` (head ${sha.slice(0, 7)})` : '';
  return `${CI_FAILURE_MARKER}\n@the-intern-bot CI is failing on this Dependabot PR${at}.${names} Please investigate the failure and push a fix to this branch if it is caused by the dependency update.`;
}

// Kept for callers that only want to know whether the crawl ever asked.
function hasCiFailureRequest(comments = []) {
  return comments.some((c) => (c.body || '').includes(CI_FAILURE_MARKER));
}

/** True if the PR needs Dependabot to rebase it: behind base or conflicting. */
function needsRebase(pr) {
  return pr.mergeable_state === 'behind' || isConflicting(pr);
}

const REBASE_COMMENT = '@dependabot rebase';

/**
 * `action` is the PR's depActions record: { rebaseAttempts, lastRebaseAt }.
 */
function shouldRequestRebase({ action = {}, now = Date.now() }) {
  const attempts = action.rebaseAttempts || 0;
  if (attempts >= MAX_REBASE_ATTEMPTS) return { request: false, reason: `rebase attempt cap reached (${attempts})` };
  if (action.lastRebaseAt && now - Date.parse(action.lastRebaseAt) < REBASE_DEDUPE_MS) {
    return { request: false, reason: `rebase already requested at ${action.lastRebaseAt}` };
  }
  return { request: true, reason: null };
}

/**
 * Once per head SHA, at most MAX_CI_FIX_ATTEMPTS in total per PR. `action`
 * holds { ciFixAttempts, ciFixShas: [...] }.
 */
function shouldDispatchCiFix({ action = {}, headSha, now = Date.now() }) {
  // A sha only blocks while the last dispatch is recent; after that the failed
  // attempt is presumed dead and retried (the attempt cap is the loop guard).
  const recent = action.lastCiFixAt && now - Date.parse(action.lastCiFixAt) < CONFLICT_DEDUPE_MS;
  if (recent && (action.ciFixShas || []).includes(headSha)) return { dispatch: false, reason: `already dispatched for ${headSha}` };
  if ((action.ciFixAttempts || 0) >= MAX_CI_FIX_ATTEMPTS) return { dispatch: false, reason: `CI-fix attempt cap reached (${action.ciFixAttempts})` };
  return { dispatch: true, reason: null };
}

/** Returns a new state with `depActions[key]` replaced by `fn(existing)`. */
function patchAction(state, key, fn) {
  const existing = state.depActions?.[key] || {};
  return { ...state, depActions: { ...state.depActions, [key]: fn(existing) } };
}

/** Records a rebase request (attempt count and timestamp) for the PR `key`. */
function markRebaseRequested(state, key, now = Date.now()) {
  return patchAction(state, key, (a) => ({ ...a, rebaseAttempts: (a.rebaseAttempts || 0) + 1, lastRebaseAt: new Date(now).toISOString() }));
}

/**
 * The PR no longer needs a rebase: forget the attempts so a later conflict
 * starts with a fresh budget.
 */
function clearRebaseState(state, key) {
  const existing = state.depActions?.[key];
  if (!existing || (!existing.rebaseAttempts && !existing.lastRebaseAt)) return state;
  const { rebaseAttempts, lastRebaseAt, ...rest } = existing;
  return { ...state, depActions: { ...state.depActions, [key]: rest } };
}

/** Records a CI-fix dispatch for `headSha` against the PR `key`. */
function markCiFixDispatched(state, key, headSha, now = Date.now()) {
  return patchAction(state, key, (a) => ({
    ...a,
    ciFixAttempts: (a.ciFixAttempts || 0) + 1,
    ciFixShas: [...(a.ciFixShas || []), headSha],
    lastCiFixAt: new Date(now).toISOString(),
  }));
}

const MERGEABLE_STATES_OK = new Set(['clean', 'has_hooks']);

// The single decision table for a reviewed Dependabot PR. `record` is the
// persisted state entry (already updated with this run's verdict).
function decideDependabotAction({ record, classification, ci, mergeableState, now = Date.now() }) {
  if (!record || !record.verdict || record.verdict === 'error') {
    return { action: 'skip', reason: 'no usable review verdict' };
  }
  if (record.verdict === 'suspicious') {
    if (record.flaggedDiffHash === record.diffHash) {
      return { action: 'skip', reason: 'already flagged as suspicious for this diff' };
    }
    return { action: 'flag', reason: 'review verdict: suspicious' };
  }
  if (!ci?.green) {
    return { action: 'wait', reason: ci?.reason || 'CI not green' };
  }
  if (classification === 'security') {
    if (!MERGEABLE_STATES_OK.has(mergeableState)) {
      return { action: 'wait', reason: `not mergeable (${mergeableState || 'unknown'})` };
    }
    return { action: 'merge', reason: 'security update, verdict safe, CI green' };
  }
  if (!record.confirmedAt) {
    return { action: 'confirm', reason: 'regular update, verdict safe, CI green — starting 2-day clock' };
  }
  const elapsed = now - Date.parse(record.confirmedAt);
  if (elapsed < CONFIRMATION_DELAY_MS) {
    const readyAt = new Date(Date.parse(record.confirmedAt) + CONFIRMATION_DELAY_MS).toISOString();
    return { action: 'wait', reason: `confirmed safe at ${record.confirmedAt}; eligible to merge after ${readyAt}` };
  }
  if (!MERGEABLE_STATES_OK.has(mergeableState)) {
    return { action: 'wait', reason: `not mergeable (${mergeableState || 'unknown'})` };
  }
  return { action: 'merge', reason: 'regular update, confirmed safe ≥ 2 days ago, CI green' };
}

// Stores a fresh verdict for `key`. A changed diff resets the confirmation
// clock and the "already flagged" marker, since both were about the old diff.
function applyVerdict(state, key, { diffHash, headSha, verdict, reasons = [], summary = '', classification, now = Date.now() }) {
  const existing = state.dependabot?.[key] || {};
  const diffChanged = existing.diffHash && existing.diffHash !== diffHash;
  const record = {
    ...existing,
    diffHash,
    headSha,
    verdict,
    reasons,
    summary,
    classification,
    reviewedAt: new Date(now).toISOString(),
    confirmedAt: diffChanged ? null : existing.confirmedAt || null,
    flaggedDiffHash: diffChanged ? null : existing.flaggedDiffHash || null,
  };
  return { ...state, dependabot: { ...state.dependabot, [key]: record } };
}

function markConfirmed(state, key, now = Date.now()) {
  const existing = state.dependabot?.[key];
  if (!existing) return state;
  return {
    ...state,
    dependabot: { ...state.dependabot, [key]: { ...existing, confirmedAt: new Date(now).toISOString() } },
  };
}

function markFlagged(state, key, now = Date.now()) {
  const existing = state.dependabot?.[key];
  if (!existing) return state;
  return {
    ...state,
    dependabot: {
      ...state.dependabot,
      [key]: { ...existing, flaggedDiffHash: existing.diffHash, flaggedAt: new Date(now).toISOString() },
    },
  };
}

// Drops entries for PRs that are no longer open (merged, closed, or gone) so
// the file doesn't grow forever. Only keys belonging to a repo this run
// actually crawled (`crawledRepos`) are eligible: a run limited to a subset
// of repos, or one where listing a repo failed, must not wipe the other
// repos' confirmation clocks.
function pruneState(state, openKeys, crawledRepos) {
  const keep = new Set(openKeys);
  const crawled = new Set(crawledRepos);
  const repoOf = (key) => key.slice(0, key.lastIndexOf('#'));
  const filter = (obj) => Object.fromEntries(
    Object.entries(obj || {}).filter(([k]) => keep.has(k) || !crawled.has(repoOf(k)))
  );
  return { ...state, conflicts: filter(state.conflicts), botCi: filter(state.botCi), dependabot: filter(state.dependabot), depActions: filter(state.depActions) };
}

// ------------------------------------------------------------------- report

function describeUpdate(item) {
  const range = item.from && item.to ? ` ${item.from} → ${item.to}` : '';
  return `${item.package || item.title}${range}`;
}

function formatLine(item) {
  const kind = item.classification === 'security' ? 'security' : 'regular';
  const note = item.summary ? ` — ${item.summary}` : '';
  return `- ${item.key}: ${describeUpdate(item)} [${kind}]${note}\n  ${item.url}`;
}

function formatReasons(item) {
  const reasons = (item.reasons || []).length ? item.reasons : [item.reason || 'no reason given'];
  return reasons.map((r) => `    • ${r}`).join('\n');
}

// Builds the owner-facing report. `shouldSend` is false when the night was
// a no-op (nothing merged, flagged, confirmed, or dispatched); `flagOnly`
// marks a night where the only news is something suspicious.
function buildReport(events, { runUrl = '', date = new Date() } = {}) {
  const merged = events.merged || [];
  const flagged = events.flagged || [];
  const confirmed = events.confirmed || [];
  const pending = events.pending || [];
  const errors = events.errors || [];
  const conflicts = events.conflicts || [];
  const rebases = events.rebases || [];
  const ciFixes = events.ciFixes || [];
  const dateLabel = new Date(date).toISOString().slice(0, 10);
  const shouldSend = merged.length + flagged.length + confirmed.length + conflicts.length + rebases.length + ciFixes.length > 0;
  const flagOnly = flagged.length > 0 && merged.length + confirmed.length + conflicts.length + rebases.length + ciFixes.length === 0;

  const subjectParts = [];
  if (merged.length) subjectParts.push(`${merged.length} merged`);
  if (flagged.length) subjectParts.push(`${flagged.length} suspicious`);
  if (confirmed.length) subjectParts.push(`${confirmed.length} confirmed`);
  if (conflicts.length) subjectParts.push(`${conflicts.length} conflict fix${conflicts.length === 1 ? '' : 'es'}`);
  if (rebases.length) subjectParts.push(`${rebases.length} rebase${rebases.length === 1 ? '' : 's'} requested`);
  if (ciFixes.length) subjectParts.push(`${ciFixes.length} CI fix${ciFixes.length === 1 ? '' : 'es'} dispatched`);
  const subject = `[the-intern] nightly crawl ${dateLabel}: ${subjectParts.join(', ') || 'nothing to report'}`;

  const sections = [];
  if (flagged.length) {
    sections.push(`⚠️ SUSPICIOUS — not merged (${flagged.length})\n${flagged.map((i) => `${formatLine(i)}\n${formatReasons(i)}`).join('\n')}`);
  }
  if (merged.length) {
    sections.push(`✅ Merged (${merged.length})\n${merged.map(formatLine).join('\n')}`);
  }
  if (confirmed.length) {
    sections.push(`🕑 Confirmed safe, merge after 2 days (${confirmed.length})\n${confirmed.map(formatLine).join('\n')}`);
  }
  if (conflicts.length) {
    sections.push(`🔧 Conflict fixes dispatched (${conflicts.length})\n${conflicts.map((c) => `- ${c.key}\n  ${c.url}`).join('\n')}`);
  }
  if (rebases.length) {
    sections.push(`🔁 @dependabot rebase requested (${rebases.length})\n${rebases.map((c) => `- ${c.key} (${c.reason})\n  ${c.url}`).join('\n')}`);
  }
  if (ciFixes.length) {
    sections.push(`🩹 CI failure dispatched to the-intern (${ciFixes.length})\n${ciFixes.map((c) => `- ${c.key}: ${(c.checks || []).join(', ') || 'failing checks'}\n  ${c.url}`).join('\n')}`);
  }
  if (pending.length) {
    sections.push(`⏳ Waiting (${pending.length})\n${pending.map((i) => `- ${i.key}: ${describeUpdate(i)} — ${i.reason}`).join('\n')}`);
  }
  if (errors.length) {
    sections.push(`❌ Errors (${errors.length})\n${errors.map((e) => `- ${e.key}: ${e.reason}`).join('\n')}`);
  }
  const footer = runUrl ? `\nRun: ${runUrl}` : '';
  const text = `${subject}\n\n${sections.join('\n\n')}${footer}\n`;

  const telegram = [
    `🌙 the-intern nightly crawl ${dateLabel}`,
    merged.length ? `✅ merged: ${merged.map((i) => `${i.key} (${describeUpdate(i)})`).join(', ')}` : null,
    flagged.length ? `⚠️ suspicious: ${flagged.map((i) => `${i.key} (${describeUpdate(i)})`).join(', ')}` : null,
    confirmed.length ? `🕑 confirmed: ${confirmed.map((i) => i.key).join(', ')}` : null,
    conflicts.length ? `🔧 conflict fixes: ${conflicts.map((c) => c.key).join(', ')}` : null,
    rebases.length ? `🔁 rebase requested: ${rebases.map((c) => c.key).join(', ')}` : null,
    ciFixes.length ? `🩹 CI fix dispatched: ${ciFixes.map((c) => c.key).join(', ')}` : null,
    errors.length ? `❌ errors: ${errors.length}` : null,
    runUrl ? `Run: ${runUrl}` : null,
  ].filter(Boolean).join('\n');

  return { subject, text, html: `<pre>${escapeHtml(text)}</pre>`, telegram, shouldSend, flagOnly };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Comment bodies posted on the PRs themselves.
function confirmationComment(record, now = Date.now()) {
  const readyAt = new Date(now + CONFIRMATION_DELAY_MS).toISOString().slice(0, 16).replace('T', ' ');
  const summary = record.summary ? `\n\n> ${record.summary}` : '';
  return `${COMMENT_MARKER}\nNightly crawl: reviewed this update and found no malicious indicators (verdict: **safe**). Labeled \`${CONFIRMED_LABEL}\`; will auto-merge no earlier than ${readyAt} UTC if CI stays green and the diff is unchanged.${summary}`;
}

function suspiciousComment(record) {
  const reasons = (record.reasons || []).map((r) => `- ${r}`).join('\n') || '- (no reasons given)';
  const summary = record.summary ? `\n\n> ${record.summary}` : '';
  return `${COMMENT_MARKER}\nNightly crawl: **not auto-merging** — the review flagged this update as suspicious:\n${reasons}${summary}\n\nPlease review manually. Labeled \`${SUSPICIOUS_LABEL}\`.`;
}

module.exports = {
  DEPENDABOT_LOGIN,
  BOT_LOGIN,
  CONFIRMED_LABEL,
  SUSPICIOUS_LABEL,
  CONFIRMATION_DELAY_MS,
  CONFLICT_DEDUPE_MS,
  COMMENT_MARKER,
  prKey,
  emptyState,
  parseState,
  isDependabotPr,
  isBotPr,
  isConflicting,
  shouldDispatchConflictFix,
  markConflictDispatched,
  shouldDispatchBotCiFix,
  markBotCiDispatched,
  STALE_FAILURE_MS,
  parseDependabotTitle,
  classifyDependabotPr,
  computeDiffHash,
  needsReview,
  parseVerdict,
  isCiGreen,
  isCiFailing,
  classifyCiFailures,
  needsRebase,
  REBASE_COMMENT,
  MAX_REBASE_ATTEMPTS,
  MAX_CI_FIX_ATTEMPTS,
  shouldRequestRebase,
  shouldDispatchCiFix,
  markRebaseRequested,
  clearRebaseState,
  markCiFixDispatched,
  CI_FAILURE_MARKER,
  ciFailureComment,
  hasCiFailureRequest,
  decideDependabotAction,
  applyVerdict,
  markConfirmed,
  markFlagged,
  pruneState,
  buildReport,
  confirmationComment,
  suspiciousComment,
};
