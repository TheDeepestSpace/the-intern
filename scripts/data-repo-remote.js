// Shared the-intern-data remote resolution (issue #112, static-token switch
// #124): the-intern-data uses a static fine-grained PAT stored as
// DATA_REPO_TOKEN, embedded in a push/fetch-able HTTPS URL. Used by
// manage-summaries.js and manage-pending-retries.js, the two
// git-branch-as-datastore modules that persist to the-intern-data.
//
// Previously (#112, hardened by #117/#120/#122) this minted a fresh
// installation token per call. That approach kept hitting a transient
// "Repository not found" on the git command right after minting, even with
// retries and a reused token — pointing at git-backend flakiness unrelated
// to minting, not something a fresh token could fix. #124 switched to a
// static PAT to remove minting from the equation entirely.

const DATA_REPO = process.env.DATA_REPO || 'TheDeepestSpace/the-intern-data';

// DATA_REPO_REMOTE_URL is a test/manual escape hatch: point it at a local bare
// repo to exercise fetch/push paths without a real token.
async function resolveDataRepoRemoteUrl() {
  if (process.env.DATA_REPO_REMOTE_URL) return process.env.DATA_REPO_REMOTE_URL;

  const token = process.env.DATA_REPO_TOKEN;
  if (!token) {
    console.log('DATA_REPO_TOKEN not set; cannot resolve the-intern-data remote.');
    return null;
  }
  return `https://x-access-token:${token}@github.com/${DATA_REPO}.git`;
}

// The remote URL embeds the token as HTTP basic-auth credentials
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

function isTransientRemoteError(message) {
  const str = String(message || '');
  return /repository not found/i.test(str) || /internal server error|50[023]/i.test(str);
}

// Capped exponential backoff: baseDelayMs, ×2 per attempt, capped at
// maxDelayMs. Propagation lag (see below) is usually 1-3s but occasionally
// longer, so a flat delay either overwaits the common case or underwaits the
// rare one.
function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

// GitHub intermittently serves a transient error on a git fetch/push against
// the-intern-data: either "Repository not found" (issue #120) — the same
// token-propagation-lag blip #117 fixed for the installation-lookup call, but
// here hitting the git command itself — or a GitHub-side 5xx/"Internal Server
// Error" (issue #159). With a static token (#124) there is nothing to
// refresh, so every attempt just reuses the same `remoteUrl` passed in;
// retrying alone is enough to ride out either blip. Retry a few times before
// surfacing the failure.
//
// `remoteUrl` is used on every attempt; callers that already resolved one
// (to raise their own "not configured" error before this point) pass it
// straight through instead of re-resolving. `run(url)` performs one attempt
// against `url`.
async function runWithRetryOnNotFound(
  remoteUrl,
  run,
  {
    retries = GIT_REMOTE_RETRIES,
    retryBaseDelayMs = GIT_REMOTE_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = GIT_REMOTE_RETRY_MAX_DELAY_MS,
  } = {}
) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run(remoteUrl);
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt || !isTransientRemoteError(err.message)) throw err;
      const delay = backoffDelay(attempt, retryBaseDelayMs, retryMaxDelayMs);
      console.warn(`the-intern-data git operation hit a transient error (attempt ${attempt + 1}/${retries}), retrying in ${delay}ms: ${redactUrl(err.message)}`);
      await sleep(delay);
    }
  }
}

module.exports = { DATA_REPO, resolveDataRepoRemoteUrl, redactUrl, runWithRetryOnNotFound };
