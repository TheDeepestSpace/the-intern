import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireDispatch, describeEntry } from '../poll-pending-retries.js';

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
