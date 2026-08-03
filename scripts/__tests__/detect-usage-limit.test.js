import { describe, it, expect } from 'vitest';
import { detectUsageLimit, parseRetryAfterMs } from '../detect-usage-limit.js';

describe('detectUsageLimit', () => {
  it('returns null for ordinary text', () => {
    expect(detectUsageLimit('Fixed the bug and pushed a commit.')).toBeNull();
  });

  it('returns null for empty/undefined input', () => {
    expect(detectUsageLimit('')).toBeNull();
    expect(detectUsageLimit(undefined)).toBeNull();
  });

  it('matches the literal CLI string "usage limit reached"', () => {
    const result = detectUsageLimit('Error: Claude AI usage limit reached — check plan');
    expect(result).not.toBeNull();
    expect(result.matchedText.toLowerCase()).toContain('usage limit reached');
  });

  it('matches "reached your specified ... usage limits"', () => {
    const result = detectUsageLimit('You have reached your specified weekly usage limits for this org.');
    expect(result).not.toBeNull();
  });

  it('matches session/weekly/5-hour limit phrasing', () => {
    expect(detectUsageLimit('Your session limit reached for this account.')).not.toBeNull();
    expect(detectUsageLimit('weekly limit reached, try again later')).not.toBeNull();
    expect(detectUsageLimit('5-hour limit reached')).not.toBeNull();
  });

  it('matches the internal usage_cap_reached error code leaking into text', () => {
    expect(detectUsageLimit('code: usage_cap_reached')).not.toBeNull();
  });

  it('matches the live CLI phrasing "You\'ve hit your session limit · resets ..." (job 30848127490)', () => {
    const result = detectUsageLimit("You've hit your session limit · resets 11:20pm (UTC)");
    expect(result).not.toBeNull();
    expect(result.matchedText.toLowerCase()).toContain("hit your session limit");
  });

  it('matches the live CLI weekly-limit phrasing', () => {
    expect(detectUsageLimit("You've hit your weekly limit · resets Monday 9am (UTC)")).not.toBeNull();
  });

  it('does not match a plain rate_limit_error (already retried by the SDK)', () => {
    expect(detectUsageLimit('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).toBeNull();
  });

  it('does not match an unrelated GitHub API rate limit message', () => {
    expect(detectUsageLimit('API rate limit exceeded for installation')).toBeNull();
  });

  it('parses an explicit epoch timestamp after "reached|"', () => {
    const epochSeconds = Math.floor(Date.parse('2026-08-03T20:00:00Z') / 1000);
    const result = detectUsageLimit(`Claude AI usage limit reached|${epochSeconds}`, Date.parse('2026-08-03T18:00:00Z'));
    expect(result.retryAfter).toBe('2026-08-03T20:00:00.000Z');
  });

  it('parses an ISO-8601 reset timestamp', () => {
    const result = detectUsageLimit(
      'usage limit reached, resets at 2026-08-04T02:00:00Z',
      Date.parse('2026-08-03T18:00:00Z')
    );
    expect(result.retryAfter).toBe('2026-08-04T02:00:00.000Z');
  });

  it('parses a human clock-time reset, rolling to tomorrow if already past', () => {
    const now = new Date('2026-08-03T20:30:00Z').getTime();
    const ms = parseRetryAfterMs('usage limit reached, resets at 3pm', now);
    const resolved = new Date(ms);
    expect(resolved.getHours()).toBe(15);
    expect(resolved.getMinutes()).toBe(0);
    expect(ms).toBeGreaterThan(now);
  });

  it('parses a same-day human clock-time reset when still ahead', () => {
    const now = new Date('2026-08-03T10:00:00Z').getTime();
    const ms = parseRetryAfterMs('usage limit reached, resets at 3pm', now);
    const resolved = new Date(ms);
    expect(resolved.getHours()).toBe(15);
    // Same-day when 15:00 local is still ahead of `now`; rolls to tomorrow
    // otherwise — either way it's never more than a day out. Asserting the
    // calendar date directly is timezone-dependent (breaks at local offsets
    // where 15:00 has already passed for this `now`).
    expect(ms - now).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('parses explicit retry-after seconds', () => {
    const now = Date.parse('2026-08-03T18:00:00Z');
    const ms = parseRetryAfterMs('usage limit reached. retry after 3600 seconds', now);
    expect(ms).toBe(now + 3600 * 1000);
  });

  it('falls back to a default delay when no reset time is parseable', () => {
    const now = Date.parse('2026-08-03T18:00:00Z');
    const ms = parseRetryAfterMs('usage limit reached', now);
    expect(ms).toBe(now + 60 * 60 * 1000);
  });
});
