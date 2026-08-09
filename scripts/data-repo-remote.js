// Shared the-intern-data remote resolution (issue #112): mints an installation
// token scoped to the-intern-data and returns it embedded in a push/fetch-able
// HTTPS URL. Used by manage-summaries.js and manage-pending-retries.js, the two
// git-branch-as-datastore modules that persist to the-intern-data.
const { getInstallationToken, getPrivateKey } = require('./mint-installation-token.js');

const DATA_REPO = process.env.DATA_REPO || 'TheDeepestSpace/the-intern-data';

async function mintDataRepoToken() {
  const appId = process.env.APP_ID;
  const privateKey = getPrivateKey(process.env);
  if (!appId || !privateKey) {
    console.log('APP_ID/APP_PRIVATE_KEY not set; cannot mint the-intern-data token.');
    return null;
  }

  try {
    const token = await getInstallationToken({ appId, privateKey, targetRepo: DATA_REPO });
    // Tell the GitHub Actions runner to mask this token across all step logs,
    // same as mint-installation-token.js's own CLI entrypoint does for its
    // token. Skipped off-Actions, where the command is not interpreted and the
    // token would be printed verbatim.
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
    return token;
  } catch (err) {
    // Credentials are present but minting failed (bad key, API outage, etc.) —
    // rethrow so callers report the real cause instead of treating this the
    // same as an unconfigured remote.
    throw new Error(`Failed to mint installation token for ${DATA_REPO}: ${err.message}`);
  }
}

// DATA_REPO_REMOTE_URL is a test/manual escape hatch: point it at a local bare
// repo to exercise fetch/push paths without minting a real token.
async function resolveDataRepoRemoteUrl() {
  if (process.env.DATA_REPO_REMOTE_URL) return process.env.DATA_REPO_REMOTE_URL;

  const token = await mintDataRepoToken();
  if (!token) return null;
  return `https://x-access-token:${token}@github.com/${DATA_REPO}.git`;
}

// The minted remote URL embeds the token as HTTP basic-auth credentials
// (https://x-access-token:<token>@github.com/...). Callers that log a git
// command or its failure output must redact it first — GitHub Actions'
// ::add-mask:: only covers Actions logs, not local runs or the
// DATA_REPO_REMOTE_URL test/manual override.
function redactUrl(str) {
  return str.replace(/:\/\/[^\s/@]*(?::[^\s/@]*)?@/g, '://***:***@');
}

const GIT_REMOTE_RETRIES = 10;
const GIT_REMOTE_RETRY_BASE_DELAY_MS = 2000;
const GIT_REMOTE_RETRY_MAX_DELAY_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRemoteNotFound(message) {
  return /repository not found/i.test(String(message || ''));
}

// Capped exponential backoff: baseDelayMs, ×2 per attempt, capped at
// maxDelayMs. Propagation lag (see below) is usually 1-3s but occasionally
// longer, so a flat delay either overwaits the common case or underwaits the
// rare one.
function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

// GitHub intermittently serves a transient "Repository not found" on a git
// fetch/push against a freshly minted token (issue #120) — the same
// token-propagation-lag blip #117 fixed for the installation-lookup call,
// but here hitting the git command that follows the mint instead. Retry a
// few times before surfacing the failure.
//
// The token itself is valid immediately; only the backend propagation lags,
// so re-minting on every retry buys nothing but an extra API call. Reuse the
// same `url` across attempts, and only re-mint right before the final
// attempt as a last resort.
//
// `remoteUrl` is used on the first attempt; callers that already resolved
// one (to raise their own "not configured" error before this point) pass it
// straight through instead of re-resolving twice on the common, no-retry
// path. `run(url)` performs one attempt against `url`.
async function runWithFreshRemoteOnNotFound(
  remoteUrl,
  run,
  {
    retries = GIT_REMOTE_RETRIES,
    retryBaseDelayMs = GIT_REMOTE_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = GIT_REMOTE_RETRY_MAX_DELAY_MS,
  } = {}
) {
  let url = remoteUrl;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run(url);
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt || !isTransientRemoteNotFound(err.message)) throw err;
      const delay = backoffDelay(attempt, retryBaseDelayMs, retryMaxDelayMs);
      console.warn(`the-intern-data git operation hit a transient "Repository not found" (attempt ${attempt + 1}/${retries}), retrying in ${delay}ms: ${redactUrl(err.message)}`);
      await sleep(delay);
      const isNextAttemptLast = attempt + 1 === retries;
      if (isNextAttemptLast) url = (await resolveDataRepoRemoteUrl()) || url;
    }
  }
}

module.exports = { DATA_REPO, resolveDataRepoRemoteUrl, redactUrl, runWithFreshRemoteOnNotFound };
