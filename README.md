# the-intern
Agentic infra

## Nightly crawl (`.github/workflows/nightly-crawl.yml`)

Runs at 04:30 UTC (and on `workflow_dispatch`, with optional `repos` and
`dry_run` inputs) over every repo the GitHub App is installed on — the same
installation set the worker serves webhooks for. Three phases, all driven by
`scripts/nightly-crawl.js`:

1. **Conflict sweep** — bot-authored open PRs with `mergeable_state: dirty`
   get a `merge_conflict` `repository_dispatch` (the same payload the worker's
   push handler sends), unless a fix was already dispatched or the bot already
   commented about conflicts in the last 24h.
2. **Dependabot sweep** — one claude review agent per Dependabot PR
   (`review` matrix job, read-only token, no package execution) returns a
   JSON verdict `safe | suspicious` with reasons. The `act` job then:
   - **security** update (label `security`, "Dependabot security update" in
     the body, or an open Dependabot alert for the package) + safe + CI green
     → merged immediately;
   - **regular** update + safe + CI green → labeled `dep-confirmed` and
     commented; merged on a later run once ≥ 2 days have passed since that
     confirmation, re-checking CI and mergeability (and re-reviewing if the
     diff changed — a plain rebase keeps the clock);
   - **suspicious** → never merged; labeled `dep-suspicious` with the reasons
     in a comment, once per diff.

   Any Dependabot PR whose head commit has failing CI also gets one comment
   mentioning `@the-intern-bot` ("investigate and resolve if possible"). It is
   posted at most once per PR: a later crawl that finds the marker comment
   does nothing.

   Merges go through the plain PR merge API with the reviewed head SHA, so
   branch protection and required checks are respected, never bypassed.
   "CI green" means every check run on the head commit completed without
   failure and the combined status isn't failing; a commit with no checks at
   all is *not* green.
3. **Report** — a log of everything merged (repo, PR, package, from → to,
   security/regular, verdict summary) plus anything flagged, confirmed, or
   dispatched. Nothing is sent on a no-op night.

State (verdicts keyed by diff hash, confirmation timestamps, conflict
dedupe) persists on the `nightly-crawl` branch of the-intern-data via
`scripts/manage-nightly-crawl-state.js`, so the 2-day clock survives
between runs. Verdicts and the plan are also kept as run artifacts.

### Secrets and variables

| Name | Kind | Purpose |
| --- | --- | --- |
| `APP_ID`, `APP_PRIVATE_KEY` | secret (existing) | Enumerate installations and mint per-repo tokens |
| `DATA_REPO_TOKEN` | secret (existing) | Read/write the `nightly-crawl` state branch on the-intern-data |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret (existing) | Review agent |
| `TG_BOT_TOKEN`, `TG_ADMIN_CHAT_ID` | secret (existing) | Telegram copy of the report + failure alerts |
| `REPORT_MENTION` | variable | GitHub login @-mentioned in the report comment (default `TheDeepestSpace`) |
| `NIGHTLY_MAX_REVIEWS` | variable | Cap on review agents per night (default 20; the rest wait for the next run) |
| `NIGHTLY_REVIEW_MODEL` | variable | Optional `--model` for the review agent |

### App permissions needed on target repos

The dispatcher's existing grants already cover most of this; verify the App
has, on every installed repo: **Pull requests: write** (merge), **Contents:
write** (merge commit), **Issues: write** (labels and comments), **Checks:
read** and **Commit statuses: read** (CI-green check), **Metadata: read**.
Optional: **Dependabot alerts: read** — lets the crawl classify a PR as a
security update from the alerts API even when the `security` label was
stripped; without it the label/body heuristics are used alone. If the merge
API answers 403, the App is missing `pull_requests: write` or
`contents: write`; if 405, branch protection declined — both show up in the
report's error section rather than being bypassed.

## Roles

A leading `role=` token (alongside `backend=`, `model=`, `effort=`, `specage=`) picks the prompt for a run. `role=review` selects the review prompt; no role is the default (implement) role.

## Review dispatch (specage implement PRs)

The worker files a `review_request` dispatch (handled by `dispatcher.yml`, always `role=review`) when:

- the bot (or an `ALLOWED_USERS` member) comments `@the-intern-bot role=review` (or bare `review`) on a PR. This is how a bot-authored PR gets reviewed: GitHub does not deliver a `review_requested` event when the bot requests review from itself, so the implement agent should post this comment instead.
- `review_requested` names `the-intern-bot[bot]` on a PR (sender the bot itself or in `ALLOWED_USERS`), for when another actor does the requesting.

`@the-intern-bot role=review <extra instructions>` from an allowlisted user goes through the generic flow with the review prompt.

The dispatch always runs with `specage=true`, so the reviewer can read the spec, trail and `.specage/PROTOCOL.md` (Review section) from specage-data. It checks the PR against the linked spec statements / `Spec:` trailers, tests and trail consistency, and submits a review as the bot (a `--comment` review headed `APPROVE` / `CHANGES REQUESTED` when GitHub refuses a self-review of a bot-authored PR). It never pushes or merges; the human owner stays the final merger.

When the reviewer requests changes it posts a comment starting `@the-intern-bot` with no `role=`. A bot comment like that on a bot-authored PR passes the allowlist and runs the default implement role.

Loop guards (bot-originated requests only; allowlisted humans bypass the review ones): one review dispatch per PR head sha, at most `MAX_REVIEW_ROUNDS` (worker var, default 3) review dispatches and as many implement hand-backs per PR, tracked in the `CI_FAILURE_DEDUP` KV (best-effort).
