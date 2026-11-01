import { describe, it, expect } from 'vitest';
import {
  CONFIRMATION_DELAY_MS,
  CONFLICT_DEDUPE_MS,
  CONFIRMED_LABEL,
  SUSPICIOUS_LABEL,
  COMMENT_MARKER,
  emptyState,
  parseState,
  isDependabotPr,
  isBotPr,
  isConflicting,
  shouldDispatchConflictFix,
  markConflictDispatched,
  parseDependabotTitle,
  classifyDependabotPr,
  computeDiffHash,
  needsReview,
  parseVerdict,
  isCiGreen,
  decideDependabotAction,
  applyVerdict,
  markConfirmed,
  markFlagged,
  pruneState,
  buildReport,
  confirmationComment,
  suspiciousComment,
} from '../nightly-crawl-store.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-01T04:30:00Z');

describe('parseState', () => {
  it('returns an empty state for a missing file', () => {
    expect(parseState('')).toEqual(emptyState());
    expect(parseState(undefined)).toEqual(emptyState());
  });

  it('throws on malformed JSON instead of silently resetting every clock', () => {
    expect(() => parseState('{not json')).toThrow(/not valid JSON/);
    expect(() => parseState('[]')).toThrow(/JSON object/);
  });

  it('fills in missing sections', () => {
    expect(parseState('{"dependabot":{"a/b#1":{"verdict":"safe"}}}')).toEqual({
      version: 1,
      conflicts: {},
      dependabot: { 'a/b#1': { verdict: 'safe' } },
    });
  });
});

describe('PR predicates', () => {
  it('identifies dependabot and bot PRs by author login, case-insensitively', () => {
    expect(isDependabotPr({ user: { login: 'dependabot[bot]' } })).toBe(true);
    expect(isDependabotPr({ user: { login: 'Dependabot[bot]' } })).toBe(true);
    expect(isDependabotPr({ user: { login: 'the-intern-bot[bot]' } })).toBe(false);
    expect(isBotPr({ user: { login: 'the-intern-bot[bot]' } })).toBe(true);
    expect(isBotPr({ user: { login: 'someone' } })).toBe(false);
    expect(isBotPr({})).toBe(false);
  });

  it('treats dirty mergeable_state or mergeable=false as conflicting', () => {
    expect(isConflicting({ mergeable_state: 'dirty', mergeable: false })).toBe(true);
    expect(isConflicting({ mergeable_state: 'unknown', mergeable: false })).toBe(true);
    expect(isConflicting({ mergeable_state: 'clean', mergeable: true })).toBe(false);
    expect(isConflicting({ mergeable_state: 'blocked', mergeable: true })).toBe(false);
  });
});

describe('shouldDispatchConflictFix', () => {
  const key = 'acme/widgets#7';

  it('dispatches when nothing recent is on record', () => {
    expect(shouldDispatchConflictFix({ key, state: emptyState(), now: NOW })).toEqual({ dispatch: true, reason: null });
  });

  it('skips when this crawl dispatched a fix within 24h', () => {
    const state = markConflictDispatched(emptyState(), key, NOW - 6 * HOUR);
    const result = shouldDispatchConflictFix({ key, state, now: NOW });
    expect(result.dispatch).toBe(false);
    expect(result.reason).toMatch(/already dispatched/);
  });

  it('dispatches again once the dedupe window has passed', () => {
    const state = markConflictDispatched(emptyState(), key, NOW - CONFLICT_DEDUPE_MS - 1);
    expect(shouldDispatchConflictFix({ key, state, now: NOW }).dispatch).toBe(true);
  });

  it('skips when the bot already commented about conflicts within 24h', () => {
    const botComments = [
      { user: { login: 'the-intern-bot[bot]' }, created_at: new Date(NOW - 2 * HOUR).toISOString(), body: 'Resolved the merge conflicts and pushed.' },
    ];
    const result = shouldDispatchConflictFix({ key, state: emptyState(), botComments, now: NOW });
    expect(result.dispatch).toBe(false);
    expect(result.reason).toMatch(/bot already commented/);
  });

  it('ignores old bot comments, other authors, and unrelated bot comments', () => {
    const botComments = [
      { user: { login: 'the-intern-bot[bot]' }, created_at: new Date(NOW - 3 * DAY).toISOString(), body: 'conflicts resolved' },
      { user: { login: 'human' }, created_at: new Date(NOW - HOUR).toISOString(), body: 'please fix the conflicts' },
      { user: { login: 'the-intern-bot[bot]' }, created_at: new Date(NOW - HOUR).toISOString(), body: 'Opened PR.' },
    ];
    expect(shouldDispatchConflictFix({ key, state: emptyState(), botComments, now: NOW }).dispatch).toBe(true);
  });
});

describe('parseDependabotTitle', () => {
  it.each([
    ['Bump undici from 7.29.1 to 7.30.0', { package: 'undici', from: '7.29.1', to: '7.30.0' }],
    ['build(deps-dev): bump vitest from 5.0.0 to 5.1.0 in /worker', { package: 'vitest', from: '5.0.0', to: '5.1.0' }],
    ['Bump actions/checkout from 6 to 7', { package: 'actions/checkout', from: '6', to: '7' }],
    ['Update requests requirement from ~=2.31 to ~=2.32', { package: 'requests', from: '~=2.31', to: '~=2.32' }],
    ['Bump the npm_and_yarn group with 3 updates', { package: 'the npm_and_yarn group with 3 updates', from: null, to: null }],
    ['Bump foo and bar in /docker', { package: 'foo and bar', from: null, to: null }],
    ['', { package: null, from: null, to: null }],
  ])('parses %j', (title, expected) => {
    expect(parseDependabotTitle(title)).toEqual(expected);
  });
});

describe('classifyDependabotPr', () => {
  it('is security when the security label is present', () => {
    expect(classifyDependabotPr({ title: 'Bump x from 1 to 2', labels: [{ name: 'dependencies' }, { name: 'Security' }] })).toBe('security');
    expect(classifyDependabotPr({ title: 'Bump x from 1 to 2', labels: ['security'] })).toBe('security');
  });

  it('is security when the body says it is a Dependabot security update', () => {
    expect(classifyDependabotPr({ title: 'Bump x from 1 to 2', body: 'This is a Dependabot security update.' })).toBe('security');
  });

  it('is security when an open Dependabot alert names the same package', () => {
    const alerts = [{ dependency: { package: { name: 'Undici' } } }];
    expect(classifyDependabotPr({ title: 'Bump undici from 7.29.1 to 7.30.0', labels: [] }, alerts)).toBe('security');
    expect(classifyDependabotPr({ title: 'Bump vitest from 5.0.0 to 5.1.0', labels: [] }, alerts)).toBe('regular');
  });

  it('does not treat a CVE mention in release notes as a security update', () => {
    expect(classifyDependabotPr({ title: 'Bump x from 1 to 2', body: 'Release notes: fixes CVE-2024-1234 in an unrelated module' })).toBe('regular');
  });

  it('defaults to regular', () => {
    expect(classifyDependabotPr({ title: 'Bump x from 1 to 2', labels: [{ name: 'dependencies' }] })).toBe('regular');
  });
});

describe('needsReview / computeDiffHash', () => {
  const hash = computeDiffHash('diff --git a b');

  it('hashes deterministically', () => {
    expect(hash).toBe(computeDiffHash('diff --git a b'));
    expect(hash).not.toBe(computeDiffHash('diff --git a c'));
  });

  it('needs review without a record or usable verdict', () => {
    expect(needsReview(undefined, hash)).toBe(true);
    expect(needsReview({ diffHash: hash }, hash)).toBe(true);
    expect(needsReview({ diffHash: hash, verdict: 'error' }, hash)).toBe(true);
  });

  it('reuses a verdict while the diff hash is unchanged, regardless of head sha', () => {
    expect(needsReview({ diffHash: hash, verdict: 'safe', headSha: 'old' }, hash)).toBe(false);
    expect(needsReview({ diffHash: hash, verdict: 'suspicious' }, hash)).toBe(false);
    expect(needsReview({ diffHash: 'other', verdict: 'safe' }, hash)).toBe(true);
  });
});

describe('parseVerdict', () => {
  it('parses a bare JSON verdict', () => {
    expect(parseVerdict('{"verdict":"safe","reasons":["same maintainer","no install scripts"],"summary":"routine"}')).toEqual({
      verdict: 'safe',
      reasons: ['same maintainer', 'no install scripts'],
      summary: 'routine',
    });
  });

  it('tolerates prose and code fences around the JSON, taking the last verdict object', () => {
    const text = 'Checked {"verdict":"safe"} earlier but then:\n```json\n{"verdict": "Suspicious", "reasons": ["new postinstall script"], "summary": "nope"}\n```\nDone.';
    expect(parseVerdict(text)).toEqual({ verdict: 'suspicious', reasons: ['new postinstall script'], summary: 'nope' });
  });

  it('returns an error verdict when no JSON verdict is present or the value is unknown', () => {
    expect(parseVerdict('I think it is fine.').verdict).toBe('error');
    expect(parseVerdict('{"verdict":"maybe"}')).toEqual({ verdict: 'error', reasons: ['unrecognized verdict "maybe"'], summary: '' });
    expect(parseVerdict('{"foo": {"verdict": "safe"}, "bar": "{"}').verdict).toBe('error');
  });

  it('survives braces inside strings', () => {
    expect(parseVerdict('{"verdict":"safe","reasons":["code like { } here"],"summary":"ok"}').reasons).toEqual(['code like { } here']);
  });
});

describe('isCiGreen', () => {
  it('is green when every check completed successfully', () => {
    const result = isCiGreen({ checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }] });
    expect(result).toEqual({ green: true, reason: null });
  });

  it('is not green while checks are running', () => {
    expect(isCiGreen({ checkRuns: [{ name: 'test', status: 'in_progress', conclusion: null }] }).reason).toMatch(/still running: test/);
  });

  it('is not green when any check failed', () => {
    expect(isCiGreen({ checkRuns: [{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'failure' }] }).reason).toMatch(/failing checks: b/);
  });

  it('honours the legacy combined status', () => {
    const ok = [{ name: 'a', status: 'completed', conclusion: 'success' }];
    expect(isCiGreen({ checkRuns: ok, combinedStatus: { state: 'failure', total_count: 1 } }).reason).toMatch(/status failure/);
    expect(isCiGreen({ checkRuns: ok, combinedStatus: { state: 'pending', total_count: 1 } }).reason).toMatch(/pending/);
    expect(isCiGreen({ checkRuns: [], combinedStatus: { state: 'success', total_count: 2 } }).green).toBe(true);
  });

  it('is not green when no CI ran at all', () => {
    expect(isCiGreen({ checkRuns: [], combinedStatus: { state: 'pending', total_count: 0 } }).reason).toMatch(/no CI checks/);
    expect(isCiGreen({}).green).toBe(false);
  });
});

describe('decideDependabotAction', () => {
  const green = { green: true, reason: null };
  const red = { green: false, reason: 'failing checks: test' };
  const safe = { verdict: 'safe', diffHash: 'h', confirmedAt: null, flaggedDiffHash: null };

  it('skips without a usable verdict', () => {
    expect(decideDependabotAction({ record: undefined, classification: 'security', ci: green, mergeableState: 'clean', now: NOW }).action).toBe('skip');
    expect(decideDependabotAction({ record: { verdict: 'error' }, classification: 'security', ci: green, mergeableState: 'clean', now: NOW }).action).toBe('skip');
  });

  it('flags suspicious once per diff and never merges it', () => {
    const suspicious = { ...safe, verdict: 'suspicious' };
    expect(decideDependabotAction({ record: suspicious, classification: 'security', ci: green, mergeableState: 'clean', now: NOW }).action).toBe('flag');
    const flagged = { ...suspicious, flaggedDiffHash: 'h' };
    expect(decideDependabotAction({ record: flagged, classification: 'security', ci: green, mergeableState: 'clean', now: NOW }).action).toBe('skip');
  });

  it('waits when CI is not green, for either classification', () => {
    expect(decideDependabotAction({ record: safe, classification: 'security', ci: red, mergeableState: 'clean', now: NOW })).toEqual({ action: 'wait', reason: 'failing checks: test' });
    expect(decideDependabotAction({ record: safe, classification: 'regular', ci: red, mergeableState: 'clean', now: NOW }).action).toBe('wait');
  });

  it('merges a safe security update immediately when CI is green and the PR is mergeable', () => {
    expect(decideDependabotAction({ record: safe, classification: 'security', ci: green, mergeableState: 'clean', now: NOW }).action).toBe('merge');
    expect(decideDependabotAction({ record: safe, classification: 'security', ci: green, mergeableState: 'has_hooks', now: NOW }).action).toBe('merge');
  });

  it('waits on a security update that is blocked, behind, or dirty', () => {
    for (const mergeableState of ['blocked', 'behind', 'dirty', 'unknown', undefined]) {
      const result = decideDependabotAction({ record: safe, classification: 'security', ci: green, mergeableState, now: NOW });
      expect(result.action).toBe('wait');
      expect(result.reason).toMatch(/not mergeable/);
    }
  });

  it('starts the 2-day clock for a safe regular update (confirm), without requiring a clean merge state', () => {
    expect(decideDependabotAction({ record: safe, classification: 'regular', ci: green, mergeableState: 'behind', now: NOW }).action).toBe('confirm');
  });

  it('waits until 2 days after confirmation, then merges', () => {
    const justConfirmed = { ...safe, confirmedAt: new Date(NOW - DAY).toISOString() };
    const waiting = decideDependabotAction({ record: justConfirmed, classification: 'regular', ci: green, mergeableState: 'clean', now: NOW });
    expect(waiting.action).toBe('wait');
    expect(waiting.reason).toMatch(/eligible to merge after/);

    const oneMsShort = { ...safe, confirmedAt: new Date(NOW - CONFIRMATION_DELAY_MS + 1).toISOString() };
    expect(decideDependabotAction({ record: oneMsShort, classification: 'regular', ci: green, mergeableState: 'clean', now: NOW }).action).toBe('wait');

    const ready = { ...safe, confirmedAt: new Date(NOW - CONFIRMATION_DELAY_MS).toISOString() };
    expect(decideDependabotAction({ record: ready, classification: 'regular', ci: green, mergeableState: 'clean', now: NOW }).action).toBe('merge');
  });

  it('re-verifies CI and mergeability at merge time for a confirmed regular update', () => {
    const ready = { ...safe, confirmedAt: new Date(NOW - 3 * DAY).toISOString() };
    expect(decideDependabotAction({ record: ready, classification: 'regular', ci: red, mergeableState: 'clean', now: NOW }).action).toBe('wait');
    expect(decideDependabotAction({ record: ready, classification: 'regular', ci: green, mergeableState: 'dirty', now: NOW }).action).toBe('wait');
  });
});

describe('state mutations', () => {
  const key = 'acme/widgets#3';
  const base = { diffHash: 'h1', headSha: 's1', verdict: 'safe', reasons: ['ok'], summary: 'fine', classification: 'regular', now: NOW };

  it('applyVerdict creates a record and keeps the clock when only the head sha moves', () => {
    let state = applyVerdict(emptyState(), key, base);
    expect(state.dependabot[key]).toMatchObject({ diffHash: 'h1', headSha: 's1', verdict: 'safe', confirmedAt: null, flaggedDiffHash: null });
    state = markConfirmed(state, key, NOW);
    expect(state.dependabot[key].confirmedAt).toBe(new Date(NOW).toISOString());
    state = applyVerdict(state, key, { ...base, headSha: 's2', now: NOW + HOUR });
    expect(state.dependabot[key].headSha).toBe('s2');
    expect(state.dependabot[key].confirmedAt).toBe(new Date(NOW).toISOString());
  });

  it('applyVerdict resets the clock and flagged marker when the diff changed', () => {
    let state = markFlagged(markConfirmed(applyVerdict(emptyState(), key, { ...base, verdict: 'suspicious' }), key, NOW), key, NOW);
    expect(state.dependabot[key].flaggedDiffHash).toBe('h1');
    state = applyVerdict(state, key, { ...base, diffHash: 'h2', now: NOW + DAY });
    expect(state.dependabot[key]).toMatchObject({ diffHash: 'h2', verdict: 'safe', confirmedAt: null, flaggedDiffHash: null });
  });

  it('markConfirmed / markFlagged are no-ops for unknown keys', () => {
    expect(markConfirmed(emptyState(), 'x#1', NOW)).toEqual(emptyState());
    expect(markFlagged(emptyState(), 'x#1', NOW)).toEqual(emptyState());
  });

  it('pruneState drops closed PRs of crawled repos only', () => {
    let state = applyVerdict(emptyState(), 'a/b#1', base);
    state = applyVerdict(state, 'a/b#2', base);
    state = applyVerdict(state, 'c/d#9', base);
    state = markConflictDispatched(state, 'a/b#5', NOW);
    state = markConflictDispatched(state, 'c/d#6', NOW);
    const pruned = pruneState(state, ['a/b#2'], ['a/b']);
    expect(Object.keys(pruned.dependabot).sort()).toEqual(['a/b#2', 'c/d#9']);
    expect(Object.keys(pruned.conflicts)).toEqual(['c/d#6']);
  });
});

describe('buildReport', () => {
  const merged = [{ key: 'a/b#1', url: 'https://x/1', package: 'undici', from: '7.29.1', to: '7.30.0', classification: 'security', summary: 'routine <b>bump</b>' }];
  const flagged = [{ key: 'a/b#2', url: 'https://x/2', package: 'evil', from: '1.0.0', to: '1.0.1', classification: 'regular', reasons: ['new postinstall script'], summary: 'nope' }];

  it('is silent when nothing happened', () => {
    const r = buildReport({ pending: [{ key: 'a/b#3', package: 'x', reason: 'waiting' }], errors: [] });
    expect(r.shouldSend).toBe(false);
    expect(r.flagOnly).toBe(false);
  });

  it('lists merges with repo, PR, package, versions, classification, and verdict summary', () => {
    const r = buildReport({ merged }, { runUrl: 'https://run', date: NOW });
    expect(r.shouldSend).toBe(true);
    expect(r.subject).toBe('[the-intern] nightly crawl 2026-11-01: 1 merged');
    expect(r.text).toContain('- a/b#1: undici 7.29.1 → 7.30.0 [security] — routine <b>bump</b>');
    expect(r.text).toContain('https://x/1');
    expect(r.text).toContain('Run: https://run');
    expect(r.telegram).toContain('✅ merged: a/b#1 (undici 7.29.1 → 7.30.0)');
    expect(r.html).toMatch(/^<pre>/);
    expect(r.html).toContain('routine &lt;b&gt;bump&lt;/b&gt;');
  });

  it('produces a flag-only report with reasons when only suspicious PRs showed up', () => {
    const r = buildReport({ flagged }, { date: NOW });
    expect(r.flagOnly).toBe(true);
    expect(r.subject).toContain('1 suspicious');
    expect(r.text).toContain('SUSPICIOUS');
    expect(r.text).toContain('• new postinstall script');
  });

  it('counts confirmations and conflict dispatches as activity', () => {
    const r = buildReport({ confirmed: merged, conflicts: [{ key: 'a/b#7', url: 'https://x/7' }] }, { date: NOW });
    expect(r.shouldSend).toBe(true);
    expect(r.subject).toContain('1 confirmed, 1 conflict fix');
    expect(r.text).toContain('Conflict fixes dispatched');
  });
});

describe('PR comments', () => {
  it('confirmation comment names the label, the earliest merge time, and carries the marker', () => {
    const text = confirmationComment({ summary: 'routine bump' }, NOW);
    expect(text).toContain(COMMENT_MARKER);
    expect(text).toContain(CONFIRMED_LABEL);
    expect(text).toContain('2026-11-03 04:30 UTC');
    expect(text).toContain('> routine bump');
  });

  it('suspicious comment lists the reasons and the label', () => {
    const text = suspiciousComment({ reasons: ['new maintainer', 'obfuscated code'], summary: 'bad' });
    expect(text).toContain(COMMENT_MARKER);
    expect(text).toContain('- new maintainer\n- obfuscated code');
    expect(text).toContain(SUSPICIOUS_LABEL);
    expect(suspiciousComment({ reasons: [] })).toContain('(no reasons given)');
  });
});
