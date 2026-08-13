import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DATA_REPO, resolveDataRepoRemoteUrl, redactUrl, runWithRetryOnNotFound } from '../data-repo-remote.js';

describe('data-repo-remote', () => {
  let originalDataRepoToken;
  let originalDataRemoteUrl;

  beforeEach(() => {
    originalDataRepoToken = process.env.DATA_REPO_TOKEN;
    originalDataRemoteUrl = process.env.DATA_REPO_REMOTE_URL;
    delete process.env.DATA_REPO_REMOTE_URL;
  });

  afterEach(() => {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('DATA_REPO_TOKEN', originalDataRepoToken);
    restore('DATA_REPO_REMOTE_URL', originalDataRemoteUrl);
  });

  describe('resolveDataRepoRemoteUrl', () => {
    it('returns null when DATA_REPO_TOKEN is not set', async () => {
      delete process.env.DATA_REPO_TOKEN;

      expect(await resolveDataRepoRemoteUrl()).toBeNull();
    });

    it('composes the x-access-token URL from DATA_REPO_TOKEN', async () => {
      process.env.DATA_REPO_TOKEN = 'ghp_datarepotoken';

      const url = await resolveDataRepoRemoteUrl();

      expect(url).toBe(`https://x-access-token:ghp_datarepotoken@github.com/${DATA_REPO}.git`);
    });

    it('prefers the DATA_REPO_REMOTE_URL override over DATA_REPO_TOKEN', async () => {
      process.env.DATA_REPO_TOKEN = 'ghp_datarepotoken';
      process.env.DATA_REPO_REMOTE_URL = '/tmp/some-local-bare-repo.git';

      expect(await resolveDataRepoRemoteUrl()).toBe('/tmp/some-local-bare-repo.git');
    });
  });

  describe('runWithRetryOnNotFound', () => {
    it('reuses the same url across retries on a transient "Repository not found", then succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const run = vi.fn()
        .mockRejectedValueOnce(new Error('fatal: Repository not found.'))
        .mockImplementationOnce((url) => url);

      const result = await runWithRetryOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retries: 3, retryBaseDelayMs: 0 });

      expect(result).toBe('https://x-access-token:ghs_first@github.com/x.git');
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, 'https://x-access-token:ghs_first@github.com/x.git');
      expect(run).toHaveBeenNthCalledWith(2, 'https://x-access-token:ghs_first@github.com/x.git');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('reuses the same url across retries on a transient GitHub 5xx, then succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const run = vi.fn()
        .mockRejectedValueOnce(new Error('remote: Internal Server Error.'))
        .mockImplementationOnce((url) => url);

      const result = await runWithRetryOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retries: 3, retryBaseDelayMs: 0 });

      expect(result).toBe('https://x-access-token:ghs_first@github.com/x.git');
      expect(run).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).not.toMatch(/Repository not found/);

      warnSpy.mockRestore();
    });

    it('gives up and throws the last error after exhausting retries on a persistent "Repository not found"', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const run = vi.fn().mockRejectedValue(new Error('fatal: Repository not found.'));

      await expect(
        runWithRetryOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retries: 3, retryBaseDelayMs: 0 })
      ).rejects.toThrow(/Repository not found/);
      expect(run).toHaveBeenCalledTimes(4);
    });

    it('does not retry a non-transient error', async () => {
      const run = vi.fn().mockRejectedValue(new Error('fatal: could not read Username'));

      await expect(
        runWithRetryOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, { retryBaseDelayMs: 0 })
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

      const promise = runWithRetryOnNotFound('https://x-access-token:ghs_first@github.com/x.git', run, {
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
