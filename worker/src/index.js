import crypto from 'node:crypto';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('ok', { status: 200 });
    }

    const body = await request.text();
    const signature = request.headers.get('X-Hub-Signature-256') || '';
    
    // Verify HMAC-SHA256 signature if secret is configured
    if (env.WEBHOOK_SECRET) {
      const valid = await verifySignature(body, signature, env.WEBHOOK_SECRET);
      if (!valid) {
        return new Response('bad signature', { status: 401 });
      }
    }

    const eventType = request.headers.get('X-GitHub-Event');
    const payload = JSON.parse(body);

    // Extract comment / review / event author
    const author =
      payload.comment?.user?.login ||
      payload.review?.user?.login ||
      payload.sender?.login ||
      payload.sender?.user?.login;

    // Gate on exact username allowlist (ALLOWED_USERS comma-separated list)
    const allowed = (env.ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (allowed.length > 0) {
      if (!author || !allowed.includes(author)) {
        return new Response('ignored: author not in allowlist', { status: 200 });
      }
    }

    // Bot self-comment defense
    const botLogin = env.BOT_LOGIN || 'the-intern-bot';
    if (author === botLogin || author === `${botLogin}[bot]`) {
      return new Response('ignored: self-comment', { status: 200 });
    }

    // Filter relevant event types
    const relevant = [
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'check_suite',
    ];
    if (!relevant.includes(eventType)) {
      return new Response('ignored: event type', { status: 200 });
    }

    const installationId = payload.installation?.id;
    if (!installationId) {
      return new Response('missing installation id', { status: 400 });
    }

    try {
      const token = await getInstallationToken(env, installationId);

      const owner = env.AGENT_INFRA_OWNER || 'TheDeepestSpace';
      const repo = env.AGENT_INFRA_REPO || 'the-intern';

      const dispatchRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'the-intern-bot-relay',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: eventType,
            client_payload: { raw: payload },
          }),
        }
      );

      if (!dispatchRes.ok) {
        const errorText = await dispatchRes.text();
        return new Response(`dispatch failed: ${errorText}`, { status: 502 });
      }

      return new Response('ok', { status: 200 });
    } catch (err) {
      return new Response(`internal error: ${err.message}`, { status: 500 });
    }
  },
};

async function verifySignature(body, signatureHeader, secret) {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected =
    'sha256=' +
    [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

async function getInstallationToken(env, installationId) {
  const appId = env.APP_ID;
  let privateKey = env.APP_PRIVATE_KEY || ((env.APP_PRIVATE_KEY_PART1 || '') + (env.APP_PRIVATE_KEY_PART2 || ''));

  if (!appId || !privateKey) {
    throw new Error('APP_ID and APP_PRIVATE_KEY secrets must be configured in Worker');
  }

  privateKey = privateKey.trim();
  if (!privateKey.includes('-----BEGIN')) {
    privateKey = Buffer.from(privateKey, 'base64').toString('utf8');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
  const dataToSign = `${header}.${payload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(dataToSign);
  const signature = signer.sign(privateKey, 'base64url');
  const appJwt = `${dataToSign}.${signature}`;

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'the-intern-bot-relay',
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
