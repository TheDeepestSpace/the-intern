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
  return str.replace(/:\/\/[^\s/@]*:[^\s/@]*@/g, '://***:***@');
}

module.exports = { DATA_REPO, resolveDataRepoRemoteUrl, redactUrl };
