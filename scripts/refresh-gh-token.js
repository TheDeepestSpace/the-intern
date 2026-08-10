// Background loop for dispatcher.yml's `handle` job and telegram-session.yml's
// `respond` job (issue #145). GitHub installation tokens are hard-capped at
// 1hr and can't be refreshed by re-exporting GH_TOKEN mid-step — env vars are
// inherited once when the long-running agent CLI (claude -p / codex exec)
// spawns, not re-read afterward. Instead, this rewrites the dev user's
// on-disk `gh` credential store every ~45min: `gh` and git (via
// `gh auth setup-git`'s credential helper, already configured before this
// loop starts) both re-read it fresh on every invocation.
//
// Runs as the job's own (root) user — never as dev, the same untrusted
// context the agent CLI runs in — so APP_ID/APP_PRIVATE_KEY never reach it;
// only the minted token crosses that boundary, and only via an env var
// (never argv, which `ps` would expose to the dev user).
const { execFileSync } = require('child_process');
const { getInstallationToken, getPrivateKey } = require('./mint-installation-token.js');

const DEFAULT_INTERVAL_MS = 45 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mintToken(env = process.env) {
  const appId = env.APP_ID;
  const privateKey = getPrivateKey(env);
  if (!appId || !privateKey) {
    throw new Error('APP_ID and APP_PRIVATE_KEY are required to refresh the installation token');
  }

  return getInstallationToken({
    appId,
    privateKey,
    installationId: env.INSTALLATION_ID,
    targetRepo: env.TARGET_REPO,
    scopeToRepo: env.SCOPE_TO_REPO !== 'false',
  });
}

// `su`'s `-c` argument here is a fixed literal, never built from the token —
// the token only ever flows through the child's environment, so it can't
// leak via a `ps` listing of argv.
function applyToken(token, { env = process.env, exec = execFileSync } = {}) {
  console.log(`::add-mask::${token}`);
  exec('su', ['dev', '-c', 'echo "$REFRESHED_GH_TOKEN" | gh auth login --with-token'], {
    env: { ...env, REFRESHED_GH_TOKEN: token },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function runLoop({ intervalMs = DEFAULT_INTERVAL_MS, maxIterations = Infinity, env = process.env, exec = execFileSync } = {}) {
  for (let i = 0; i < maxIterations; i++) {
    await sleep(intervalMs);
    try {
      const token = await mintToken(env);
      applyToken(token, { env, exec });
      console.log("Refreshed installation token for the dev user's gh credential store.");
    } catch (err) {
      console.error(`::warning::Background token refresh failed: ${err.message}`);
    }
  }
}

module.exports = { mintToken, applyToken, runLoop };

if (require.main === module) {
  runLoop().catch((err) => {
    console.error(`Background token refresher crashed: ${err.message}`);
    process.exitCode = 1;
  });
}
