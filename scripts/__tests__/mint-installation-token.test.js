import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { getInstallationToken, mintAppJwt, getPrivateKey } from '../mint-installation-token.js';

// A throwaway RSA key generated fresh per test run; only used to exercise the
// signing code path, never a real credential.
const { privateKey: TEST_PRIVATE_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('mint-installation-token', () => {
  describe('mintAppJwt', () => {
    it('produces a three-part JWT with the app id as issuer', () => {
      const jwt = mintAppJwt('123', TEST_PRIVATE_KEY_PEM);
      const [headerB64, payloadB64, signatureB64] = jwt.split('.');
      expect(signatureB64).toBeTruthy();

      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      expect(payload.iss).toBe('123');
      expect(payload.exp).toBeGreaterThan(payload.iat);

      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      expect(header.alg).toBe('RS256');
    });

    it('accepts a base64-encoded private key (no PEM header)', () => {
      const encoded = Buffer.from(TEST_PRIVATE_KEY_PEM, 'utf8').toString('base64');
      const jwt = mintAppJwt('123', encoded);
      expect(jwt.split('.')).toHaveLength(3);
    });
  });

  describe('getPrivateKey', () => {
    it('prefers APP_PRIVATE_KEY when set', () => {
      const key = getPrivateKey({ APP_PRIVATE_KEY: 'whole-key', APP_PRIVATE_KEY_PART1: 'ignored' });
      expect(key).toBe('whole-key');
    });

    it('concatenates APP_PRIVATE_KEY_PART1..N in order when the whole key is absent', () => {
      const key = getPrivateKey({
        APP_PRIVATE_KEY_PART2: 'second',
        APP_PRIVATE_KEY_PART1: 'first',
        APP_PRIVATE_KEY_PART3: 'third',
      });
      expect(key).toBe('firstsecondthird');
    });

    it('returns an empty string when no key material is present', () => {
      expect(getPrivateKey({})).toBe('');
    });
  });

  describe('getInstallationToken', () => {
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

    it('throws when appId is missing', async () => {
      await expect(
        getInstallationToken({ appId: '', privateKey: TEST_PRIVATE_KEY_PEM, installationId: '1' })
      ).rejects.toThrow('Missing APP_ID secret');
    });

    it('throws when privateKey is missing', async () => {
      await expect(
        getInstallationToken({ appId: '123', privateKey: '', installationId: '1' })
      ).rejects.toThrow('Missing APP_PRIVATE_KEY secret');
    });

    it('mints a token directly when installationId is already known', async () => {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'POST', path: '/app/installations/999/access_tokens' })
        .reply(201, { token: 'ghs_directtoken' });

      const token = await getInstallationToken({
        appId: '123',
        privateKey: TEST_PRIVATE_KEY_PEM,
        installationId: '999',
      });

      expect(token).toBe('ghs_directtoken');
    });

    it('resolves installationId from target_repo when not provided', async () => {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
        .reply(200, { id: 555 });
      client
        .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
        .reply(201, { token: 'ghs_resolvedtoken' });

      const token = await getInstallationToken({
        appId: '123',
        privateKey: TEST_PRIVATE_KEY_PEM,
        targetRepo: 'acme/widgets',
      });

      expect(token).toBe('ghs_resolvedtoken');
    });

    it('throws when installation lookup fails and no installationId can be resolved', async () => {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: '/repos/acme/missing/installation' })
        .reply(404, 'Not Found')
        .times(1);

      await expect(
        getInstallationToken({
          appId: '123',
          privateKey: TEST_PRIVATE_KEY_PEM,
          targetRepo: 'acme/missing',
          retries: 1,
        })
      ).rejects.toThrow('Could not determine installationId for repo: acme/missing');
    });

    it('retries the installation lookup on a transient failure and succeeds', async () => {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
        .reply(404, 'remote: Repository not found.')
        .times(2);
      client
        .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
        .reply(200, { id: 555 });
      client
        .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
        .reply(201, { token: 'ghs_retriedtoken' });

      const token = await getInstallationToken({
        appId: '123',
        privateKey: TEST_PRIVATE_KEY_PEM,
        targetRepo: 'acme/widgets',
        retries: 3,
        retryDelayMs: 0,
      });

      expect(token).toBe('ghs_retriedtoken');
    });

    it('retries the installation lookup when fetch itself rejects and succeeds', async () => {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
        .replyWithError(new Error('getaddrinfo ENOTFOUND api.github.com'));
      client
        .intercept({ method: 'GET', path: '/repos/acme/widgets/installation' })
        .reply(200, { id: 555 });
      client
        .intercept({ method: 'POST', path: '/app/installations/555/access_tokens' })
        .reply(201, { token: 'ghs_retriedtoken' });

      const token = await getInstallationToken({
        appId: '123',
        privateKey: TEST_PRIVATE_KEY_PEM,
        targetRepo: 'acme/widgets',
        retries: 3,
        retryDelayMs: 0,
      });

      expect(token).toBe('ghs_retriedtoken');
    });

    it('gives up after exhausting all retries on persistent lookup failure', async () => {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: '/repos/acme/missing/installation' })
        .reply(404, 'Not Found')
        .times(3);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      try {
        await expect(
          getInstallationToken({
            appId: '123',
            privateKey: TEST_PRIVATE_KEY_PEM,
            targetRepo: 'acme/missing',
            retries: 3,
            retryDelayMs: 0,
          })
        ).rejects.toThrow('Could not determine installationId for repo: acme/missing');

        expect(fetchSpy).toHaveBeenCalledTimes(3);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('throws with the response body when token minting fails', async () => {
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'POST', path: '/app/installations/999/access_tokens' })
        .reply(401, 'Bad credentials');

      await expect(
        getInstallationToken({ appId: '123', privateKey: TEST_PRIVATE_KEY_PEM, installationId: '999' })
      ).rejects.toThrow(/Token mint failed \(401\): Bad credentials/);
    });
  });
});
