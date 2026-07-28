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

async function getInstallationToken({ appId, privateKey, installationId }) {
  if (!appId) throw new Error('Missing appId');
  if (!privateKey) throw new Error('Missing privateKey');
  if (!installationId) throw new Error('Missing installationId');

  const appJwt = mintAppJwt(appId, privateKey);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
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

module.exports = { getInstallationToken, mintAppJwt };

if (require.main === module) {
  (async () => {
    try {
      const appId = process.env.APP_ID;
      const privateKey = getPrivateKey(process.env);
      const installationId = process.env.INSTALLATION_ID;

      if (!appId || !privateKey || !installationId) {
        console.error('Usage environment variables required: APP_ID, APP_PRIVATE_KEY, INSTALLATION_ID');
        process.exit(1);
      }

      const token = await getInstallationToken({ appId, privateKey, installationId });

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
