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

const INSTALLATION_LOOKUP_RETRIES = 3;
const INSTALLATION_LOOKUP_RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GitHub's installation-lookup endpoint intermittently blips with a transient
// "Repository not found" even though access is correctly configured (issue
// #117) — a same-token retry seconds later succeeds. Retry a few times before
// giving up so a passing API glitch doesn't red-flag the whole dispatcher job.
async function getInstallationIdForRepo(
  appJwt,
  targetRepo,
  { retries = INSTALLATION_LOOKUP_RETRIES, retryDelayMs = INSTALLATION_LOOKUP_RETRY_DELAY_MS } = {}
) {
  if (!targetRepo || !targetRepo.includes('/')) return null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let failure;
    try {
      const res = await fetch(`https://api.github.com/repos/${targetRepo}/installation`, {
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'the-intern-bot',
        },
      });
      if (res.ok) {
        const data = await res.json();
        return data.id;
      }
      failure = `Lookup installation failed for ${targetRepo} (${res.status}): ${await res.text()}`;
    } catch (error) {
      failure = `Lookup installation failed for ${targetRepo}: ${error.message}`;
    }

    const isLastAttempt = attempt === retries;
    console.error(failure + (isLastAttempt ? '' : ` — retrying (attempt ${attempt}/${retries})...`));
    if (!isLastAttempt) await sleep(retryDelayMs);
  }
  return null;
}

async function getInstallationToken({
  appId,
  privateKey,
  installationId,
  targetRepo,
  retries,
  retryDelayMs,
  permissions,
  scopeToRepo = true,
}) {
  if (!appId) throw new Error('Missing APP_ID secret');
  if (!privateKey) throw new Error('Missing APP_PRIVATE_KEY secret');

  const appJwt = mintAppJwt(appId, privateKey);

  let targetInstallationId = installationId;
  if (!targetInstallationId && targetRepo) {
    console.log(`No installationId provided, fetching installation for repo ${targetRepo}...`);
    targetInstallationId = await getInstallationIdForRepo(appJwt, targetRepo, { retries, retryDelayMs });
  }

  if (!targetInstallationId) {
    throw new Error(`Could not determine installationId for repo: ${targetRepo || 'unknown'}`);
  }

  const shouldScopeRepo = scopeToRepo && Boolean(targetRepo);

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
      // Without `repositories`, GitHub grants the token access to every repo
      // the installation can see. Scope it down to just targetRepo when known
      // and scopeToRepo is true. Without `permissions`, GitHub grants every
      // permission the installation has, even ones the caller only needs
      // read-only (or no) access to — pass it through when the caller
      // specifies a minimal set.
      body:
        shouldScopeRepo || permissions
          ? JSON.stringify({
              ...(shouldScopeRepo ? { repositories: [targetRepo.split('/')[1]] } : {}),
              ...(permissions ? { permissions } : {}),
            })
          : undefined,
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token mint failed (${res.status}): ${errorText}`);
  }

  const data = await res.json();
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

module.exports = { getInstallationToken, mintAppJwt, getPrivateKey, parsePermissions };

if (require.main === module) {
  (async () => {
    try {
      const appId = process.env.APP_ID;
      const privateKey = getPrivateKey(process.env);
      const installationId = process.env.INSTALLATION_ID;
      const targetRepo = process.env.TARGET_REPO;
      const permissions = parsePermissions(process.env.PERMISSIONS);
      const scopeToRepo = process.env.SCOPE_TO_REPO !== 'false';

      if (!appId || !privateKey) {
        console.error('APP_ID and APP_PRIVATE_KEY secrets are required');
        process.exit(1);
      }

      const token = await getInstallationToken({
        appId,
        privateKey,
        installationId,
        targetRepo,
        permissions,
        scopeToRepo,
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
