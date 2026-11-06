import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import {
  baseTelegramEnv,
  fakeScheduledCtx,
  mockGithubDispatchFlow,
  mockInstallationLookupAndDispatchFlow,
  scheduledEvent,
} from './fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchedRequestBody(fetchSpy) {
  const dispatchCall = fetchSpy.mock.calls.find(([input]) =>
    new URL(typeof input === 'string' ? input : input.url).pathname.endsWith('/dispatches')
  );
  expect(dispatchCall).toBeTruthy();
  const [, init] = dispatchCall;
  return JSON.parse(init.body);
}

describe('scheduled', () => {
  it('dispatches a poller_tick event on the configured agent-infra repo', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const ctx = fakeScheduledCtx();

    await worker.scheduled(scheduledEvent(), baseTelegramEnv(), ctx);
    await ctx.settled();

    const dispatchCall = fetchSpy.mock.calls.find(([input]) =>
      new URL(typeof input === 'string' ? input : input.url).pathname.endsWith('/dispatches')
    );
    expect(dispatchCall).toBeTruthy();
    const [dispatchRequest, dispatchInit] = dispatchCall;
    const url = new URL(dispatchRequest.url ?? dispatchRequest);
    expect(url.toString()).toBe('https://api.github.com/repos/TheDeepestSpace/the-intern/dispatches');
    expect(dispatchInit.headers.Authorization).toBe('Bearer test-installation-token');
    expect(dispatchedRequestBody(fetchSpy).event_type).toBe('poller_tick');
  });

  it('looks up the installation id via the GitHub App JWT when AGENT_INFRA_INSTALLATION_ID is unset', async () => {
    const fetchSpy = mockInstallationLookupAndDispatchFlow({ installationId: 4321 });
    const ctx = fakeScheduledCtx();

    await worker.scheduled(
      scheduledEvent(),
      baseTelegramEnv({ AGENT_INFRA_INSTALLATION_ID: undefined }),
      ctx
    );
    await ctx.settled();

    const lookupCall = fetchSpy.mock.calls.find(([input]) =>
      new URL(typeof input === 'string' ? input : input.url).pathname.endsWith('/installation')
    );
    expect(lookupCall).toBeTruthy();
  });

  it('waitUntil rejects when no installation id can be resolved', async () => {
    const ctx = fakeScheduledCtx();

    await worker.scheduled(
      scheduledEvent(),
      baseTelegramEnv({ AGENT_INFRA_INSTALLATION_ID: undefined, APP_ID: undefined, APP_PRIVATE_KEY: undefined }),
      ctx
    );

    await expect(ctx.settled()).rejects.toThrow('missing installation id for agent-infra');
  });

  it('waitUntil rejects when the dispatch call fails', async () => {
    mockGithubDispatchFlow({ dispatchOk: false });
    const ctx = fakeScheduledCtx();

    await worker.scheduled(scheduledEvent(), baseTelegramEnv(), ctx);

    await expect(ctx.settled()).rejects.toThrow('dispatch failed');
  });
});
