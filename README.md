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

## Review dispatch (specage implement PRs)

The worker files a `review_request` dispatch (handled by `dispatcher.yml`) when:

- `review_requested` names `the-intern-bot[bot]` on a PR (sender must be the bot itself, as implement agents do, or in `ALLOWED_USERS`), or
- an allowlisted user comments `@the-intern-bot review` on a PR.

The dispatch always runs with `specage=true`, so the reviewer can read the spec, trail and `.specage/PROTOCOL.md` (Review section) from specage-data. It checks the PR against the linked spec statements / `Spec:` trailers, tests and trail consistency, and submits a review as the bot (a `--comment` review headed `APPROVE` / `CHANGES REQUESTED` when GitHub refuses a self-review of a bot-authored PR). It never pushes or merges; the human owner stays the final merger.

Loop guards (automatic `review_requested` path only; explicit comments bypass them): one dispatch per PR head sha, and at most `MAX_REVIEW_ROUNDS` (worker var, default 3) per PR, tracked in the `CI_FAILURE_DEDUP` KV. The bot's own reviews and comments never re-trigger a dispatch.
