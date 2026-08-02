const fs = require('fs');
const path = require('path');

// Codex CLI (personal-account login) rewrites access_token/refresh_token into
// auth.json on every proactive refresh (~every 8 days) and on any 401. Our
// runners are ephemeral, so a refreshed file evaporates at job end unless we
// round-trip it: restore the secret before the run, write back whatever
// codex left on disk after, even on failure. See:
// https://developers.openai.com/codex/auth/ci-cd-auth

function getAuthPath() {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME is not set');
  return path.join(codexHome, 'auth.json');
}

// Every string value anywhere in the auth payload is a potential credential
// fragment. Register each one for log masking individually (not just the
// serialized blob) so masking still works if something ever logs a nested
// field or reformats the JSON.
function maskAllStrings(value) {
  if (typeof value === 'string') {
    if (value) console.log(`::add-mask::${value}`);
  } else if (Array.isArray(value)) {
    value.forEach(maskAllStrings);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(maskAllStrings);
  }
}

function restore() {
  const encoded = process.env.CODEX_AUTH_JSON;
  if (!encoded) {
    console.log('CODEX_AUTH_JSON secret not set; skipping Codex auth restore.');
    return;
  }

  console.log(`::add-mask::${encoded}`);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');

  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    console.error('CODEX_AUTH_JSON did not decode to valid JSON; refusing to write it.');
    process.exitCode = 1;
    return;
  }
  maskAllStrings(parsed);

  const authPath = getAuthPath();
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, decoded, { mode: 0o600 });
  console.log(`Restored Codex auth.json to ${authPath}`);
}

async function persist() {
  const authPath = getAuthPath();
  if (!fs.existsSync(authPath)) {
    console.log(`No auth.json at ${authPath}; nothing to persist (restore likely failed).`);
    return;
  }

  const token = process.env.REPO_ADMIN_TOKEN;
  if (!token) {
    console.log('REPO_ADMIN_TOKEN not set; skipping persist of refreshed Codex auth.json.');
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY is not set; cannot determine which repo owns the secret.');
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(authPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('auth.json on disk is not valid JSON after the run; refusing to persist it.');
    process.exitCode = 1;
    return;
  }
  maskAllStrings(parsed);
  const encoded = Buffer.from(raw, 'utf8').toString('base64');
  console.log(`::add-mask::${encoded}`);

  const sodium = require('libsodium-wrappers');
  await sodium.ready;

  const keyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-intern-bot',
    },
  });
  if (!keyRes.ok) {
    console.error(`Failed to fetch repo public key for secret encryption (${keyRes.status})`);
    process.exitCode = 1;
    return;
  }
  const { key, key_id } = await keyRes.json();

  const keyBytes = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.crypto_box_seal(sodium.from_string(encoded), keyBytes);
  const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

  const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/CODEX_AUTH_JSON`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-intern-bot',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
  });

  if (!putRes.ok) {
    console.error(`Failed to update CODEX_AUTH_JSON secret (${putRes.status})`);
    process.exitCode = 1;
    return;
  }

  console.log('Persisted refreshed Codex auth.json back to the CODEX_AUTH_JSON secret.');
}

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'restore') {
    restore();
  } else if (mode === 'persist') {
    persist().catch(err => {
      console.error(`Failed to persist Codex auth.json: ${err.message}`);
      process.exitCode = 1;
    });
  } else {
    console.error('Usage: node rotate-codex-auth.js <restore|persist>');
    process.exitCode = 1;
  }
}

module.exports = { restore, persist };
