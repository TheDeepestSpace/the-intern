import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireDispatch, describeEntry, main } from '../poll-pending-retries.js';

describe('fireDispatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs a workflow_dispatch to the workflows dispatches endpoint', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    });

    await fireDispatch(
      { type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: { target_repo: 'acme/widgets' } },
      'tok',
      { owner: 'TheDeepestSpace', repo: 'the-intern' }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/TheDeepestSpace/the-intern/actions/workflows/dispatcher.yml/dispatches');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ ref: 'main', inputs: { target_repo: 'acme/widgets' } });
  });

  it('POSTs a repository_dispatch to the repo dispatches endpoint', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    });

    await fireDispatch(
      { type: 'repository_dispatch', eventType: 'telegram_message', clientPayload: { chat_id: 123 } },
      'tok',
      { owner: 'TheDeepestSpace', repo: 'the-intern' }
    );

    expect(calls[0].url).toBe('https://api.github.com/repos/TheDeepestSpace/the-intern/dispatches');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ event_type: 'telegram_message', client_payload: { chat_id: 123 } });
  });

  it('throws for an unrecognized dispatch type', async () => {
    await expect(fireDispatch({ type: 'bogus' }, 'tok', { owner: 'o', repo: 'r' })).rejects.toThrow('Unknown dispatch type');
  });
});

describe('main (poll loop)', () => {
  const baseEnv = { GH_TOKEN: 'tok', GITHUB_REPOSITORY: 'TheDeepestSpace/the-intern' };
  const DISPATCH = { type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: {} };

  // Mirrors updateEntries's fetch->mutate->push contract against an
  // in-memory snapshot shared across the calls main() makes in one poll tick.
  function fakeStore(initialEntries) {
    let entries = initialEntries;
    const updateEntries = vi.fn((mutate) => {
      const { entries: next, ...rest } = mutate(entries);
      entries = next;
      return rest;
    });
    return { updateEntries, getEntries: () => entries };
  }

  function dueEntry(overrides = {}) {
    return {
      key: 'dispatcher:acme/widgets#1',
      targetRepo: 'acme/widgets',
      issueNumber: '1',
      retryCount: 0,
      maxRetries: 3,
      retryAfter: new Date(Date.now() - 1000).toISOString(),
      dispatch: DISPATCH,
      ...overrides,
    };
  }

  it('fires a due entry and locks it forward on success', async () => {
    const store = fakeStore([dueEntry()]);
    const fireDispatchFn = vi.fn(async () => ({ ok: true }));
    const notifyAdmin = vi.fn();

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries: store.updateEntries, fireDispatch: fireDispatchFn, notifyAdmin });

    expect(fireDispatchFn).toHaveBeenCalledTimes(1);
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].retryCount).toBe(1);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('persists the retry lock before dispatching, not after', async () => {
    const store = fakeStore([dueEntry()]);
    const order = [];
    const updateEntries = vi.fn((mutate) => {
      order.push('update');
      return store.updateEntries(mutate);
    });
    const fireDispatchFn = vi.fn(async () => {
      order.push('dispatch');
      return { ok: true };
    });

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries, fireDispatch: fireDispatchFn, notifyAdmin: vi.fn() });

    expect(order).toEqual(['update', 'dispatch']);
  });

  it('skips dispatching when persisting the pre-dispatch lock fails', async () => {
    const store = fakeStore([dueEntry()]);
    const updateEntries = vi.fn(() => {
      throw new Error('git push failed');
    });
    const fireDispatchFn = vi.fn(async () => ({ ok: true }));
    const notifyAdmin = vi.fn();

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries, fireDispatch: fireDispatchFn, notifyAdmin });

    expect(fireDispatchFn).not.toHaveBeenCalled();
    expect(store.getEntries()).toHaveLength(1);
  });

  it('removes an already-exhausted due entry and alerts without dispatching', async () => {
    const store = fakeStore([dueEntry({ retryCount: 3 })]);
    const fireDispatchFn = vi.fn(async () => ({ ok: true }));
    const notifyAdmin = vi.fn();

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries: store.updateEntries, fireDispatch: fireDispatchFn, notifyAdmin });

    expect(fireDispatchFn).not.toHaveBeenCalled();
    expect(store.getEntries()).toHaveLength(0);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][0]).toMatch(/giving up/);
  });

  it('bounds a persistently-failing dispatch by consuming retry budget instead of retrying forever', async () => {
    const store = fakeStore([dueEntry({ retryCount: 2, maxRetries: 3 })]);
    const fireDispatchFn = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const notifyAdmin = vi.fn();

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries: store.updateEntries, fireDispatch: fireDispatchFn, notifyAdmin });

    // Retained (not removed) — this attempt failed to dispatch at all — but its
    // budget is now consumed, so the next due tick hits the exhausted branch.
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].retryCount).toBe(3);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('retains a failed non-2xx dispatch response and bumps retryCount', async () => {
    const store = fakeStore([dueEntry()]);
    const fireDispatchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries: store.updateEntries, fireDispatch: fireDispatchFn, notifyAdmin: vi.fn() });

    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].retryCount).toBe(1);
  });

  it('removes and alerts immediately for an unsupported dispatch type instead of retrying', async () => {
    const store = fakeStore([dueEntry({ dispatch: { type: 'bogus' } })]);
    const notifyAdmin = vi.fn();

    await main({
      env: baseEnv,
      readEntries: () => store.getEntries(),
      updateEntries: store.updateEntries,
      fireDispatch,
      notifyAdmin,
    });

    expect(store.getEntries()).toHaveLength(0);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][0]).toMatch(/unsupported dispatch type/);
  });

  it('alerts once when a due entry is severely overdue, without blocking its dispatch', async () => {
    const stale = dueEntry({ retryAfter: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    const store = fakeStore([stale]);
    const fireDispatchFn = vi.fn(async () => ({ ok: true }));
    const notifyAdmin = vi.fn();

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries: store.updateEntries, fireDispatch: fireDispatchFn, notifyAdmin });

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][0]).toMatch(/overdue/);
    expect(fireDispatchFn).toHaveBeenCalledTimes(1);
  });

  it('does not alert for ordinary lateness within the stale threshold', async () => {
    const store = fakeStore([dueEntry()]);
    const notifyAdmin = vi.fn();

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries: store.updateEntries, fireDispatch: vi.fn(async () => ({ ok: true })), notifyAdmin });

    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('leaves entries that are not yet due untouched', async () => {
    const notDue = dueEntry({ retryAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    const store = fakeStore([notDue]);
    const fireDispatchFn = vi.fn(async () => ({ ok: true }));

    await main({ env: baseEnv, readEntries: () => store.getEntries(), updateEntries: store.updateEntries, fireDispatch: fireDispatchFn, notifyAdmin: vi.fn() });

    expect(fireDispatchFn).not.toHaveBeenCalled();
    expect(store.updateEntries).not.toHaveBeenCalled();
    expect(store.getEntries()).toEqual([notDue]);
  });
});

describe('describeEntry', () => {
  it('prefers targetRepo#issueNumber when present', () => {
    expect(describeEntry({ targetRepo: 'acme/widgets', issueNumber: '7' })).toBe('acme/widgets#7');
  });

  it('falls back to chatId', () => {
    expect(describeEntry({ chatId: '123' })).toBe('telegram chat 123');
  });

  it('falls back to the raw key as a last resort', () => {
    expect(describeEntry({ key: 'dispatcher:x#1' })).toBe('dispatcher:x#1');
  });
});
