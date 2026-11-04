# the-intern
Agentic infra

## `agentic.yaml` — who triggers what, with which access

`agentic.yaml` (repo root) is the single source of truth for every agent:
its trigger, the repositories its token may touch, the prompt it runs,
backend/model/effort, timeout, rate limit and the side-effect actions it may
request. It is the security boundary: `.github/CODEOWNERS` requires an owner
review for every change, CI validates it (`node scripts/validate-agentic.js`),
and everything that dispatches an agent reads it — nothing is hardcoded
elsewhere. Invalid or missing file = nothing runs (fail closed).

```
node scripts/validate-agentic.js                      # validate
node scripts/validate-agentic.js --explain event.json # dry-run: which agent, access, prompt, params
```

### Triggers

| Kind | Fires on | Runner |
| --- | --- | --- |
| `comment` | `@the-intern-bot …` on an issue, PR or inline review thread (`verb: '*'` = any mention). A reply on a thread the bot opened and a manual `workflow_dispatch` count as implicit mentions. | `dispatcher.yml` |
| `commit` | A push to `repo` on a `branch` pattern (`@name` captures one segment) by a trusted `author` (also the loop guard). | `specage.yml` (`agent_commit` dispatch) |
| `manual` | `workflow_dispatch` of `dispatcher.yml` with `agent` + `parameters` (JSON, typed) — what a `dispatch_agent` action fires. | `dispatcher.yml` |
| `telegram` | A message in the admin chat. | `telegram-session.yml` |
| `ci_failure` | A check suite failed on a PR whose author is in `pr_authors` (the worker; `dedup` = once per PR+commit for that long, `skip_preexisting` = not when every failing check already fails on the base). | `dispatcher.yml` (`ci_failure` dispatch) |
| `merge_conflict` | A default-branch push (worker) or the nightly crawl's sweep left a PR by a `pr_authors` author `dirty`. | `dispatcher.yml` (`merge_conflict` dispatch) |
| `review` | A review by one of `reviewers` (CodeRabbit) was `submitted` (`actions`) on a PR by a `pr_authors` author. | `dispatcher.yml` (`coderabbit_review` dispatch) |
| `schedule` | A cron; the agent has `job:` instead of a prompt (see below). | its own workflow |

The three system triggers have no human text: the agent's `request` template is
the "New request:" (only `$trigger.<kind>.*` structural fields and `$repo` /
`$issue_number` — never review bodies or titles; a field that resolves empty
fails the run). `pr_authors` is mandatory (omitting it must not mean "any PR"),
the PR's repo is the only repo in `access`, and `limits.max_runs_per_hour`
applies per agent in the worker like for comments. Nothing about which PRs
qualify lives in the worker any more.

### Scheduled jobs

A `schedule` agent declares `trigger.schedule.cron`, `job` (one of the names in
`JOBS`, `scripts/lib/agentic.js`), `timeout`, `concurrency` (group, never
cancel-in-progress), `secrets`, `permissions` and `settings` (scalar tunables
the job's script reads through `scripts/lib/job-settings.js`; an env var of the
old name, e.g. `MAX_REVIEWS`, still overrides). GitHub Actions needs the cron,
`timeout-minutes`, concurrency group and `secrets.*` as literals in the
workflow file, so `scripts/__tests__/schedule-sync.test.js` fails CI when a
scheduled workflow drifts from its agent (cron, concurrency, timeouts, and any
secret used but not declared or declared but unused).


Params (`key=value`) are only recognised when declared: a leading run after
the mention for comments (`@the-intern-bot codex model=x effort=high …`), or
anywhere in the text for Telegram. Everything else stays request text.

### Access and tokens

`access.repos` lists aliases from `repos:`, `$trigger.…` fields that are
trusted (the comment's repo, a branch capture, a typed manual parameter —
never free text) or `'*'` (every repo the installation covers). Each run
mints its installation token from exactly that list
(`scripts/mint-installation-token.js` with `ACCESS`, re-minted on the same
list by `scripts/refresh-gh-token.js`):

- `scope: read/write` → the installation's permissions on those repos;
- `scope: read` on every entry → `contents: read` (no pushes), with issues
  and pull requests still writable so the agent can report back. GitHub
  permissions are per token, so a list mixing scopes gets read/write on all
  of it.
- `when: $trigger.comment.param.<boolean>` grants an entry only when that
  declared boolean param is true (how `specage=true` adds read access to
  the specage data repo).
- A branch capture used as a repo must be a declared alias (onboarding a
  project = adding it to `repos:`); owners outside `repos:`/`allowed_owners`
  are refused. Any unresolvable entry fails the run — never a partial scope.

### Prompts

`prompt:` (inline, `$repo`/`$issue_number`/`$trigger.…` interpolated) or
`prompt_file: {repo, path, ref?}` (fetched at run time with a read-only token
for that repo; `ref` pins it, otherwise the default branch is used; the
resolved sha is logged). `prompt_append` adds shared `snippets`. The runtime
parts (`scripts/assemble-prompt.js`) are appended after it: the token's
access list, the workspace-restore note, the inline-review-thread reply rule,
the specage block, the declared actions, `instructions/shared-style.md`, the
prior-run summary, then `New request:` + the request text.

### Actions

An agent may only request what its `actions` declare. The agent runs
`node scripts/emit-action.js "<name>" key=value …`, which queues a line;
after the session, `scripts/execute-actions.js` validates each line against
the declaration (name, parameter types, the target agent's manual
parameters, repos inside the agent's access) and executes it with system
credentials. Today `dispatch_agent` is executable (→ `workflow_dispatch` of
`dispatcher.yml` with `agent` + `parameters`); a rejected action fails the
step and notifies.

### Deploying a change

1. Edit `agentic.yaml`, get the CODEOWNERS review, merge.
2. The worker is rebuilt by `deploy-worker.yml`: `scripts/bundle-agentic.js`
   validates the file and bundles it (plus the dependency-free
   `scripts/lib/agentic.js`) into `worker/src/agentic.generated.js`, which the
   worker routes every webhook through. An invalid file stops the deploy (and
   pings Telegram); the worker keeps serving the last valid bundle.
3. Workflows read the file from the checkout on every run; nothing else to
   deploy.

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
dedupe) persists on the `state/nightly-crawl` branch of the-intern-data via
`scripts/manage-nightly-crawl-state.js`, so the 2-day clock survives
between runs. Verdicts and the plan are also kept as run artifacts.

### Secrets and variables

| Name | Kind | Purpose |
| --- | --- | --- |
| `APP_ID`, `APP_PRIVATE_KEY` | secret (existing) | Enumerate installations and mint per-repo tokens |
| `DATA_REPO_TOKEN` | secret (existing) | Read/write the `state/nightly-crawl` state branch on the-intern-data |
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
