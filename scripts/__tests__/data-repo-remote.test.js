import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { DATA_REPO, resolveDataRepoRemoteUrl, redactUrl, runWithFreshRemoteOnNotFound } from '../data-repo-remote.js';

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

  describe('runWithFreshRemoteOnNotFound', () => {
    function mockMint(token) {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: `/repos/${DATA_REPO}/installation` })
        .reply(200, { id: 555 });
      client
        .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
        .reply(201, { token });
    }

    beforeEach(() => {
      process.env.APP_ID = '123';
      process.env.APP_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;
    });

    it('reuses the same url across retries on a transient "Repository not found", then succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const run = vi.fn()
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockImplementationOnce((url) => url);

      const result = await runWithFreshRemoteOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retries: 3, retryBaseDelayMs: 0 });

      expect(result).toBe('https://x-access-token:ghs_first@github.com/x.git');
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, 'https://x-access-token:ghs_first@github.com/x.git');
      expect(run).toHaveBeenNthCalledWith(2, 'https://x-access-token:ghs_first@github.com/x.git');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('re-mints a fresh token as a last resort right before the final attempt', async () => {
      mockMint('ghs_second');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const run = vi.fn()
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockImplementationOnce((url) => url);

      const result = await runWithFreshRemoteOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retries: 2, retryBaseDelayMs: 0 });

      expect(result).toBe(`https://x-access-token:ghs_second@github.com/${DATA_REPO}.git`);
      expect(run).toHaveBeenCalledTimes(3);
      expect(run).toHaveBeenNthCalledWith(1, 'https://x-access-token:ghs_first@github.com/x.git');
      expect(run).toHaveBeenNthCalledWith(2, 'https://x-access-token:ghs_first@github.com/x.git');
      expect(run).toHaveBeenNthCalledWith(3, `https://x-access-token:ghs_second@github.com/${DATA_REPO}.git`);
    });

    it('gives up and throws the last error after exhausting retries on a persistent "Repository not found"', async () => {
      mockMint('ghs_second');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const run = vi.fn().mockRejectedValue(new Error('fatal: Repository not found.'));

      await expect(
        runWithFreshRemoteOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retries: 3, retryBaseDelayMs: 0 })
      ).rejects.toThrow(/Repository not found/);
      expect(run).toHaveBeenCalledTimes(4);
    });

    it('does not retry (or re-mint) a non-transient error', async () => {
      const run = vi.fn().mockRejectedValue(new Error('fatal: could not read Username'));

      await expect(
        runWithFreshRemoteOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retryBaseDelayMs: 0 })
      ).rejects.toThrow(/could not read Username/);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('uses capped exponential backoff between retries', async () => {
      vi.useFakeTimers();
      const run = vi.fn()
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockImplementationOnce((url) => url);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const promise = runWithFreshRemoteOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, {
        // retries is > the number of rejections below so the 6th (successful)
        // attempt isn't the last attempt, which would otherwise trigger the
        // last-resort re-mint path (and its own network call) instead of
        // just retrying with the same url.
        retries: 6,
        retryBaseDelayMs: 2000,
        retryMaxDelayMs: 20000,
      });
      // Flush pending microtasks before advancing fake timers so each rejected
      // run() call is observed before the next sleep is scheduled.
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(run).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(4000);
      expect(run).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(8000);
      expect(run).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(16000);
      expect(run).toHaveBeenCalledTimes(5);

      // Uncapped this would be 32000ms (2000 * 2^4); confirm it's capped at 20000.
      await vi.advanceTimersByTimeAsync(20000);
      expect(run).toHaveBeenCalledTimes(6);

      await expect(promise).resolves.toBe('https://x-access-token:ghs_first@github.com/x.git');

      vi.useRealTimers();
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
