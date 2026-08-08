import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { DATA_REPO, resolveDataRepoRemoteUrl, redactUrl } from '../data-repo-remote.js';

// A throwaway RSA key generated fresh per test run; only used to exercise the
// signing code path, never a real credential.
const { privateKey: TEST_PRIVATE_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('data-repo-remote', () => {
  let originalDispatcher;
  let agent;
  let originalAppId;
  let originalAppPrivateKey;
  let originalDataRemoteUrl;
  let originalGithubActions;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);

    originalAppId = process.env.APP_ID;
    originalAppPrivateKey = process.env.APP_PRIVATE_KEY;
    originalDataRemoteUrl = process.env.DATA_REPO_REMOTE_URL;
    originalGithubActions = process.env.GITHUB_ACTIONS;
    delete process.env.DATA_REPO_REMOTE_URL;
  });

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);

    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('APP_ID', originalAppId);
    restore('APP_PRIVATE_KEY', originalAppPrivateKey);
    restore('DATA_REPO_REMOTE_URL', originalDataRemoteUrl);
    restore('GITHUB_ACTIONS', originalGithubActions);
  });

  describe('resolveDataRepoRemoteUrl', () => {
    it('returns null when APP_ID/APP_PRIVATE_KEY are not set', async () => {
      delete process.env.APP_ID;
      delete process.env.APP_PRIVATE_KEY;

      expect(await resolveDataRepoRemoteUrl()).toBeNull();
    });

    it('mints a token and composes the x-access-token URL for the-intern-data', async () => {
      process.env.APP_ID = '123';
      process.env.APP_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;

      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: `/repos/${DATA_REPO}/installation` })
        .reply(200, { id: 555 });
      client
        .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
        .reply(201, { token: 'ghs_datarepotoken' });

      const url = await resolveDataRepoRemoteUrl();

      expect(url).toBe(`https://x-access-token:ghs_datarepotoken@github.com/${DATA_REPO}.git`);
    });

    it('propagates the real cause when token minting fails, instead of masking it as unconfigured', async () => {
      process.env.APP_ID = '123';
      process.env.APP_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;

      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: `/repos/${DATA_REPO}/installation` })
        .reply(200, { id: 555 });
      client
        .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
        .reply(401, 'Bad credentials');

      await expect(resolveDataRepoRemoteUrl()).rejects.toThrow(/Bad credentials/);
    });

    it('prefers the DATA_REPO_REMOTE_URL override over minting', async () => {
      process.env.APP_ID = '123';
      process.env.APP_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;
      process.env.DATA_REPO_REMOTE_URL = '/tmp/some-local-bare-repo.git';

      expect(await resolveDataRepoRemoteUrl()).toBe('/tmp/some-local-bare-repo.git');
    });

    it('masks the minted token in Actions logs only when running on a GitHub Actions runner', async () => {
      process.env.APP_ID = '123';
      process.env.APP_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;

      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: `/repos/${DATA_REPO}/installation` })
        .reply(200, { id: 555 })
        .times(2);
      client
        .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
        .reply(201, { token: 'ghs_datarepotoken' })
        .times(2);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      delete process.env.GITHUB_ACTIONS;
      await resolveDataRepoRemoteUrl();
      expect(logSpy.mock.calls.some(([line]) => line?.includes('::add-mask::'))).toBe(false);

      logSpy.mockClear();
      process.env.GITHUB_ACTIONS = 'true';
      await resolveDataRepoRemoteUrl();
      expect(logSpy.mock.calls.some(([line]) => line === '::add-mask::ghs_datarepotoken')).toBe(true);

      logSpy.mockRestore();
    });
  });

  describe('redactUrl', () => {
    it('redacts basic-auth credentials embedded in a URL', () => {
      expect(redactUrl(`fetch https://x-access-token:ghs_secret123@github.com/${DATA_REPO}.git pending-retries:pending-retries`))
        .toBe(`fetch https://***:***@github.com/${DATA_REPO}.git pending-retries:pending-retries`);
    });

    it('redacts token-only userinfo embedded in a URL', () => {
      expect(redactUrl(`fetch https://ghs_secret123@github.com/${DATA_REPO}.git pending-retries:pending-retries`))
        .toBe(`fetch https://***:***@github.com/${DATA_REPO}.git pending-retries:pending-retries`);
    });

    it('leaves strings with no embedded credentials unchanged', () => {
      const message = 'fatal: could not read Username for \'https://github.com\'';
      expect(redactUrl(message)).toBe(message);
    });
  });
});
