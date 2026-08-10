import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { mintToken, applyToken, runLoop } from '../refresh-gh-token.js';

// A throwaway RSA key generated fresh per test run; only used to exercise the
// signing code path, never a real credential.
const { privateKey: TEST_PRIVATE_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('mintToken', () => {
  let originalDispatcher;
  let agent;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  it('throws when APP_ID/APP_PRIVATE_KEY are missing', async () => {
    await expect(mintToken({ TARGET_REPO: 'acme/widgets' })).rejects.toThrow(
      'APP_ID and APP_PRIVATE_KEY are required'
    );
  });

  it('mints a repo-scoped token by default', async () => {
    const client = agent.get('https://api.github.com');
    client
      .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
      .reply(200, { id: 555 });
    client
      .intercept({
        method: 'POST',
        path: '/app/installations/555/access_tokens',
        body: (body) => JSON.parse(body).repositories?.[0] === 'widgets',
      })
      .reply(201, { token: 'ghs_scoped' });

    const token = await mintToken({
      APP_ID: '123',
      APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      TARGET_REPO: 'acme/widgets',
    });

    expect(token).toBe('ghs_scoped');
  });

  it('mints an installation-wide token when SCOPE_TO_REPO is false', async () => {
    const client = agent.get('https://api.github.com');
    client
      .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
      .reply(200, { id: 555 });
    client
      .intercept({
        method: 'POST',
        path: '/app/installations/555/access_tokens',
      })
      .reply(201, { token: 'ghs_unscoped' });

    const token = await mintToken({
      APP_ID: '123',
      APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      TARGET_REPO: 'acme/widgets',
      SCOPE_TO_REPO: 'false',
    });

    expect(token).toBe('ghs_unscoped');
  });
});

describe('applyToken', () => {
  it('logs a mask directive and re-authenticates gh as the dev user, without putting the token in argv', () => {
    const calls = [];
    const exec = (cmd, args, opts) => calls.push({ cmd, args, opts });
    const logs = [];
    const originalLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      applyToken('ghs_secret', { env: { PATH: '/usr/bin' }, exec });
    } finally {
      console.log = originalLog;
    }

    expect(logs).toContain('::add-mask::ghs_secret');
    expect(calls).toHaveLength(1);
    const [{ cmd, args, opts }] = calls;
    expect(cmd).toBe('su');
    expect(args).toEqual(['dev', '-c', 'echo "$REFRESHED_GH_TOKEN" | gh auth login --with-token']);
    expect(args.join(' ')).not.toContain('ghs_secret');
    expect(opts.env.REFRESHED_GH_TOKEN).toBe('ghs_secret');
    expect(opts.env.PATH).toBe('/usr/bin');
  });
});

describe('runLoop', () => {
  let originalDispatcher;
  let agent;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  it('mints and applies a token once per iteration', async () => {
    const client = agent.get('https://api.github.com');
    client
      .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
      .reply(200, { id: 555 })
      .times(2);
    client
      .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
      .reply(201, { token: 'ghs_loop' })
      .times(2);

    const calls = [];
    const exec = (cmd, args, opts) => calls.push({ cmd, args, opts });

    await runLoop({
      intervalMs: 0,
      maxIterations: 2,
      env: { APP_ID: '123', APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM, TARGET_REPO: 'acme/widgets' },
      exec,
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.opts.env.REFRESHED_GH_TOKEN === 'ghs_loop')).toBe(true);
  });

  it('logs a warning and keeps going when a single iteration fails', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (msg) => errors.push(msg);
    const calls = [];
    const exec = (cmd, args, opts) => calls.push({ cmd, args, opts });

    try {
      await runLoop({
        intervalMs: 0,
        maxIterations: 1,
        env: {}, // missing APP_ID/APP_PRIVATE_KEY
        exec,
      });
    } finally {
      console.error = originalError;
    }

    expect(calls).toHaveLength(0);
    expect(errors.some((msg) => msg.includes('::warning::Background token refresh failed'))).toBe(true);
  });
});
