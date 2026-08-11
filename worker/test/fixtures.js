import { vi } from 'vitest';

// Test-only RSA key pair, unrelated to any real GitHub App. Used to exercise
// the JWT-minting path (mintAppJwt / getInstallationToken) against mocked fetch.
export const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCtJWWRKadsu92N
MFrM24TJKCsWNLW4ve/Wrh9TxxlCytqintPBsURgUhsLLivhvjgweucDg+6OidAq
seOAuwv/QOPILhcfkXjhcx5+ZdWHCjAUYIkJaGF/gJzW8egRDw2d482/1oCUP/Vl
bH86P/YuDjT/UrnWo0yQlbcME66fn3/k3Umuni1P//+3LPCIxWGR/IpiADOJOJGH
eSJcckch3LGQbHlOQbIhdq2bHZr8rw86yB8UET23diCcCsCw5wlyjIfno9GU9JsJ
C3wGJ/sf5H4DwVoy1LzHz2Ecfl5jooIJV3gahSEf7VmlcAS5mlAfY35o2IND6D6D
VV8OK+5NAgMBAAECggEAEwY5DC5K+T1aa6vPS5NSb4sXJ4f1cDiHtItfjCQj/ZJD
W+XeoiQY6Aptcpjen8hM7TVmfPI55nXJpmny83nZ03CCS+7rLH/z4Qr14/EgI90g
iO9NxKJa6sMAuJ9OHn23GHeSFkzPxjo8Jio51SEiVU91+Zh8gdMMfmsXeIoQavT8
Nq1jT5p5TTDXt/i1xC+fBtOHLY2va580Yowih0Nm6eBDIQ3Pwa+E0FwHFeI4pPO0
fG0nQ5Qa+6mTDNilvaOyb8Qu54rVXnh3VPoWejSPBRfe6POF0B+PNUiUmU3FLDGZ
fGfkXnjYYlnUVd2RiwT3QGdyfA+EqTLEeqN/sEGIwwKBgQDlsCm8ibJiIlQ+P20j
px46IAVPDmz4V3uzhYV0bYvenFLi+Vdq3fDEcrVZYxK9eNzZlN+xw8cxxD8bLrIz
xgsXJHU0w75xPWE5iucYIKKE0/unvvveeB0dQwDPhkVx3IxprVUg6iYLP4n6XBF+
bwReTIMaDg9TrlsUxyvTiJbo3wKBgQDA+xSqnFoYa37knfIjfQveoz/81H7U4M/z
wZLMjveJrOGvHauWgxDONkt1y2LmyaZGrzShdBOP2SXTE8dkDX0NE5rPxoqTPzL+
/NanFxi2zh1YqnHsD5C5VzOxala5CeNeY770dKDlcs+gKr6965kOvlgsuOb85d1a
1z9SCzlSUwKBgQCeiDKmcRvwY+VleX2o6AYS9Fr1r+1Ck49L31K3g4zQv3DuPE87
8afmz42f/qPGpw84Fms3VPu9u8gayOYymfS5qm5DVv+xRT4/60GKA6xopa/Cni1V
5e2ibsa2deSkrCc2IW7qYvKTPO3NIZLpg1Kui3zJlP67MVKoSrhTLqmKXQKBgExQ
vqp9rE9t6z+DiqcoI1KHIp3cds++m94cle4ZN6EVYiZ7SEj8SeASrqLFrLXx1rSr
Qtf6bGX9jKy9bKOPhf1u3FEAhfqXCpa17DkltBtOxWIz/VtKCISTDJlDoUoJtAW2
0mQf3yT900fWv5mhmuSut3XwJUCrsm7jImJSl/eLAoGAUeWnlIGXPv9pGjU7jTIV
yy06SFutKxn/h9qYLVmeZSGGVavdZh+V3GG9WJcrJ8OTWrxZhu0vQ5PbtRSNMDGk
Jmh8S78pAwDjEOkUm1OwvuPnTd/FTCfYYSNwYcHQtbpa0Bmb2BtwvRsHI/7QXjC5
x+5cnF2ELJLfKQLUoHHywfw=
-----END PRIVATE KEY-----
`;

export function baseGithubEnv(overrides = {}) {
  return {
    APP_ID: '12345',
    APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
    AGENT_INFRA_OWNER: 'TheDeepestSpace',
    AGENT_INFRA_REPO: 'the-intern',
    ...overrides,
  };
}

export function baseTelegramEnv(overrides = {}) {
  return {
    APP_ID: '12345',
    APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
    AGENT_INFRA_INSTALLATION_ID: '999',
    AGENT_INFRA_OWNER: 'TheDeepestSpace',
    AGENT_INFRA_REPO: 'the-intern',
    ...overrides,
  };
}

export function githubRequest({ eventType = 'issue_comment', body, headers = {} } = {}) {
  return new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'X-GitHub-Event': eventType,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export function telegramRequest({ update, headers = {} } = {}) {
  return new Request('https://example.com/telegram', {
    method: 'POST',
    headers: { ...headers },
    body: JSON.stringify(update),
  });
}

// Shared handler for the access-token and dispatch branches used by both
// mockGithubDispatchFlow and mockInstallationLookupAndDispatchFlow below.
// When installationId is set, also serves the installation-id lookup
// (GET /repos/:owner/:repo/installation), used on the Telegram-triggered path.
function githubApiFetchHandler({ installationId, dispatchOk = true, pullRequestAuthor } = {}) {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (
      installationId !== undefined &&
      request.method === 'GET' &&
      url.pathname.match(/^\/repos\/.+\/.+\/installation$/)
    ) {
      return new Response(JSON.stringify({ id: installationId }), { status: 200 });
    }

    if (
      pullRequestAuthor !== undefined &&
      request.method === 'GET' &&
      url.pathname.match(/^\/repos\/.+\/.+\/pulls\/\d+$/)
    ) {
      const number = Number(url.pathname.split('/').pop());
      return new Response(
        JSON.stringify({ number, user: { login: pullRequestAuthor } }),
        { status: 200 }
      );
    }

    if (
      request.method === 'POST' &&
      url.pathname.match(/^\/app\/installations\/\d+\/access_tokens$/)
    ) {
      return new Response(JSON.stringify({ token: 'test-installation-token' }), { status: 201 });
    }

    if (request.method === 'POST' && url.pathname.match(/\/repos\/.+\/.+\/dispatches$/)) {
      return dispatchOk
        ? new Response(null, { status: 204 })
        : new Response('nope', { status: 422 });
    }

    throw new Error(`Unexpected fetch: ${request.method} ${url.pathname}`);
  };
}

// Mocks the two outbound GitHub API calls made once gating passes:
// installation-token mint, then repository_dispatch. Returns a spy so tests
// can assert on the dispatch call's body/headers.
export function mockGithubDispatchFlow({ dispatchOk = true } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(githubApiFetchHandler({ dispatchOk }));
}

// Like mockGithubDispatchFlow, but also serves the installation-id lookup
// (GET /repos/:owner/:repo/installation) used when AGENT_INFRA_INSTALLATION_ID
// isn't preset, i.e. the Telegram-triggered path.
export function mockInstallationLookupAndDispatchFlow({ installationId = 999, dispatchOk = true } = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(githubApiFetchHandler({ installationId, dispatchOk }));
}

// Mocks the check_suite flow's three outbound calls: installation-token mint,
// PR lookup (GET /repos/:owner/:repo/pulls/:number), then repository_dispatch.
export function mockCheckSuiteDispatchFlow({ pullRequestAuthor = 'the-intern-bot[bot]', dispatchOk = true } = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(githubApiFetchHandler({ pullRequestAuthor, dispatchOk }));
}

// Mocks the push flow's outbound calls: installation-token mint, listing open
// PRs targeting the pushed branch (GET /repos/:owner/:repo/pulls), polling
// mergeable_state per PR (GET /repos/:owner/:repo/pulls/:number — returning
// null `nullPollsBeforeState[number]` times before settling, to exercise the
// retry-past-null path), then repository_dispatch for any PR that comes back
// dirty.
export function mockPushDispatchFlow({
  openPulls = [{ number: 7, user: { login: 'the-intern-bot[bot]' } }],
  mergeableStates = {},
  nullPollsBeforeState = {},
  dispatchOk = true,
} = {}) {
  const pollCounts = {};
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname.match(/^\/app\/installations\/\d+\/access_tokens$/)) {
      return new Response(JSON.stringify({ token: 'test-installation-token' }), { status: 201 });
    }

    if (request.method === 'GET' && url.pathname.match(/^\/repos\/.+\/.+\/pulls$/)) {
      return new Response(JSON.stringify(openPulls), { status: 200 });
    }

    if (request.method === 'GET' && url.pathname.match(/^\/repos\/.+\/.+\/pulls\/\d+$/)) {
      const number = Number(url.pathname.split('/').pop());
      pollCounts[number] = (pollCounts[number] || 0) + 1;
      const nullPolls = nullPollsBeforeState[number] || 0;
      const mergeableState =
        pollCounts[number] <= nullPolls ? null : mergeableStates[number] ?? null;
      return new Response(JSON.stringify({ number, mergeable_state: mergeableState }), {
        status: 200,
      });
    }

    if (request.method === 'POST' && url.pathname.match(/\/repos\/.+\/.+\/dispatches$/)) {
      return dispatchOk
        ? new Response(null, { status: 204 })
        : new Response('nope', { status: 422 });
    }

    throw new Error(`Unexpected fetch: ${request.method} ${url.pathname}`);
  });
}
