import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { restore, persist } from '../rotate-codex-auth.js';

// libsodium-wrappers' ESM build imports a `libsodium.mjs` sibling that the
// `libsodium` dependency doesn't actually ship, so `import` resolution 404s.
// require() it instead, same as rotate-codex-auth.js itself does.
const sodium = createRequire(import.meta.url)('libsodium-wrappers');

const ENV_KEYS = ['CODEX_HOME', 'CODEX_AUTH_JSON', 'REPO_ADMIN_TOKEN', 'GITHUB_REPOSITORY'];

describe('rotate-codex-auth', () => {
  let savedEnv;
  let tmpRoot;
  let logSpy;
  let errorSpy;
  let originalLog;
  let originalError;

  beforeEach(async () => {
    await sodium.ready;

    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-codex-auth-'));
    process.exitCode = 0;

    logSpy = [];
    errorSpy = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args) => logSpy.push(args.join(' '));
    console.error = (...args) => errorSpy.push(args.join(' '));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exitCode = 0;
    console.log = originalLog;
    console.error = originalError;
  });

  function authPath() {
    return path.join(process.env.CODEX_HOME, 'auth.json');
  }

  describe('restore', () => {
    it('skips without writing when CODEX_AUTH_JSON is not set', () => {
      process.env.CODEX_HOME = path.join(tmpRoot, 'codex-home');

      restore();

      expect(fs.existsSync(authPath())).toBe(false);
      expect(logSpy.join('\n')).toContain('CODEX_AUTH_JSON secret not set');
    });

    it('throws when CODEX_HOME is not set', () => {
      process.env.CODEX_AUTH_JSON = Buffer.from('{}', 'utf8').toString('base64');

      expect(() => restore()).toThrow('CODEX_HOME is not set');
    });

    it('decodes CODEX_AUTH_JSON and writes it to auth.json with 0600 permissions, creating CODEX_HOME', () => {
      process.env.CODEX_HOME = path.join(tmpRoot, 'nested', 'codex-home');
      const payload = { access_token: 'abc123', refresh_token: 'def456' };
      process.env.CODEX_AUTH_JSON = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

      restore();

      expect(JSON.parse(fs.readFileSync(authPath(), 'utf8'))).toEqual(payload);
      expect(fs.statSync(authPath()).mode & 0o777).toBe(0o600);
      expect(logSpy.join('\n')).toContain(`Restored Codex auth.json to ${authPath()}`);
    });

    it('masks every string value in the decoded payload, including nested ones', () => {
      process.env.CODEX_HOME = path.join(tmpRoot, 'codex-home');
      const payload = { access_token: 'top-secret', tokens: { refresh_token: 'nested-secret' }, list: ['array-secret'] };
      process.env.CODEX_AUTH_JSON = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

      restore();

      const masked = logSpy.join('\n');
      expect(masked).toContain('::add-mask::top-secret');
      expect(masked).toContain('::add-mask::nested-secret');
      expect(masked).toContain('::add-mask::array-secret');
      expect(masked).toContain(`::add-mask::${process.env.CODEX_AUTH_JSON}`);
    });

    it('sets exitCode to 1 and does not write the file when CODEX_AUTH_JSON does not decode to valid JSON', () => {
      process.env.CODEX_HOME = path.join(tmpRoot, 'codex-home');
      process.env.CODEX_AUTH_JSON = Buffer.from('not json', 'utf8').toString('base64');

      restore();

      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(authPath())).toBe(false);
      expect(errorSpy.join('\n')).toContain('did not decode to valid JSON');
    });
  });

  describe('persist', () => {
    let originalDispatcher;
    let agent;

    beforeEach(() => {
      originalDispatcher = getGlobalDispatcher();
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
      process.env.CODEX_HOME = path.join(tmpRoot, 'codex-home');
    });

    afterEach(() => {
      setGlobalDispatcher(originalDispatcher);
    });

    function writeAuthFile(content) {
      fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
      fs.writeFileSync(authPath(), content);
    }

    it('does nothing when auth.json does not exist', async () => {
      await persist();

      expect(logSpy.join('\n')).toContain('nothing to persist');
    });

    it('skips when REPO_ADMIN_TOKEN is not set', async () => {
      writeAuthFile(JSON.stringify({ access_token: 'abc' }));

      await persist();

      expect(logSpy.join('\n')).toContain('REPO_ADMIN_TOKEN not set');
    });

    it('sets exitCode to 1 when GITHUB_REPOSITORY is not set', async () => {
      writeAuthFile(JSON.stringify({ access_token: 'abc' }));
      process.env.REPO_ADMIN_TOKEN = 'admin-token';

      await persist();

      expect(process.exitCode).toBe(1);
      expect(errorSpy.join('\n')).toContain('GITHUB_REPOSITORY is not set');
    });

    it('sets exitCode to 1 when auth.json on disk is not valid JSON', async () => {
      writeAuthFile('not json');
      process.env.REPO_ADMIN_TOKEN = 'admin-token';
      process.env.GITHUB_REPOSITORY = 'acme/widgets';

      await persist();

      expect(process.exitCode).toBe(1);
      expect(errorSpy.join('\n')).toContain('not valid JSON after the run');
    });

    it('sets exitCode to 1 when fetching the repo public key fails', async () => {
      writeAuthFile(JSON.stringify({ access_token: 'abc' }));
      process.env.REPO_ADMIN_TOKEN = 'admin-token';
      process.env.GITHUB_REPOSITORY = 'acme/widgets';

      agent
        .get('https://api.github.com')
        .intercept({ method: 'GET', path: '/repos/acme/widgets/actions/secrets/public-key' })
        .reply(404, 'Not Found');

      await persist();

      expect(process.exitCode).toBe(1);
      expect(errorSpy.join('\n')).toContain('Failed to fetch repo public key');
      expect(logSpy.join('\n')).toContain('::add-mask::abc');
    });

    it('sets exitCode to 1 when updating the secret fails', async () => {
      writeAuthFile(JSON.stringify({ access_token: 'abc' }));
      process.env.REPO_ADMIN_TOKEN = 'admin-token';
      process.env.GITHUB_REPOSITORY = 'acme/widgets';

      const keypair = sodium.crypto_box_keypair();
      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: '/repos/acme/widgets/actions/secrets/public-key' })
        .reply(200, {
          key: sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL),
          key_id: 'key-1',
        });
      client
        .intercept({ method: 'PUT', path: '/repos/acme/widgets/actions/secrets/CODEX_AUTH_JSON' })
        .reply(401, 'Bad credentials');

      await persist();

      expect(process.exitCode).toBe(1);
      expect(errorSpy.join('\n')).toContain('Failed to update CODEX_AUTH_JSON secret');
      expect(logSpy.join('\n')).toContain('::add-mask::abc');
    });

    it('encrypts the refreshed auth.json with the repo public key and PUTs it to the secret', async () => {
      const refreshed = { access_token: 'new-access', refresh_token: 'new-refresh' };
      writeAuthFile(JSON.stringify(refreshed));
      process.env.REPO_ADMIN_TOKEN = 'admin-token';
      process.env.GITHUB_REPOSITORY = 'acme/widgets';

      const keypair = sodium.crypto_box_keypair();
      let capturedBody = null;

      const client = agent.get('https://api.github.com');
      client
        .intercept({ method: 'GET', path: '/repos/acme/widgets/actions/secrets/public-key' })
        .reply(200, {
          key: sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL),
          key_id: 'key-1',
        });
      client
        .intercept({ method: 'PUT', path: '/repos/acme/widgets/actions/secrets/CODEX_AUTH_JSON' })
        .reply(opts => {
          capturedBody = JSON.parse(opts.body);
          return { statusCode: 204 };
        });

      await persist();

      expect(process.exitCode).toBe(0);
      expect(capturedBody.key_id).toBe('key-1');

      const decrypted = sodium.crypto_box_seal_open(
        sodium.from_base64(capturedBody.encrypted_value, sodium.base64_variants.ORIGINAL),
        keypair.publicKey,
        keypair.privateKey
      );
      const decoded = Buffer.from(sodium.to_string(decrypted), 'base64').toString('utf8');
      expect(JSON.parse(decoded)).toEqual(refreshed);

      const logged = logSpy.join('\n');
      expect(logged).toContain('::add-mask::new-access');
      expect(logged).toContain('::add-mask::new-refresh');
      expect(logged).toContain(`::add-mask::${Buffer.from(JSON.stringify(refreshed), 'utf8').toString('base64')}`);
      expect(logged).toContain('Persisted refreshed Codex auth.json');
    });
  });
});
