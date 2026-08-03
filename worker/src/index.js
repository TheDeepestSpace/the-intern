import crypto from 'node:crypto';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('ok', { status: 200 });
    }

    const url = new URL(request.url);
    if (url.pathname === '/telegram') {
      return handleTelegram(request, env);
    }
    return handleGitHub(request, env);
  },
};

// Shared dispatch POST used by the generic flow, handleCheckSuite, and
// handleCodeRabbitReview: resolves the configured owner/repo, sets the
// common headers, and sends eventType + rawPayload.
async function dispatchRepoEvent(env, token, eventType, rawPayload) {
  const owner = env.AGENT_INFRA_OWNER || 'TheDeepestSpace';
  const repo = env.AGENT_INFRA_REPO || 'the-intern';

  return fetch(
    `https://api.github.com/repos/${owner}/${repo}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'the-intern-bot-relay',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: eventType, client_payload: { raw: rawPayload } }),
    }
  );
}

async function handleGitHub(request, env) {
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

  // check_suite has no comment author, so it bypasses the ALLOWED_USERS /
  // mention gating below entirely and is handled as its own flow.
  if (eventType === 'check_suite') {
    return handleCheckSuite(payload, env);
  }

  // Likewise, a CodeRabbit review is never authored by an allowlisted human
  // and never mentions the bot, so it needs its own bypass flow too.
  const reviewerLogin = (payload.review?.user?.login || '').toLowerCase();
  if (eventType === 'pull_request_review' && reviewerLogin === 'coderabbitai[bot]') {
    return handleCodeRabbitReview(payload, env);
  }

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

  // Filter relevant event types
  const relevant = [
    'issue_comment',
    'pull_request_review',
    'pull_request_review_comment',
  ];
  if (!relevant.includes(eventType)) {
    return new Response('ignored: event type', { status: 200 });
  }

  // pull_request_review and pull_request_review_comment can both fire for a
  // single human review submission — stateless partial dedupe (see #58/#59):
  // skip pull_request_review when it's an inline-only review (empty body),
  // since the inline comments will each fire their own
  // pull_request_review_comment delivery anyway. This doesn't catch a review
  // that has both a mentioning body and a mentioning inline comment — that
  // still double-fires — but avoids adding a KV dependency for the common case.
  const reviewBody = payload.review?.body;
  if (eventType === 'pull_request_review' && (typeof reviewBody !== 'string' || reviewBody.trim() === '')) {
    return new Response('ignored: review has no top-level body (inline-only review)', { status: 200 });
  }
  if (eventType === 'pull_request_review_comment' && !payload.comment?.pull_request_review_id) {
    return new Response('ignored: comment not tied to a review', { status: 200 });
  }

  // Guard: only trigger if @the-intern-bot is mentioned, OR the comment is on a
  // thread (issue/PR) authored by the bot itself — but never for comments the
  // bot itself posts, or every status update would re-trigger a dispatch.
  const commentBody = payload.comment?.body || payload.review?.body || '';
  const botLogin = (env.BOT_LOGIN || 'the-intern-bot[bot]').toLowerCase();
  const threadAuthor = (
    payload.issue?.user?.login || payload.pull_request?.user?.login || ''
  ).toLowerCase();
  const mentionsBot = commentBody.toLowerCase().includes('@the-intern-bot');
  const isBotAuthoredThread = threadAuthor === botLogin;
  const commenterIsBot = (author || '').toLowerCase() === botLogin;

  if (!mentionsBot && !(isBotAuthoredThread && !commenterIsBot)) {
    return new Response('ignored: bot not mentioned and not a comment on a bot-authored thread', { status: 200 });
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  try {
    const token = await getInstallationToken(env, installationId);

    const dispatchRes = await dispatchRepoEvent(env, token, eventType, payload);

    if (!dispatchRes.ok) {
      const errorText = await dispatchRes.text();
      return new Response(`dispatch failed: ${errorText}`, { status: 502 });
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

// Auto-queues a fix-CI dispatch when a check suite fails on a PR the bot
// itself opened, so it can fix its own broken PRs without a human comment.
// No dedup/KV: a re-failing run on the same PR just re-dispatches, which is
// the desired retry-until-fixed behavior.
async function handleCheckSuite(payload, env) {
  const checkSuite = payload.check_suite;
  const pullRequests = checkSuite?.pull_requests || [];

  if (
    payload.action !== 'completed' ||
    !['failure', 'timed_out'].includes(checkSuite?.conclusion) ||
    pullRequests.length === 0
  ) {
    return new Response('ignored: check_suite not a relevant failure', { status: 200 });
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  const botLogin = (env.BOT_LOGIN || 'the-intern-bot[bot]').toLowerCase();
  const sourceOwner = payload.repository?.owner?.login;
  const sourceRepo = payload.repository?.name;

  try {
    const token = await getInstallationToken(env, installationId);

    let dispatched = 0;
    for (const { number } of pullRequests) {
      const prRes = await fetch(
        `https://api.github.com/repos/${sourceOwner}/${sourceRepo}/pulls/${number}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'the-intern-bot-relay',
          },
        }
      );
      if (!prRes.ok) continue;
      const pullRequest = await prRes.json();

      if ((pullRequest.user?.login || '').toLowerCase() !== botLogin) continue;

      const dispatchRes = await dispatchRepoEvent(env, token, 'ci_failure', {
        repository: payload.repository,
        pull_request: pullRequest,
        check_suite: checkSuite,
        installation: payload.installation,
      });

      if (!dispatchRes.ok) {
        const errorText = await dispatchRes.text();
        return new Response(`dispatch failed: ${errorText}`, { status: 502 });
      }
      dispatched++;
    }

    return new Response(
      dispatched > 0 ? 'ok' : 'ignored: no bot-authored pull requests',
      { status: 200 }
    );
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

// Auto-queues a coderabbit_review dispatch when CodeRabbit reviews a PR the
// bot itself opened, so unaddressed feedback gets picked up without a human
// having to manually re-trigger the bot. Bypasses ALLOWED_USERS/mention
// gating entirely, like handleCheckSuite. Tier-2 injection-safe: only
// structural fields (repo, PR number, review URL) are ever forwarded here —
// the review body itself is never read by the worker. The dispatched session
// reads the actual review content itself via its own gh/api tool call later,
// the same trust boundary ci_failure already operates under.
async function handleCodeRabbitReview(payload, env) {
  if (payload.action !== 'submitted') {
    return new Response('ignored: coderabbit review not submitted', { status: 200 });
  }

  const botLogin = (env.BOT_LOGIN || 'the-intern-bot[bot]').toLowerCase();
  const prAuthor = (payload.pull_request?.user?.login || '').toLowerCase();
  if (prAuthor !== botLogin) {
    return new Response('ignored: coderabbit review not on a bot-authored PR', { status: 200 });
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  try {
    const token = await getInstallationToken(env, installationId);

    const dispatchRes = await dispatchRepoEvent(env, token, 'coderabbit_review', {
      repository: { full_name: payload.repository?.full_name },
      pull_request: { number: payload.pull_request?.number },
      coderabbit_review: { html_url: payload.review?.html_url },
      installation: { id: installationId },
    });

    if (!dispatchRes.ok) {
      const errorText = await dispatchRes.text();
      return new Response(`dispatch failed: ${errorText}`, { status: 502 });
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

async function handleTelegram(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (env.TG_WEBHOOK_SECRET && secret !== env.TG_WEBHOOK_SECRET) {
    return new Response('bad secret', { status: 401 });
  }

  const update = await request.json();
  const message = update.message;
  if (!message || (!message.text && !message.photo?.length)) {
    return new Response('ok', { status: 200 });
  }

  // Gate on numeric Telegram user ID check if configured
  if (env.ALLOWED_TG_USER_ID && String(message.from?.id) !== String(env.ALLOWED_TG_USER_ID)) {
    return new Response('ignored: unauthorized sender', { status: 200 });
  }

  // Gate on numeric Telegram Chat ID check if configured
  if (env.ALLOWED_TG_CHAT_ID && String(message.chat?.id) !== String(env.ALLOWED_TG_CHAT_ID)) {
    return new Response('ignored: unauthorized chat_id', { status: 200 });
  }

  const owner = env.AGENT_INFRA_OWNER || 'TheDeepestSpace';
  const repo = env.AGENT_INFRA_REPO || 'the-intern';

  try {
    let installationId = env.AGENT_INFRA_INSTALLATION_ID;
    if (!installationId) {
      const appId = env.APP_ID;
      let privateKey = getPrivateKey(env);
      if (appId && privateKey) {
        privateKey = privateKey.trim();
        if (!privateKey.includes('-----BEGIN')) {
          privateKey = Buffer.from(privateKey, 'base64').toString('utf8');
        }
        const appJwt = mintAppJwt(appId, privateKey);
        installationId = await getInstallationIdForRepo(appJwt, `${owner}/${repo}`);
      }
    }

    if (!installationId) {
      return new Response('missing installation id for agent-infra', { status: 500 });
    }

    const token = await getInstallationToken(env, installationId);

    const clientPayload = {
      text: message.text || message.caption || '',
      chat_id: message.chat.id,
      sender_id: message.from.id,
      message_id: message.message_id,
    };
    if (message.photo && message.photo.length > 0) {
      // PhotoSize array is ordered smallest to largest.
      clientPayload.photo_file_id = message.photo[message.photo.length - 1].file_id;
    }
    if (message.reply_to_message) {
      const replyTo = message.reply_to_message;
      clientPayload.reply_to_message_id = replyTo.message_id;
      clientPayload.reply_to_text = replyTo.text || replyTo.caption || '';
      if (replyTo.photo && replyTo.photo.length > 0) {
        // PhotoSize array is ordered smallest to largest.
        clientPayload.reply_to_photo_file_id = replyTo.photo[replyTo.photo.length - 1].file_id;
      }
    }

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
          event_type: 'telegram_message',
          client_payload: clientPayload,
        }),
      }
    );

    if (!dispatchRes.ok) {
      const errorText = await dispatchRes.text();
      return new Response(`dispatch failed: ${errorText}`, { status: 502 });
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    return new Response(`telegram handling error: ${err.message}`, { status: 500 });
  }
}

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
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
  const dataToSign = `${header}.${payload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(dataToSign);
  const signature = signer.sign(privateKeyPem, 'base64url');
  return `${dataToSign}.${signature}`;
}

async function getInstallationIdForRepo(appJwt, targetRepo) {
  if (!targetRepo || !targetRepo.includes('/')) return null;
  const res = await fetch(`https://api.github.com/repos/${targetRepo}/installation`, {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-intern-bot-relay',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.id;
}

async function getInstallationToken(env, installationId) {
  const appId = env.APP_ID;
  let privateKey = getPrivateKey(env);

  if (!appId || !privateKey) {
    throw new Error('APP_ID and APP_PRIVATE_KEY secrets must be configured in Worker');
  }

  privateKey = privateKey.trim();
  if (!privateKey.includes('-----BEGIN')) {
    privateKey = Buffer.from(privateKey, 'base64').toString('utf8');
  }

  const appJwt = mintAppJwt(appId, privateKey);

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
