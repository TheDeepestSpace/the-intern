import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { SPEC } from '../src/agentic.generated.js';
import {
  baseGithubEnv, baseTelegramEnv, githubRequest, mockCheckSuiteDispatchFlow, mockGithubDispatchFlow, mockPushDispatchFlow,
  telegramRequest,
} from './fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Parity tests for the agentic.yaml-driven routing (issue #273): one per
// trigger type the worker handles (comment, commit, telegram), plus the
// fail-closed and limit behaviour. Commit payloads use the real repos from
// agentic.yaml (the data repo alias + the `specage` project alias).
const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const DATA_REPO = SPEC.repos.specage_data;
// Relay diagnostics (best-effort writes to the-intern-data) may fetch; assert
// only that no dispatch happened.
const expectNoAgentWork = spy => expect(spy.mock.calls.some(([i]) => /\/dispatches$/.test(new URL(i.url ?? i).pathname))).toBe(false);

function push(overrides = {}) {
  return {
    ref: 'refs/heads/specages/specage/spec',
    after: SHA,
    installation: { id: 42 },
    sender: { login: 'specage-app[bot]', type: 'Bot' },
    repository: { full_name: DATA_REPO, default_branch: 'main' },
    head_commit: { message: 'spec: add node x', added: ['spec.specage'], modified: [], removed: [] },
    commits: [{ added: ['spec.specage'], modified: [], removed: [] }],
    ...overrides,
  };
}

function mockCommitFlow({ dispatchOk = true } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(pathname)) {
      return new Response(JSON.stringify({ token: 't' }), { status: 201 });
    }
    if (pathname.endsWith('/installation')) {
      return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    }
    if (req.method === 'POST' && pathname.endsWith('/dispatches')) {
      return dispatchOk ? new Response(null, { status: 204 }) : new Response('nope', { status: 422 });
    }
    throw new Error(`Unexpected fetch: ${req.method} ${pathname}`);
  });
}

const dispatchBody = spy => {
  const call = spy.mock.calls.find(([i]) => new URL(i.url ?? i).pathname.endsWith('/dispatches'));
  return call ? JSON.parse(call[1].body) : null;
};
const send = (payload, e = baseGithubEnv()) => worker.fetch(githubRequest({ eventType: 'push', body: payload }), e);

describe('commit trigger: specage spec push -> specage_planner', () => {
  it('files an agent_commit repository_dispatch naming the agent and the push facts', async () => {
    const spy = mockCommitFlow();
    const res = await send(push());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    const body = dispatchBody(spy);
    expect(body.event_type).toBe('agent_commit');
    expect(body.client_payload).toEqual({
      agent: 'specage_planner',
      repo: DATA_REPO,
      branch: 'specages/specage/spec',
      sha: SHA,
      author: 'specage-app[bot]',
      message: 'spec: add node x',
      paths: ['spec.specage'],
      installation_id: '42',
    });
    // The data repo's own config is no longer read by the worker.
    expect(spy.mock.calls.some(([i]) => { const u = new URL(i.url ?? i).pathname; return u.includes('/contents/') && !u.includes('/contents/relay-logs/'); })).toBe(false);
  });

  it('dedupes the same commit', async () => {
    mockCommitFlow();
    const e = baseGithubEnv();
    expect(await (await send(push(), e)).text()).toBe('ok');
    expect(await (await send(push(), e)).text()).toBe('ignored: commit already dispatched');
  });

  it.each([
    ['a human', { login: 'alice', type: 'User' }],
    ['the intern bot', { login: 'the-intern-bot[bot]', type: 'Bot' }],
    ['a missing sender', undefined],
  ])('ignores spec pushes from %s (author guard)', async (_n, sender) => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await send(push({ sender }));
    expect(await res.text()).toBe('ignored: no agent trigger matches this push');
    expectNoAgentWork(spy);
  });

  it('ignores a data repo that is not the declared alias', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await send(push({ repository: { full_name: 'evil/specage-data', default_branch: 'main' } }));
    expect(await res.text()).toBe('ignored: no agent trigger matches this push');
    expectNoAgentWork(spy);
  });

  it('denies a project capture that is not a declared repo alias (default-deny)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await send(push({ ref: 'refs/heads/specages/unknown/spec' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^ignored: access: /);
    expectNoAgentWork(spy);
  });

  it('does not treat the trail branch as a trigger', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await send(push({ ref: 'refs/heads/specages/specage/trail' }));
    expect(await res.text()).toBe('ignored: no agent trigger matches this push');
    expectNoAgentWork(spy);
  });

  it('ignores branch deletion', async () => {
    const res = await send(push({ deleted: true, after: '0'.repeat(40) }));
    expect(await res.text()).toBe('ignored: branch deleted');
  });

  it('returns 502 and leaves dedup unset when dispatch fails', async () => {
    mockCommitFlow({ dispatchOk: false });
    const e = baseGithubEnv();
    expect((await send(push(), e)).status).toBe(502);
    expect(await e.CI_FAILURE_DEDUP.get(`agent_commit:specage_planner:${DATA_REPO.toLowerCase()}@${SHA}`)).toBeNull();
  });

  it('rejects a bad signature', async () => {
    const res = await send(push(), baseGithubEnv({ WEBHOOK_SECRET: 's' }));
    expect(res.status).toBe(401);
  });
});

describe('commit trigger: review-branch push -> specage_reviewer', () => {
  const reviewPush = (overrides = {}) =>
    push({
      ref: 'refs/heads/specages/specage/review',
      sender: { login: 'the-intern-bot[bot]', type: 'Bot' },
      head_commit: { message: `review ${SPEC.repos.specage}#12` },
      commits: [],
      ...overrides,
    });

  it('dispatches the reviewer with the commit message naming the PR', async () => {
    const spy = mockCommitFlow();
    expect(await (await send(reviewPush())).text()).toBe('ok');
    const body = dispatchBody(spy);
    expect(body.client_payload.agent).toBe('specage_reviewer');
    expect(body.client_payload.message).toBe(`review ${SPEC.repos.specage}#12`);
  });

  it.each([
    ['the specage app', { login: 'specage-app[bot]' }],
    ['a human', { login: 'alice' }],
  ])('ignores review pushes from %s', async (_n, sender) => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await (await send(reviewPush({ sender }))).text()).toBe('ignored: no agent trigger matches this push');
    expectNoAgentWork(spy);
  });

  it('enforces the agent max_runs_per_hour limit', async () => {
    mockCommitFlow();
    const e = baseGithubEnv();
    const limit = SPEC.defaults.limits.max_runs_per_hour;
    for (let i = 0; i < limit; i++) {
      expect(await (await send(reviewPush({ after: `${i}`.padStart(40, 'f') }), e)).text()).toBe('ok');
    }
    expect(await (await send(reviewPush({ after: 'e'.repeat(40) }), e)).text()).toBe(
      'ignored: rate limit for agent specage_reviewer reached'
    );
  });
});

describe('comment trigger: @the-intern-bot mention -> default', () => {
  const comment = (overrides = {}) => ({
    action: 'created',
    installation: { id: 42 },
    repository: { full_name: SPEC.repos.the_intern },
    comment: { user: { login: 'alice' }, body: '@the-intern-bot backend=codex fix it' },
    issue: { number: 5, user: { login: 'someone' } },
    ...overrides,
  });
  const sendComment = (payload, eventType = 'issue_comment') =>
    worker.fetch(githubRequest({ eventType, body: payload }), baseGithubEnv());

  it('forwards the raw payload plus the agent name', async () => {
    const spy = mockGithubDispatchFlow();
    expect(await (await sendComment(comment())).text()).toBe('ok');
    const body = dispatchBody(spy);
    expect(body.event_type).toBe('issue_comment');
    expect(body.client_payload.agent).toBe('default');
    expect(body.client_payload.raw.comment.body).toBe('@the-intern-bot backend=codex fix it');
  });

  it('routes inline review-thread comments too', async () => {
    const spy = mockGithubDispatchFlow();
    const payload = {
      installation: { id: 42 },
      repository: { full_name: SPEC.repos.the_intern },
      comment: { id: 9, user: { login: 'alice' }, body: '@the-intern-bot address this', pull_request_review_id: 1 },
      pull_request: { number: 8, user: { login: 'someone' } },
    };
    expect(await (await sendComment(payload, 'pull_request_review_comment')).text()).toBe('ok');
    expect(dispatchBody(spy).client_payload.agent).toBe('default');
  });

  it('denies repos whose owner is not allowlisted in agentic.yaml', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await sendComment(comment({ repository: { full_name: 'evil/repo' } }));
    expect(await res.text()).toMatch(/^ignored: access: owner of 'evil\/repo' is not allowlisted/);
    expectNoAgentWork(spy);
  });
});

describe('telegram trigger -> telegram', () => {
  it('routes any admin-chat message and names the agent in the payload', async () => {
    const spy = mockGithubDispatchFlow();
    const res = await worker.fetch(
      telegramRequest({ update: { message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: 'backend=codex hi' } } }),
      baseTelegramEnv()
    );
    expect(await res.text()).toBe('ok');
    const body = dispatchBody(spy);
    expect(body.event_type).toBe('telegram_message');
    expect(body.client_payload.agent).toBe('telegram');
    expect(body.client_payload.text).toBe('backend=codex hi');
  });
});

describe('fail closed', () => {
  const broken = JSON.stringify({ version: 1, agents: {} });

  it('answers 500 and dispatches nothing when the spec is invalid (push)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await send(push(), baseGithubEnv({ AGENTIC_SPEC: broken }));
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/agentic spec unavailable/);
    expectNoAgentWork(spy);
  });

  it('answers 500 and dispatches nothing when the spec is invalid (comment)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: { installation: { id: 42 }, repository: { full_name: SPEC.repos.the_intern }, comment: { user: { login: 'a' }, body: '@the-intern-bot x' }, issue: { number: 1, user: { login: 'b' } } },
      }),
      baseGithubEnv({ AGENTIC_SPEC: broken })
    );
    expect(res.status).toBe(500);
    expectNoAgentWork(spy);
  });

  it('answers 500 and dispatches nothing when the spec is invalid (telegram)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      telegramRequest({ update: { message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: 'hi' } } }),
      baseTelegramEnv({ AGENTIC_SPEC: broken })
    );
    expect(res.status).toBe(500);
    expectNoAgentWork(spy);
  });
});

// System-synthesized triggers (issue #276): ci_failure, merge_conflict and
// review are declared in agentic.yaml, so editing the spec changes what the
// worker dispatches (AGENTIC_SPEC is the test hook for a modified spec).
describe('system triggers: ci_failure / merge_conflict / review', () => {
  const REPO = 'TheDeepestSpace/the-intern';
  const specWith = edit => {
    const spec = structuredClone(SPEC);
    edit(spec.agents);
    return baseGithubEnv({ AGENTIC_SPEC: JSON.stringify(spec) });
  };
  const checkSuite = () => ({
    action: 'completed',
    installation: { id: 42 },
    repository: { full_name: REPO, owner: { login: 'TheDeepestSpace' }, name: 'the-intern' },
    check_suite: {
      head_sha: 'sha-abc123', conclusion: 'failure', html_url: 'https://github.com/x/pull/7/checks',
      pull_requests: [{ number: 7 }, { number: 8 }],
    },
  });
  const dispatches = spy => spy.mock.calls
    .filter(([i, init]) => init?.method === 'POST' && new URL(i.url ?? i).pathname.endsWith('/dispatches'))
    .map(([, init]) => JSON.parse(init.body));
  const failing = [{ name: 'test', status: 'completed', conclusion: 'failure' }];

  it('ci_failure names the ci_fixer agent in the dispatch', async () => {
    const spy = mockCheckSuiteDispatchFlow();
    const res = await worker.fetch(githubRequest({ eventType: 'check_suite', body: { ...checkSuite(), check_suite: { ...checkSuite().check_suite, pull_requests: [{ number: 7 }] } } }), baseGithubEnv());
    expect(await res.text()).toBe('ok');
    expect(dispatches(spy)[0]).toMatchObject({ event_type: 'ci_failure', client_payload: { agent: 'ci_fixer' } });
  });

  it('ci_failure on a specage/* head branch routes to ci_fixer_specage', async () => {
    const spy = mockCheckSuiteDispatchFlow({ pullRequestHeadRef: 'specage/brace-highlight-autoclose' });
    const body = { ...checkSuite(), check_suite: { ...checkSuite().check_suite, pull_requests: [{ number: 7 }] } };
    expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), baseGithubEnv())).text()).toBe('ok');
    expect(dispatches(spy)[0]).toMatchObject({ event_type: 'ci_failure', client_payload: { agent: 'ci_fixer_specage' } });
  });

  it('ci_failure on other branches still routes to ci_fixer', async () => {
    const spy = mockCheckSuiteDispatchFlow({ pullRequestHeadRef: 'fix/thing' });
    const body = { ...checkSuite(), check_suite: { ...checkSuite().check_suite, pull_requests: [{ number: 7 }] } };
    expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), baseGithubEnv())).text()).toBe('ok');
    expect(dispatches(spy)[0]).toMatchObject({ client_payload: { agent: 'ci_fixer' } });
  });

  it('a push-run suite with empty pull_requests resolves PRs via the head commit', async () => {
    const base = mockCheckSuiteDispatchFlow({ pullRequestHeadRef: 'specage/x' });
    const handler = base.getMockImplementation();
    base.mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith('/installation')) return new Response('{}', { status: 404 });
      if (url.pathname.endsWith('/commits/sha-abc123/pulls')) {
        return new Response(JSON.stringify([{ number: 7, state: 'open' }, { number: 9, state: 'closed' }]), { status: 200 });
      }
      return handler(input, init);
    });
    const body = { ...checkSuite(), check_suite: { ...checkSuite().check_suite, pull_requests: [] } };
    expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), baseGithubEnv())).text()).toBe('ok');
    const sent = dispatches(base);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ client_payload: { agent: 'ci_fixer_specage' } });
  });

  it('a suite with no PRs anywhere is ignored with a distinct reason', async () => {
    const base = mockCheckSuiteDispatchFlow();
    const handler = base.getMockImplementation();
    base.mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith('/installation')) return new Response('{}', { status: 404 });
      if (url.pathname.endsWith('/pulls') && url.pathname.includes('/commits/')) return new Response('[]', { status: 200 });
      return handler(input, init);
    });
    const body = { ...checkSuite(), check_suite: { ...checkSuite().check_suite, pull_requests: [] } };
    expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), baseGithubEnv())).text())
      .toBe('ignored: check_suite has no pull requests');
  });

  it('ci_failure follows pr_authors from agentic.yaml, not a hardcoded bot login', async () => {
    const env = specWith(a => { a.ci_fixer.trigger.ci_failure.pr_authors = ['someone-else']; });
    const spy = mockCheckSuiteDispatchFlow();
    const body = { ...checkSuite(), check_suite: { ...checkSuite().check_suite, pull_requests: [{ number: 7 }] } };
    expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), env)).text())
      .toBe('ignored: no bot-authored pull requests');
    expect(dispatches(spy)).toHaveLength(0);
    spy.mockRestore();
    const spy2 = mockCheckSuiteDispatchFlow({ pullRequestAuthor: 'someone-else' });
    expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), env)).text()).toBe('ok');
    expect(dispatches(spy2)).toHaveLength(1);
  });

  it('ci_failure skip_preexisting and dedup are read from the trigger', async () => {
    const runs = { 'sha-abc123': failing, 'base-sha': failing };
    const body = { ...checkSuite(), check_suite: { ...checkSuite().check_suite, pull_requests: [{ number: 7 }] } };
    // Declared (default): pre-existing failures are skipped.
    const spy = mockCheckSuiteDispatchFlow({ checkRunsByRef: runs });
    expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), baseGithubEnv())).text())
      .toBe('ignored: all failures pre-existing on base branch');
    spy.mockRestore();
    // Turned off in yaml: dispatches, and without dedup a repeat dispatches again.
    const env = specWith(a => {
      a.ci_fixer.trigger.ci_failure.skip_preexisting = false;
      delete a.ci_fixer.trigger.ci_failure.dedup;
    });
    const spy2 = mockCheckSuiteDispatchFlow({ checkRunsByRef: runs });
    for (let i = 0; i < 2; i++) {
      expect(await (await worker.fetch(githubRequest({ eventType: 'check_suite', body }), env)).text()).toBe('ok');
    }
    expect(dispatches(spy2)).toHaveLength(2);
  });

  it('ci_failure is capped by the agent max_runs_per_hour', async () => {
    const env = specWith(a => { a.ci_fixer.limits = { max_runs_per_hour: 1 }; });
    const spy = mockCheckSuiteDispatchFlow();
    const res = await worker.fetch(githubRequest({ eventType: 'check_suite', body: checkSuite() }), env);
    expect(await res.text()).toBe('ok');
    expect(dispatches(spy)).toHaveLength(1);
  });

  it('merge_conflict names the conflict_fixer agent and follows pr_authors', async () => {
    const payload = { ref: 'refs/heads/main', installation: { id: 42 },
      repository: { full_name: REPO, owner: { login: 'TheDeepestSpace' }, name: 'the-intern', default_branch: 'main' } };
    const spy = mockPushDispatchFlow({ mergeableStates: { 7: 'dirty' } });
    const res = await worker.fetch(githubRequest({ eventType: 'push', body: payload }), baseGithubEnv({ MERGEABLE_POLL_DELAY_MS: '1' }));
    expect(await res.text()).toBe('ok');
    expect(dispatches(spy)[0]).toMatchObject({ event_type: 'merge_conflict', client_payload: { agent: 'conflict_fixer' } });
    spy.mockRestore();

    const env = specWith(a => { a.conflict_fixer.trigger.merge_conflict.pr_authors = ['someone-else']; });
    const spy2 = mockPushDispatchFlow({ mergeableStates: { 7: 'dirty' } });
    const res2 = await worker.fetch(githubRequest({ eventType: 'push', body: payload }), { ...env, MERGEABLE_POLL_DELAY_MS: '1' });
    expect(await res2.text()).toBe('ignored: no bot-authored pull requests became unmergeable');
    expect(dispatches(spy2)).toHaveLength(0);
  });

  it('review names the review_responder agent and only fires for declared reviewers', async () => {
    const payload = (login) => ({
      action: 'submitted', installation: { id: 42 }, repository: { full_name: REPO },
      review: { user: { login }, body: 'x', html_url: 'https://github.com/x/pull/7#r1' },
      pull_request: { number: 7, user: { login: 'the-intern-bot[bot]' } },
    });
    const spy = mockGithubDispatchFlow();
    const res = await worker.fetch(githubRequest({ eventType: 'pull_request_review', body: payload('coderabbitai[bot]') }), baseGithubEnv());
    expect(await res.text()).toBe('ok');
    const d = dispatches(spy)[0];
    expect(d).toMatchObject({ event_type: 'coderabbit_review', client_payload: { agent: 'review_responder' } });
    expect(JSON.stringify(d)).not.toContain('"body"');
    spy.mockRestore();

    const env = specWith(a => { a.review_responder.trigger.review.reviewers = ['other-reviewer[bot]']; });
    const spy2 = mockGithubDispatchFlow();
    const res2 = await worker.fetch(githubRequest({ eventType: 'pull_request_review', body: payload('coderabbitai[bot]') }), env);
    // No longer a declared reviewer: an ordinary review on a bot-authored PR,
    // i.e. an implicit mention for the catch-all agent.
    expect(await res2.text()).toBe('ok');
    expect(dispatches(spy2)[0]).toMatchObject({ event_type: 'pull_request_review', client_payload: { agent: 'default' } });
  });
});

describe('relay: outbox push -> specage workflow_dispatch', () => {
  const outbox = (o = {}) => push({
    ref: 'refs/heads/specages/specage/trail',
    sender: { login: 'the-intern-bot[bot]', type: 'Bot' },
    head_commit: { message: 'outbox: add entry', added: ['outbox/1.json'], modified: [], removed: [] },
    commits: [{ added: ['outbox/1.json'], modified: [], removed: [] }],
    ...o,
  });
  const wfCall = spy => spy.mock.calls.find(([i]) => new URL(i.url ?? i).pathname.endsWith('/dispatches') && /actions\/workflows/.test(String(i.url ?? i)));
  const mockRelay = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const { pathname } = new URL(req.url);
    if (pathname.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 't' }), { status: 201 });
    if (pathname.endsWith('/installation')) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    if (pathname.endsWith('/dispatches')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch: ${req.method} ${pathname}`);
  });

  it('dispatches the specage workflow with repo/sha/project', async () => {
    const spy = mockRelay();
    const res = await send(outbox());
    expect(res.status).toBe(200);
    const call = wfCall(spy);
    expect(String(call[0].url ?? call[0])).toBe(`https://api.github.com/repos/${SPEC.repos.specage}/actions/workflows/fire-outbox.yml/dispatches`);
    expect(JSON.parse(call[1].body)).toEqual({ ref: 'main', inputs: { repo: DATA_REPO, sha: SHA, project: 'specage' } });
  });

  it('ignores fired-marking pushes and other authors', async () => {
    const spy = mockRelay();
    await send(outbox({ head_commit: { message: 'outbox: fired 1' }, commits: [{ message: 'outbox: fired 1', modified: ['outbox/1.json'] }] }));
    await send(outbox({ sender: { login: 'someone', type: 'User' } }));
    expect(wfCall(spy)).toBeUndefined();
  });

  it('still dispatches when a fired-marking commit follows a new entry', async () => {
    const spy = mockRelay();
    await send(outbox({
      head_commit: { message: 'outbox: fired 1' },
      commits: [
        { message: 'outbox: add entry', added: ['outbox/2.json'] },
        { message: 'outbox: fired 1', modified: ['outbox/1.json'] },
      ],
    }));
    expect(wfCall(spy)).toBeDefined();
  });

  describe('diagnostics log (data repo, never console)', () => {
    const logFlow = ({ putStatus = 200, dispatchStatus = 204 } = {}) => {
      const puts = [];
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const req = new Request(input, init);
        const { pathname } = new URL(req.url);
        if (pathname.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'SECRET-TOKEN' }), { status: 201 });
        if (pathname.endsWith('/installation')) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
        if (pathname.endsWith('/dispatches')) return new Response(dispatchStatus === 204 ? null : 'nope', { status: dispatchStatus });
        if (pathname.includes('/contents/relay-logs/')) {
          if (req.method === 'GET') return new Response('{}', { status: 404 });
          puts.push({ pathname, body: JSON.parse(await req.text()) });
          return new Response('{}', { status: putStatus });
        }
        throw new Error(`Unexpected fetch: ${req.method} ${pathname}`);
      });
      return { spy, puts };
    };
    const lines = puts => Buffer.from(puts[0].body.content, 'base64').toString().trim().split('\n').map(l => JSON.parse(l));
    const sendLogged = (payload) => worker.fetch(githubRequest({ eventType: 'push', body: payload, headers: { 'X-GitHub-Delivery': 'del-1' } }), baseGithubEnv());

    it('records a dispatched match with delivery id, repo, ref, sender, status', async () => {
      const { puts } = logFlow();
      const log = vi.spyOn(console, 'log');
      const err = vi.spyOn(console, 'error');
      await sendLogged(outbox());
      const [rec] = lines(puts);
      expect(puts[0].pathname).toMatch(/\/contents\/relay-logs\/\d{4}-\d{2}-\d{2}\.jsonl$/);
      expect(rec).toMatchObject({ delivery: 'del-1', repo: DATA_REPO, ref: 'refs/heads/specages/specage/trail', sender: 'the-intern-bot[bot]', match: true, reason: 'matched', outcome: 'dispatched', status: 204 });
      expect(JSON.stringify(rec)).not.toContain('SECRET-TOKEN');
      expect(log).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    });

    it('writes to the-intern-data, not the pushed repo, and records other skip reasons', async () => {
      const { puts, spy } = logFlow();
      await sendLogged({ ...outbox(), repository: { full_name: 'Other/repo', default_branch: 'main' } });
      expect(puts[0].pathname).toContain('/repos/TheDeepestSpace/the-intern-data/contents/relay-logs/');
      expect(spy.mock.calls.some(c => String(c[0]).includes('Other/repo/contents'))).toBe(false);
      expect(lines(puts)[0]).toMatchObject({ repo: 'Other/repo', match: false, reason: 'repo_mismatch' });
    });

    it('records the skip reason for a wrong sender', async () => {
      const { puts } = logFlow();
      await sendLogged(outbox({ sender: { login: 'someone', type: 'User' } }));
      expect(lines(puts)[0]).toMatchObject({ sender: 'someone', match: false, reason: 'sender_mismatch' });
    });

    it('records dispatch HTTP status and error body', async () => {
      const { puts } = logFlow({ dispatchStatus: 403 });
      const res = await sendLogged(outbox());
      expect(res.status).toBe(502);
      expect(lines(puts)[0]).toMatchObject({ outcome: 'dispatch_failed', status: 403, error: 'nope' });
    });

    it('never fails the relay when the log write fails', async () => {
      const { spy } = logFlow({ putStatus: 500 });
      expect((await sendLogged(outbox())).status).toBe(200);
      expect(wfCall(spy)).toBeDefined();
    });

    it('does not log pushes that only touch relay-logs/ (no feedback loop)', async () => {
      const { puts } = logFlow();
      await sendLogged(outbox({
        head_commit: { message: 'relay-logs: append', added: ['relay-logs/x.jsonl'] },
        commits: [{ message: 'relay-logs: append', added: ['relay-logs/x.jsonl'] }],
      }));
      expect(puts).toHaveLength(0);
    });
  });
});

describe('comment trigger: head_branch route (worker)', () => {
  const REPO = 'TheDeepestSpace/the-intern';
  const envWith = (extra = {}) => {
    const spec = structuredClone(SPEC);
    spec.agents.branch_agent = {
      ...structuredClone(spec.agents.default),
      trigger: { comment: { verb: '*', on: ['pr', 'review_thread'], head_branch: 'specage/*', max_attempts: 2, params: { backend: 'string', model: 'string', effort: 'string' } } },
    };
    return baseGithubEnv({ AGENTIC_SPEC: JSON.stringify(spec), ...extra });
  };
  const prComment = (body = '@the-intern-bot go') => ({
    installation: { id: 42 }, repository: { full_name: REPO },
    comment: { user: { login: 'alice' }, body }, issue: { number: 5, user: { login: 'alice' }, pull_request: {} },
  });
  const mockFlow = headRef => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const { pathname } = new URL(req.url);
    if (/\/access_tokens$/.test(pathname)) return new Response(JSON.stringify({ token: 't' }), { status: 201 });
    if (req.method === 'GET' && /\/pulls\/5$/.test(pathname)) return new Response(JSON.stringify({ head: { ref: headRef } }), { status: 200 });
    if (pathname.endsWith('/dispatches')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch: ${req.method} ${pathname}`);
  });
  const body = spy => {
    const c = spy.mock.calls.find(([i]) => new URL(i.url ?? i).pathname.endsWith('/dispatches'));
    return c ? JSON.parse(c[1].body) : null;
  };
  const send = (b, env, type = 'issue_comment') => worker.fetch(githubRequest({ eventType: type, body: b }), env);

  it('fetches the PR head ref for an issue comment and routes on a glob match', async () => {
    const spy = mockFlow('specage/feat');
    const res = await send(prComment(), envWith());
    expect(await res.text()).toBe('ok');
    expect(body(spy).client_payload).toMatchObject({ agent: 'branch_agent', head_ref: 'specage/feat' });
  });

  it('falls back to default on other branches', async () => {
    const spy = mockFlow('feature/x');
    await send(prComment(), envWith());
    expect(body(spy).client_payload.agent).toBe('default');
  });

  it('a bodyless changes_requested review fires the route without a mention', async () => {
    const spy = mockFlow('unused');
    const res = await send({
      installation: { id: 42 }, repository: { full_name: REPO },
      review: { user: { login: 'the-intern-bot[bot]' }, body: '', state: 'changes_requested' },
      pull_request: { number: 5, user: { login: 'the-intern-bot[bot]' }, head: { ref: 'specage/feat' } },
    }, envWith(), 'pull_request_review');
    expect(await res.text()).toBe('ok');
    expect(body(spy).client_payload.agent).toBe('branch_agent');
  });

  it('a non-mentioning approved review does nothing', async () => {
    const spy = mockFlow('unused');
    const res = await send({
      installation: { id: 42 }, repository: { full_name: REPO },
      review: { user: { login: 'alice' }, body: 'nice', state: 'approved' },
      pull_request: { number: 5, user: { login: 'alice' }, head: { ref: 'specage/feat' } },
    }, envWith(), 'pull_request_review');
    expect(await res.text()).toMatch(/^ignored/);
    expect(body(spy)).toBeNull();
  });

  it('stops after max_attempts dispatches per PR', async () => {
    const spy = mockFlow('specage/feat');
    const env = envWith();
    expect(await (await send(prComment(), env)).text()).toBe('ok');
    expect(await (await send(prComment(), env)).text()).toBe('ok');
    expect(await (await send(prComment(), env)).text()).toMatch(/attempt cap \(2\)/);
    expect(spy.mock.calls.filter(([i]) => new URL(i.url ?? i).pathname.endsWith('/dispatches'))).toHaveLength(2);
  });
});
