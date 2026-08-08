import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readResultText, main } from '../handle-agent-outcome.js';

describe('readResultText', () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });

  function write(content) {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'result-')), 'result.json');
    fs.writeFileSync(tmpFile, content);
    return tmpFile;
  }

  it('treats a missing file as an error with empty text', () => {
    expect(readResultText(path.join(os.tmpdir(), 'does-not-exist.json'))).toEqual({ isError: true, text: '' });
  });

  it('treats an empty file as an error with empty text', () => {
    expect(readResultText(write('   '))).toEqual({ isError: true, text: '' });
  });

  it('extracts the result field on success', () => {
    const file = write(JSON.stringify({ is_error: false, result: 'Opened PR #12' }));
    expect(readResultText(file)).toEqual({ isError: false, text: 'Opened PR #12' });
  });

  it('extracts the result field on failure', () => {
    const file = write(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached' }));
    expect(readResultText(file)).toEqual({ isError: true, text: 'Claude AI usage limit reached' });
  });

  it('falls back to output when result is absent', () => {
    const file = write(JSON.stringify({ is_error: false, output: 'from codex' }));
    expect(readResultText(file)).toEqual({ isError: false, text: 'from codex' });
  });

  it('treats unparseable JSON as an error, using the raw text', () => {
    const file = write('not json at all');
    expect(readResultText(file)).toEqual({ isError: true, text: 'not json at all' });
  });
});

describe('main', () => {
  const baseEnv = { RETRY_KEY: 'dispatcher:owner/repo#1', TG_ADMIN_CHAT_ID: '123', RUN_URL: 'https://example.test/run' };

  afterEach(() => {
    process.exitCode = 0;
  });

  // A promise plus externally-callable resolve/reject, so a test can assert on
  // state before persistence settles and control exactly when it does.
  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Mirrors real updateEntries's contract (fetch -> mutate -> push) without any
  // git I/O: applies `mutate` to a fixed `entries` snapshot and drops the
  // `entries` key from its return value, just like manage-pending-retries.js
  // does. Resolves as a real (queued-microtask) Promise rather than a plain
  // synchronous value, so a `main()` that dropped its `await updateEntriesFn(...)`
  // would destructure an unresolved Promise instead of the real result and fail
  // the assertions below.
  function fakeUpdateEntries(entries) {
    return vi.fn(async (mutate) => {
      const { entries: _next, ...rest } = mutate(entries);
      return rest;
    });
  }

  function deps(overrides = {}) {
    return {
      readResultText: vi.fn(() => ({ isError: false, text: '' })),
      updateEntries: fakeUpdateEntries([]),
      sendTelegram: vi.fn(),
      buildDispatchPayload: vi.fn(() => null),
      detectUsageLimit: vi.fn(() => null),
      ...overrides,
    };
  }

  it('clears a queued retry and pings "resumed" on success', async () => {
    const entries = [{ key: baseEnv.RETRY_KEY, retryCount: 1, maxRetries: 3 }];
    const d = deps({
      readResultText: vi.fn(() => ({ isError: false, text: '' })),
      updateEntries: fakeUpdateEntries(entries),
    });

    await main(baseEnv, d);

    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/resumed/);
  });

  it('sends nothing on success when no retry was queued', async () => {
    const d = deps({ readResultText: vi.fn(() => ({ isError: false, text: '' })) });

    await main(baseEnv, d);

    expect(d.sendTelegram).not.toHaveBeenCalled();
  });

  it('waits for updateEntries to resolve before pinging "resumed" on success', async () => {
    const entries = [{ key: baseEnv.RETRY_KEY, retryCount: 1, maxRetries: 3 }];
    const control = deferred();
    const d = deps({
      readResultText: vi.fn(() => ({ isError: false, text: '' })),
      updateEntries: vi.fn((mutate) => control.promise.then(() => {
        const { entries: _next, ...rest } = mutate(entries);
        return rest;
      })),
    });

    const result = main(baseEnv, d);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.sendTelegram).not.toHaveBeenCalled();

    control.resolve();
    await result;

    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/resumed/);
  });

  it('does not fail the step when clearing a retry on success rejects', async () => {
    const d = deps({
      readResultText: vi.fn(() => ({ isError: false, text: '' })),
      updateEntries: vi.fn(() => Promise.reject(new Error('push rejected'))),
    });

    await expect(main(baseEnv, d)).resolves.not.toThrow();
    expect(d.sendTelegram).not.toHaveBeenCalled();
  });

  it('queues a retry and pings "queued" on a usage-limit stall', async () => {
    const d = deps({
      readResultText: vi.fn(() => ({ isError: true, text: 'usage limit reached' })),
      detectUsageLimit: vi.fn(() => ({ matchedText: 'usage limit reached', retryAfter: '2026-08-03T12:00:00.000Z' })),
      buildDispatchPayload: vi.fn(() => ({ type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: {} })),
      updateEntries: fakeUpdateEntries([]),
    });

    await main(baseEnv, d);

    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/queued to auto-resume/);
  });

  it('waits for updateEntries to resolve before pinging "queued" on a usage-limit stall', async () => {
    const control = deferred();
    const d = deps({
      readResultText: vi.fn(() => ({ isError: true, text: 'usage limit reached' })),
      detectUsageLimit: vi.fn(() => ({ matchedText: 'usage limit reached', retryAfter: '2026-08-03T12:00:00.000Z' })),
      buildDispatchPayload: vi.fn(() => ({ type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: {} })),
      updateEntries: vi.fn((mutate) => control.promise.then(() => {
        const { entries: _next, ...rest } = mutate([]);
        return rest;
      })),
    });

    const result = main(baseEnv, d);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.sendTelegram).not.toHaveBeenCalled();

    control.resolve();
    await result;

    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/queued to auto-resume/);
  });

  it('alerts on exhausted retry budget instead of queuing again', async () => {
    const entries = [
      { key: baseEnv.RETRY_KEY, retryCount: 3, maxRetries: 3, source: 'dispatcher', dispatch: {}, retryAfter: '2026-08-03T00:00:00.000Z' },
    ];
    const d = deps({
      readResultText: vi.fn(() => ({ isError: true, text: 'usage limit reached' })),
      detectUsageLimit: vi.fn(() => ({ matchedText: 'usage limit reached', retryAfter: '2026-08-03T12:00:00.000Z' })),
      buildDispatchPayload: vi.fn(() => ({ type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: {} })),
      updateEntries: fakeUpdateEntries(entries),
    });

    await main(baseEnv, d);

    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/used up all/);
  });

  it('falls back to the generic failure notification when queuing a stall fails', async () => {
    const d = deps({
      readResultText: vi.fn(() => ({ isError: true, text: 'usage limit reached' })),
      detectUsageLimit: vi.fn(() => ({ matchedText: 'usage limit reached', retryAfter: '2026-08-03T12:00:00.000Z' })),
      buildDispatchPayload: vi.fn(() => ({ type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: {} })),
      updateEntries: vi.fn(() => Promise.reject(new Error('push rejected'))),
    });

    await expect(main(baseEnv, d)).resolves.not.toThrow();
    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/queuing the auto-retry failed/);
  });

  it('falls back to the generic failure notification when a stall has no dispatch payload', async () => {
    const d = deps({
      readResultText: vi.fn(() => ({ isError: true, text: 'usage limit reached' })),
      detectUsageLimit: vi.fn(() => ({ matchedText: 'usage limit reached', retryAfter: '2026-08-03T12:00:00.000Z' })),
      buildDispatchPayload: vi.fn(() => null),
    });

    await main(baseEnv, d);

    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/ran into an error/);
    expect(d.updateEntries).not.toHaveBeenCalled();
  });

  it('sends the generic failure notification for a non-stall failure', async () => {
    const d = deps({ readResultText: vi.fn(() => ({ isError: true, text: 'some other crash' })) });

    await main(baseEnv, d);

    expect(d.sendTelegram).toHaveBeenCalledTimes(1);
    expect(d.sendTelegram.mock.calls[0][1]).toMatch(/ran into an error/);
    expect(d.updateEntries).not.toHaveBeenCalled();
  });

  it('exits with an error and does not call any deps when RETRY_KEY is missing', async () => {
    const d = deps();

    await main({ ...baseEnv, RETRY_KEY: '' }, d);

    expect(process.exitCode).toBe(1);
    expect(d.readResultText).not.toHaveBeenCalled();
    expect(d.sendTelegram).not.toHaveBeenCalled();
  });
});
