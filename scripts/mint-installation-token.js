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

async function getInstallationIdForRepo(appJwt, targetRepo) {
  if (!targetRepo || !targetRepo.includes('/')) return null;
  const res = await fetch(`https://api.github.com/repos/${targetRepo}/installation`, {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-intern-bot',
    },
  });
  if (!res.ok) {
    console.error(`Lookup installation failed for ${targetRepo} (${res.status}): ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return data.id;
}

async function getInstallationToken({ appId, privateKey, installationId, targetRepo }) {
  if (!appId) throw new Error('Missing APP_ID secret');
  if (!privateKey) throw new Error('Missing APP_PRIVATE_KEY secret');

  const appJwt = mintAppJwt(appId, privateKey);

  let targetInstallationId = installationId;
  if (!targetInstallationId && targetRepo) {
    console.log(`No installationId provided, fetching installation for repo ${targetRepo}...`);
    targetInstallationId = await getInstallationIdForRepo(appJwt, targetRepo);
  }

  if (!targetInstallationId) {
    throw new Error(`Could not determine installationId for repo: ${targetRepo || 'unknown'}`);
  }

  const res = await fetch(
    `https://api.github.com/app/installations/${targetInstallationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'the-intern-bot',
      },
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token mint failed (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  return data.token;
}

module.exports = { getInstallationToken, mintAppJwt, getPrivateKey };

if (require.main === module) {
  (async () => {
    try {
      const appId = process.env.APP_ID;
      const privateKey = getPrivateKey(process.env);
      const installationId = process.env.INSTALLATION_ID;
      const targetRepo = process.env.TARGET_REPO;

      if (!appId || !privateKey) {
        console.error('APP_ID and APP_PRIVATE_KEY secrets are required');
        process.exit(1);
      }

      const token = await getInstallationToken({ appId, privateKey, installationId, targetRepo });

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
