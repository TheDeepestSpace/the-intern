import { describe, it, expect } from 'vitest';
import { upsertStall, resolveEntry, findDue, markFired, removeExhausted } from '../pending-retries-store.js';

const DISPATCH = { type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: {} };

describe('upsertStall', () => {
  it('creates a new entry with retryCount 0 when none exists', () => {
    const { entries, entry, isNew, exhausted } = upsertStall([], {
      key: 'dispatcher:acme/widgets#7',
      source: 'dispatcher',
      targetRepo: 'acme/widgets',
      issueNumber: '7',
      retryAfter: '2026-08-03T20:00:00.000Z',
      matchedText: 'usage limit reached',
      maxRetries: 3,
      dispatch: DISPATCH,
    });

    expect(isNew).toBe(true);
    expect(exhausted).toBe(false);
    expect(entry.retryCount).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('dispatcher:acme/widgets#7');
  });

  it('updates an existing entry in place without incrementing retryCount', () => {
    const first = upsertStall([], {
      key: 'k', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH,
    });
    const bumped = { ...first.entries[0], retryCount: 1 };

    const { entries, entry, isNew } = upsertStall([bumped], {
      key: 'k', source: 'dispatcher', retryAfter: 'B', matchedText: 'still stalled', maxRetries: 3, dispatch: DISPATCH,
    });

    expect(isNew).toBe(false);
    expect(entry.retryCount).toBe(1); // preserved, not incremented here
    expect(entry.retryAfter).toBe('B');
    expect(entries).toHaveLength(1);
  });

  it('reports exhausted and removes the entry once retryCount is already at the cap', () => {
    const atCap = { key: 'k', retryCount: 3, dispatch: DISPATCH };

    const { entries, exhausted, entry } = upsertStall([atCap], {
      key: 'k', source: 'dispatcher', retryAfter: 'C', maxRetries: 3, dispatch: DISPATCH,
    });

    expect(exhausted).toBe(true);
    expect(entry.retryCount).toBe(3);
    expect(entries).toHaveLength(0);
  });

  it('leaves unrelated entries untouched', () => {
    const other = { key: 'other', retryCount: 0, dispatch: DISPATCH };
    const { entries } = upsertStall([other], {
      key: 'k', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH,
    });
    expect(entries.map((e) => e.key)).toEqual(['other', 'k']);
  });
});

describe('resolveEntry', () => {
  it('removes the matching entry and returns it', () => {
    const entries = [{ key: 'a' }, { key: 'b' }];
    const { entries: next, removed } = resolveEntry(entries, 'a');
    expect(removed).toEqual({ key: 'a' });
    expect(next).toEqual([{ key: 'b' }]);
  });

  it('is a no-op when the key is not queued', () => {
    const entries = [{ key: 'b' }];
    const { entries: next, removed } = resolveEntry(entries, 'a');
    expect(removed).toBeNull();
    expect(next).toBe(entries);
  });
});

describe('findDue', () => {
  it('returns only entries whose retryAfter has passed', () => {
    const now = Date.parse('2026-08-03T18:00:00Z');
    const entries = [
      { key: 'due', retryAfter: '2026-08-03T17:00:00Z' },
      { key: 'not-due', retryAfter: '2026-08-03T19:00:00Z' },
      { key: 'exactly-now', retryAfter: '2026-08-03T18:00:00Z' },
    ];
    expect(findDue(entries, now).map((e) => e.key)).toEqual(['due', 'exactly-now']);
  });
});

describe('markFired', () => {
  it('increments retryCount and pushes retryAfter forward by lockMs', () => {
    const now = Date.parse('2026-08-03T18:00:00Z');
    const entries = [{ key: 'k', retryCount: 0, retryAfter: '2026-08-03T17:00:00Z' }];
    const { entries: next, entry } = markFired(entries, 'k', { lockMs: 30 * 60 * 1000, now });

    expect(entry.retryCount).toBe(1);
    expect(entry.retryAfter).toBe('2026-08-03T18:30:00.000Z');
    expect(next[0]).toBe(entry);
  });

  it('is a no-op for an unknown key', () => {
    const entries = [{ key: 'other', retryCount: 0 }];
    const { entries: next, entry } = markFired(entries, 'missing', { lockMs: 1000 });
    expect(entry).toBeNull();
    expect(next).toBe(entries);
  });
});

describe('removeExhausted', () => {
  it('removes and returns the matching entry', () => {
    const entries = [{ key: 'k', retryCount: 3 }];
    const { entries: next, entry } = removeExhausted(entries, 'k');
    expect(entry.key).toBe('k');
    expect(next).toHaveLength(0);
  });
});
