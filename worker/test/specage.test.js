import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { baseGithubEnv, githubRequest } from './fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const CONFIG = 'project: demo\nrepo: acme/app\nintern:\n  repo: TheDeepestSpace/the-intern\n  backend: codex\n';

function specPush(overrides = {}) {
  return {
    ref: 'refs/heads/specages/demo/spec',
    after: SHA,
    installation: { id: 42 },
    sender: { login: 'alice', type: 'User' },
    repository: { full_name: 'acme/specage-data' },
    ...overrides,
  };
}

function env(overrides = {}) {
  return baseGithubEnv({ SPECAGE_DATA_REPOS: 'acme/specage-data', ...overrides });
}

function mockFlow({ config = CONFIG, dispatchOk = true } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(pathname)) {
      return new Response(JSON.stringify({ token: 't' }), { status: 201 });
    }
    if (pathname.endsWith('/contents/.specage/config.yaml')) {
      return config === null ? new Response('no', { status: 404 }) : new Response(config);
    }
    if (pathname.endsWith('/installation')) {
      return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    }
    if (req.method === 'POST' && pathname.endsWith('/actions/workflows/dispatcher.yml/dispatches')) {
      return dispatchOk ? new Response(null, { status: 204 }) : new Response('nope', { status: 422 });
    }
    throw new Error(`Unexpected fetch: ${req.method} ${pathname}`);
  });
}

const send = (payload, e = env()) => worker.fetch(githubRequest({ eventType: 'push', body: payload }), e);

describe('specage spec-branch push', () => {
  it('dispatches dispatcher.yml without creating an issue', async () => {
    const spy = mockFlow();
    const res = await send(specPush());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    const call = spy.mock.calls.find(([i]) => new URL(i.url ?? i).pathname.endsWith('/dispatches'));
    const body = JSON.parse(call[1].body);
    expect(body.inputs.target_repo).toBe('acme/app');
    expect(body.inputs.pr_number).toBeUndefined();
    expect(spy.mock.calls.some(([i]) => new URL(i.url ?? i).pathname.endsWith('/issues'))).toBe(false);
    expect(body.inputs.comment_body).toBe(
      `backend=codex Run the specage dispatch for commit ${SHA}. Spec and trail live in acme/specage-data on branches specages/demo/{spec,trail}. Follow .specage/PROTOCOL.md on the spec branch exactly.`
    );
  });

  it('dedupes the same push', async () => {
    mockFlow();
    const e = env();
    expect(await (await send(specPush(), e)).text()).toBe('ok');
    const res = await send(specPush(), e);
    expect(await res.text()).toBe('ignored: specage push already dispatched');
  });

  it('ignores data repos not on the allowlist', async () => {
    const spy = mockFlow();
    const res = await send(specPush({ repository: { full_name: 'evil/data' } }));
    expect(await res.text()).toBe('ignored: data repo not allowlisted');
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores everything when no allowlist is configured', async () => {
    mockFlow();
    const res = await send(specPush(), env({ SPECAGE_DATA_REPOS: undefined }));
    expect(await res.text()).toBe('ignored: data repo not allowlisted');
  });

  it('ignores bot pushes', async () => {
    const spy = mockFlow();
    const res = await send(specPush({ sender: { login: 'specage[bot]', type: 'Bot' } }));
    expect(await res.text()).toBe('ignored: bot push');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not treat the trail branch as a spec branch', async () => {
    mockFlow();
    const res = await send(
      specPush({
        ref: 'refs/heads/specages/demo/trail',
        repository: { full_name: 'acme/specage-data', default_branch: 'main' },
      })
    );
    expect(await res.text()).toBe('ignored: push not on default branch');
  });

  it('ignores branch deletion', async () => {
    mockFlow();
    const res = await send(specPush({ deleted: true, after: '0'.repeat(40) }));
    expect(await res.text()).toBe('ignored: spec branch deleted');
  });

  it('ignores a spec branch without config', async () => {
    mockFlow({ config: null });
    const res = await send(specPush());
    expect(await res.text()).toBe('ignored: no .specage/config.yaml on spec branch');
  });

  it('returns 502 and leaves dedup unset when dispatch fails', async () => {
    mockFlow({ dispatchOk: false });
    const e = env();
    expect((await send(specPush(), e)).status).toBe(502);
    expect(await e.CI_FAILURE_DEDUP.get(`specage_push:acme/specage-data@${SHA}`)).toBeNull();
  });

  it('rejects a bad signature', async () => {
    const res = await send(specPush(), env({ WEBHOOK_SECRET: 's' }));
    expect(res.status).toBe(401);
  });
});
