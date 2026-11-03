const crypto = require('crypto');
const fs = require('fs');

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function formatPrivateKey(keyStr) {
  if (!keyStr) return '';
  let key = keyStr.trim();
  if (!key.includes('-----BEGIN')) {
    key = Buffer.from(key, 'base64').toString('utf8');
  }
  return key;
}

function getPrivateKey(env) {
  if (env.APP_PRIVATE_KEY) return env.APP_PRIVATE_KEY;
  let concatenated = '';
  for (let i = 1; i <= 10; i++) {
    const part = env[`APP_PRIVATE_KEY_PART${i}`];
    if (part) {
      concatenated += part;
    }
  }
  return concatenated;
}

function mintAppJwt(appId, privateKeyPem) {
  const pem = formatPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(dataToSign);
  const signature = base64url(signer.sign(pem));

  return `${dataToSign}.${signature}`;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GitHub's installation and token-minting endpoints intermittently blip with
// transient errors (e.g. "Repository not found" for issue #117, "fetch
// failed" for issue #155) even though the app is correctly configured — a
// same-input retry seconds later succeeds. Retry a few times before giving up
// so a passing API glitch doesn't red-flag the whole dispatcher job.
// An operation's rejection is retried unless it explicitly opts out via
// `error.retryable = false` (e.g. a permanent 401 that a retry can't fix).
async function withRetries(
  operation,
  { retries = DEFAULT_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === retries || error.retryable === false;
      console.error(error.message + (isLastAttempt ? '' : ` — retrying (attempt ${attempt}/${retries})...`));
      if (isLastAttempt) throw error;
      await sleep(retryDelayMs);
    }
  }
}

async function getInstallationIdForRepo(appJwt, targetRepo, { retries, retryDelayMs } = {}) {
  if (!targetRepo || !targetRepo.includes('/')) return null;

  try {
    return await withRetries(async () => {
      const res = await fetch(`https://api.github.com/repos/${targetRepo}/installation`, {
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'the-intern-bot',
        },
      });
      if (!res.ok) {
        throw new Error(`Lookup installation failed for ${targetRepo} (${res.status}): ${await res.text()}`);
      }
      const data = await res.json();
      return data.id;
    }, { retries, retryDelayMs });
  } catch (error) {
    return null;
  }
}

// Access name (agentic.yaml) meaning every repo the installation covers.
const ALL_REPOS = '*';

// Permissions a read-scoped token keeps. `scope: read` means the agent may
// not push (contents: read) but can still report back through issues and PR
// reviews/comments; everything else the installation has is dropped.
const READ_SCOPE_PERMISSIONS = { contents: 'read', metadata: 'read', issues: 'write', pull_requests: 'write' };

// Turns a resolved agentic.yaml access list ([{repo: 'owner/name', scope}])
// into the `repositories` / `permissions` body of the access-token request.
// Default-deny and never a partial scope: an empty list, a mix of owners (one
// installation can only cover one owner) or a malformed entry throws.
// GitHub permissions are per token, not per repo, so a list that mixes
// scopes gets the widest one (read/write) for every repo in it; `read` is only
// enforced when every entry is read-only.
function scopeFromAccess(access, explicitPermissions) {
  if (!Array.isArray(access) || access.length === 0) {
    throw new Error('ACCESS is empty: the agent has no repositories (default-deny), refusing to mint a token');
  }
  for (const a of access) {
    if (!a || typeof a.repo !== 'string' || !a.repo || !['read', 'read/write'].includes(a.scope)) {
      throw new Error(`ACCESS entry is malformed: ${JSON.stringify(a)}`);
    }
  }
  const allRepos = access.some((a) => a.repo === ALL_REPOS);
  const readOnly = access.every((a) => a.scope === 'read');
  // Explicit permissions (PERMISSIONS) replace the derived set: a caller that
  // names them wants exactly those (e.g. a contents-only prompt-file token).
  const permissions = explicitPermissions || (readOnly ? READ_SCOPE_PERMISSIONS : undefined);
  if (allRepos) return { repositories: undefined, permissions, owner: null };

  const owners = new Set();
  const repositories = [];
  for (const a of access) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo)) throw new Error(`ACCESS repo '${a.repo}' is not owner/repo`);
    const [owner, name] = a.repo.split('/');
    owners.add(owner.toLowerCase());
    if (!repositories.includes(name)) repositories.push(name);
  }
  if (owners.size > 1) {
    throw new Error(`ACCESS spans several owners (${[...owners].join(', ')}); one installation token covers one owner`);
  }
  return { repositories, permissions, owner: access[0].repo.split('/')[0] };
}

function parseAccess(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ACCESS: not valid JSON (${error.message})`);
  }
  if (!Array.isArray(parsed)) throw new Error('Invalid ACCESS: must be a JSON array of {repo, scope}');
  return parsed;
}

// Mints an installation token. Two ways to scope it:
//  - `access`: the resolved agentic.yaml access list; repositories and
//    permissions are derived from it (see scopeFromAccess). This is what
//    every agent run uses.
//  - `targetRepo` (+ optional `permissions`, `scopeToRepo`): single-repo
//    scoping for the non-agent callers (nightly crawl, data-repo token,
//    codex auth rotation, data-branch cleanup).
async function getInstallationToken({
  appId,
  privateKey,
  installationId,
  targetRepo,
  access,
  retries,
  retryDelayMs,
  permissions,
  scopeToRepo = true,
}) {
  if (!appId) throw new Error('Missing APP_ID secret');
  if (!privateKey) throw new Error('Missing APP_PRIVATE_KEY secret');

  const appJwt = mintAppJwt(appId, privateKey);

  let body;
  let lookupRepo = targetRepo;
  if (access !== undefined) {
    const scoped = scopeFromAccess(access, permissions);
    body = {
      ...(scoped.repositories ? { repositories: scoped.repositories } : {}),
      ...(scoped.permissions ? { permissions: scoped.permissions } : {}),
    };
    if (!lookupRepo) lookupRepo = access.find((a) => a.repo !== ALL_REPOS)?.repo;
  } else {
    const shouldScopeRepo = scopeToRepo && Boolean(targetRepo);
    body = {
      // Without `repositories`, GitHub grants the token access to every repo
      // the installation can see. Scope it down to just targetRepo when known
      // and scopeToRepo is true.
      ...(shouldScopeRepo ? { repositories: [targetRepo.split('/')[1]] } : {}),
      // Without `permissions`, GitHub grants every permission the installation
      // has — pass it through when the caller specifies a minimal set.
      ...(permissions ? { permissions } : {}),
    };
  }

  let targetInstallationId = installationId;
  if (!targetInstallationId && lookupRepo) {
    console.log(`No installationId provided, fetching installation for repo ${lookupRepo}...`);
    targetInstallationId = await getInstallationIdForRepo(appJwt, lookupRepo, { retries, retryDelayMs });
  }

  if (!targetInstallationId) {
    throw new Error(`Could not determine installationId for repo: ${lookupRepo || 'unknown'}`);
  }

  const data = await withRetries(async () => {
    const res = await fetch(
      `https://api.github.com/app/installations/${targetInstallationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'the-intern-bot',
          'Content-Type': 'application/json',
        },
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      const error = new Error(`Token mint failed (${res.status}): ${errorText}`);
      // Only rate-limiting and server errors are worth retrying — credential
      // and validation failures (e.g. 401, 422) will fail the same way again.
      error.retryable = res.status === 429 || res.status >= 500;
      throw error;
    }

    return res.json();
  }, { retries, retryDelayMs });

  return data.token;
}

function parsePermissions(raw) {
  if (!raw) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid PERMISSIONS: not valid JSON (${error.message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid PERMISSIONS: must be a JSON object of permission scopes');
  }
  return parsed;
}

module.exports = {
  getInstallationToken, mintAppJwt, getPrivateKey, parsePermissions, parseAccess, scopeFromAccess,
  READ_SCOPE_PERMISSIONS,
};

if (require.main === module) {
  (async () => {
    try {
      const appId = process.env.APP_ID;
      const privateKey = getPrivateKey(process.env);
      const installationId = process.env.INSTALLATION_ID;
      const targetRepo = process.env.TARGET_REPO;
      const permissions = parsePermissions(process.env.PERMISSIONS);
      const access = parseAccess(process.env.ACCESS);

      if (!appId || !privateKey) {
        console.error('APP_ID and APP_PRIVATE_KEY secrets are required');
        process.exit(1);
      }

      const token = await getInstallationToken({
        appId,
        privateKey,
        installationId,
        targetRepo,
        access,
        permissions,
      });

      // Tell GitHub Actions runner to mask this token across all step logs
      console.log(`::add-mask::${token}`);

      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `token=${token}\n`);
      } else {
        console.log(token);
      }
    } catch (err) {
      console.error('Error minting installation token:', err.message);
      process.exit(1);
    }
  })();
}
