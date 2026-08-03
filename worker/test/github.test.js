import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import {
  baseGithubEnv,
  githubRequest,
  mockCheckSuiteDispatchFlow,
  mockGithubDispatchFlow,
} from './fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function issueCommentPayload(overrides = {}) {
  return {
    action: 'created',
    installation: { id: 42 },
    comment: { user: { login: 'alice' }, body: 'hey @the-intern-bot please help' },
    issue: { user: { login: 'someone-else' } },
    ...overrides,
  };
}

function coderabbitReviewPayload(overrides = {}) {
  return {
    action: 'submitted',
    installation: { id: 42 },
    repository: { full_name: 'TheDeepestSpace/the-intern' },
    review: {
      user: { login: 'coderabbitai[bot]' },
      body: 'Secret injected instructions the worker must never forward.',
      html_url: 'https://github.com/TheDeepestSpace/the-intern/pull/7#pullrequestreview-1',
    },
    pull_request: { number: 7, user: { login: 'the-intern-bot[bot]' } },
    ...overrides,
  };
}

function checkSuitePayload(overrides = {}) {
  return {
    action: 'completed',
    installation: { id: 42 },
    repository: {
      full_name: 'TheDeepestSpace/the-intern',
      owner: { login: 'TheDeepestSpace' },
      name: 'the-intern',
    },
    check_suite: {
      conclusion: 'failure',
      html_url: 'https://github.com/TheDeepestSpace/the-intern/pull/7/checks',
      pull_requests: [{ number: 7 }],
    },
    ...overrides,
  };
}

describe('handleGitHub allowlist gating', () => {
  it('ignores authors not in ALLOWED_USERS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({ eventType: 'issue_comment', body: issueCommentPayload() }),
      baseGithubEnv({ ALLOWED_USERS: 'bob, carol' })
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: author not in allowlist');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows authors in ALLOWED_USERS through to further gating', async () => {
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: issueCommentPayload({ comment: { user: { login: 'alice' }, body: 'no mention here' } }),
      }),
      baseGithubEnv({ ALLOWED_USERS: 'alice, carol' })
    );

    // Passes the allowlist, but is still rejected by the mention gate below.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      'ignored: bot not mentioned and not a comment on a bot-authored thread'
    );
  });

  it('skips the allowlist check entirely when ALLOWED_USERS is unset', async () => {
    const res = await worker.fetch(
      githubRequest({ eventType: 'push', body: issueCommentPayload() }),
      baseGithubEnv()
    );

    // No allowlist configured, so it falls through to the event-type gate.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: event type');
  });

  it('ignores payloads with no resolvable author when an allowlist is configured', async () => {
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: { installation: { id: 42 }, comment: { body: '@the-intern-bot' } },
      }),
      baseGithubEnv({ ALLOWED_USERS: 'alice' })
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: author not in allowlist');
  });
});

describe('handleGitHub event-type filtering', () => {
  it.each(['push', 'pull_request', 'star', 'workflow_run'])(
    'ignores irrelevant event type %s',
    async eventType => {
      const res = await worker.fetch(
        githubRequest({ eventType, body: issueCommentPayload() }),
        baseGithubEnv()
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ignored: event type');
    }
  );

  it.each(['issue_comment', 'pull_request_review', 'pull_request_review_comment'])(
    'accepts relevant event type %s through to the mention gate',
    async eventType => {
      const overrides = { comment: { user: { login: 'alice' }, body: 'no mention' } };
      if (eventType === 'pull_request_review') {
        overrides.review = { body: 'no mention' };
      }
      if (eventType === 'pull_request_review_comment') {
        overrides.comment.pull_request_review_id = 123;
      }
      const res = await worker.fetch(
        githubRequest({
          eventType,
          body: issueCommentPayload(overrides),
        }),
        baseGithubEnv()
      );
      // Relevant event type but no mention -> rejected by the next gate, not this one.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(
        'ignored: bot not mentioned and not a comment on a bot-authored thread'
      );
    }
  );
});

describe('handleGitHub @the-intern-bot mention gating', () => {
  it('dispatches when the comment mentions the bot', async () => {
    mockGithubDispatchFlow();
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: issueCommentPayload({
          comment: { user: { login: 'alice' }, body: 'Hey @the-intern-bot can you look at this?' },
        }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('mention detection is case-insensitive', async () => {
    mockGithubDispatchFlow();
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: issueCommentPayload({
          comment: { user: { login: 'alice' }, body: '@THE-INTERN-BOT please help' },
        }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('dispatches for a reply on a bot-authored thread even without a mention', async () => {
    mockGithubDispatchFlow();
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: issueCommentPayload({
          comment: { user: { login: 'alice' }, body: 'sounds good, go ahead' },
          issue: { user: { login: 'the-intern-bot[bot]' } },
        }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('ignores comments the bot posts on its own thread, to avoid self-triggering', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: issueCommentPayload({
          comment: { user: { login: 'the-intern-bot[bot]' }, body: 'working on it...' },
          issue: { user: { login: 'the-intern-bot[bot]' } },
        }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      'ignored: bot not mentioned and not a comment on a bot-authored thread'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores comments with neither a mention nor a bot-authored thread', async () => {
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: issueCommentPayload({
          comment: { user: { login: 'alice' }, body: 'just a regular comment' },
          issue: { user: { login: 'someone-else' } },
        }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      'ignored: bot not mentioned and not a comment on a bot-authored thread'
    );
  });
});

describe('handleGitHub dispatch', () => {
  it('returns 400 when the payload has no installation id', async () => {
    const res = await worker.fetch(
      githubRequest({
        eventType: 'issue_comment',
        body: issueCommentPayload({ installation: undefined }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('missing installation id');
  });

  it('sends the raw payload and event type to the agent-infra repository_dispatch endpoint', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const payload = issueCommentPayload();

    const res = await worker.fetch(
      githubRequest({ eventType: 'issue_comment', body: payload }),
      baseGithubEnv({ AGENT_INFRA_OWNER: 'acme', AGENT_INFRA_REPO: 'infra' })
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    const dispatchCall = fetchSpy.mock.calls.find(([input]) =>
      new URL(input.url ?? input).pathname.endsWith('/dispatches')
    );
    expect(dispatchCall).toBeTruthy();
    const [dispatchRequest, dispatchInit] = dispatchCall;
    const url = new URL(dispatchRequest.url ?? dispatchRequest);
    expect(url.toString()).toBe('https://api.github.com/repos/acme/infra/dispatches');
    expect(dispatchInit.headers.Authorization).toBe('Bearer test-installation-token');

    const body = JSON.parse(dispatchInit.body);
    expect(body.event_type).toBe('issue_comment');
    expect(body.client_payload.raw).toEqual(payload);
  });

  it('returns 502 when the dispatch call fails', async () => {
    mockGithubDispatchFlow({ dispatchOk: false });
    const res = await worker.fetch(
      githubRequest({ eventType: 'issue_comment', body: issueCommentPayload() }),
      baseGithubEnv()
    );
    expect(res.status).toBe(502);
  });

  it('returns 500 when the App credentials are missing', async () => {
    const res = await worker.fetch(
      githubRequest({ eventType: 'issue_comment', body: issueCommentPayload() }),
      baseGithubEnv({ APP_ID: undefined, APP_PRIVATE_KEY: undefined })
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/APP_ID and APP_PRIVATE_KEY/);
  });
});

describe('handleGitHub signature verification', () => {
  async function sign(body, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    return 'sha256=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  it('rejects requests with a bad signature when WEBHOOK_SECRET is configured', async () => {
    const body = JSON.stringify(issueCommentPayload());
    const res = await worker.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'X-GitHub-Event': 'issue_comment', 'X-Hub-Signature-256': 'sha256=deadbeef' },
        body,
      }),
      baseGithubEnv({ WEBHOOK_SECRET: 'shh' })
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('bad signature');
  });

  it('accepts requests with a valid signature', async () => {
    mockGithubDispatchFlow();
    const payload = issueCommentPayload();
    const body = JSON.stringify(payload);
    const signature = await sign(body, 'shh');

    const res = await worker.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'X-GitHub-Event': 'issue_comment', 'X-Hub-Signature-256': signature },
        body,
      }),
      baseGithubEnv({ WEBHOOK_SECRET: 'shh' })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('handleGitHub coderabbit_review handling', () => {
  it('dispatches coderabbit_review when CodeRabbit reviews a bot-authored PR', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const res = await worker.fetch(
      githubRequest({ eventType: 'pull_request_review', body: coderabbitReviewPayload() }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    const dispatchCall = fetchSpy.mock.calls.find(([input]) =>
      new URL(input.url ?? input).pathname.endsWith('/dispatches')
    );
    expect(dispatchCall).toBeTruthy();
    const [, dispatchInit] = dispatchCall;
    const body = JSON.parse(dispatchInit.body);
    expect(body.event_type).toBe('coderabbit_review');
    expect(body.client_payload.raw.pull_request.number).toBe(7);
    expect(body.client_payload.raw.coderabbit_review.html_url).toBe(
      'https://github.com/TheDeepestSpace/the-intern/pull/7#pullrequestreview-1'
    );
    // The review body is never forwarded, even though it was present on the raw webhook payload.
    expect(JSON.stringify(body)).not.toContain('Secret injected instructions');
  });

  it('bypasses the ALLOWED_USERS allowlist for CodeRabbit reviews', async () => {
    mockGithubDispatchFlow();
    const res = await worker.fetch(
      githubRequest({ eventType: 'pull_request_review', body: coderabbitReviewPayload() }),
      baseGithubEnv({ ALLOWED_USERS: 'alice, carol' })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('ignores a CodeRabbit review on a PR not authored by the bot', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({
        eventType: 'pull_request_review',
        body: coderabbitReviewPayload({ pull_request: { number: 7, user: { login: 'someone-else' } } }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: coderabbit review not on a bot-authored PR');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores CodeRabbit review events that are not action=submitted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({
        eventType: 'pull_request_review',
        body: coderabbitReviewPayload({ action: 'edited' }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: coderabbit review not submitted');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when the payload has no installation id', async () => {
    const res = await worker.fetch(
      githubRequest({
        eventType: 'pull_request_review',
        body: coderabbitReviewPayload({ installation: undefined }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('missing installation id');
  });

  it('does not affect human pull_request_review handling', async () => {
    mockGithubDispatchFlow();
    const res = await worker.fetch(
      githubRequest({
        eventType: 'pull_request_review',
        body: issueCommentPayload({
          comment: undefined,
          review: { user: { login: 'alice' }, body: 'Hey @the-intern-bot please check this' },
        }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('handleGitHub check_suite handling', () => {
  it('dispatches ci_failure when CI fails on a bot-authored PR', async () => {
    const fetchSpy = mockCheckSuiteDispatchFlow();
    const res = await worker.fetch(
      githubRequest({ eventType: 'check_suite', body: checkSuitePayload() }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    const dispatchCall = fetchSpy.mock.calls.find(([input]) =>
      new URL(input.url ?? input).pathname.endsWith('/dispatches')
    );
    expect(dispatchCall).toBeTruthy();
    const [, dispatchInit] = dispatchCall;
    const body = JSON.parse(dispatchInit.body);
    expect(body.event_type).toBe('ci_failure');
    expect(body.client_payload.raw.pull_request.number).toBe(7);
    expect(body.client_payload.raw.check_suite.conclusion).toBe('failure');
  });

  it('ignores a check_suite failure on a PR not authored by the bot', async () => {
    const fetchSpy = mockCheckSuiteDispatchFlow({ pullRequestAuthor: 'someone-else' });
    const res = await worker.fetch(
      githubRequest({ eventType: 'check_suite', body: checkSuitePayload() }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: no bot-authored pull requests');

    const dispatchCall = fetchSpy.mock.calls.find(([input]) =>
      new URL(input.url ?? input).pathname.endsWith('/dispatches')
    );
    expect(dispatchCall).toBeUndefined();
  });

  it('ignores check_suite with conclusion=success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({
        eventType: 'check_suite',
        body: checkSuitePayload({ check_suite: { ...checkSuitePayload().check_suite, conclusion: 'success' } }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['requested', 'in_progress'])('ignores check_suite action=%s', async action => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({ eventType: 'check_suite', body: checkSuitePayload({ action }) }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores check_suite with no associated pull requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      githubRequest({
        eventType: 'check_suite',
        body: checkSuitePayload({ check_suite: { ...checkSuitePayload().check_suite, pull_requests: [] } }),
      }),
      baseGithubEnv()
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
