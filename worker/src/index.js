import crypto from 'node:crypto';
// Generated at deploy/test time by scripts/bundle-agentic.js from the validated
// agentic.yaml + scripts/lib/agentic.js (see worker/package.json pretest and
// .github/workflows/deploy-worker.yml). Missing or invalid file = no build.
import {
  SPEC,
  loadSpecObject,
  route,
  resolveAgent,
  eventFromWebhook,
  matchRelays,
  explainRelays,
  eventFromTelegram,
  eventFromSystem,
  systemActors,
  headBranchRoutes,
  headBranchMatches,
  parseDuration,
} from './agentic.generated.js';

// agentic.yaml, re-validated once per isolate (fail closed: an invalid spec
// means every routed request answers 500 and nothing is dispatched).
// AGENTIC_SPEC is a test hook (a JSON string); production never sets it and
// always uses the bundled SPEC.
let cachedSpec = null;
function getSpec(env) {
  if (env.AGENTIC_SPEC !== undefined) {
    const raw = typeof env.AGENTIC_SPEC === 'string' ? JSON.parse(env.AGENTIC_SPEC) : env.AGENTIC_SPEC;
    const { spec, errors } = loadSpecObject(raw);
    if (errors.length) throw new Error(`agentic.yaml is invalid: ${errors.join('; ')}`);
    return spec;
  }
  if (!cachedSpec) {
    const { spec, errors } = loadSpecObject(SPEC);
    if (errors.length) throw new Error(`agentic.yaml is invalid: ${errors.join('; ')}`);
    cachedSpec = spec;
  }
  return cachedSpec;
}

// Routes a normalized event through agentic.yaml. Returns { hit, resolved } or
// { response } (an "ignored" 200 for a policy miss, 500 for a broken spec or
// an ambiguous match, which is a config bug rather than a policy decision).
function routeEvent(env, event, what) {
  let spec;
  try {
    spec = getSpec(env);
  } catch (err) {
    return { response: new Response(`agentic spec unavailable: ${err.message}`, { status: 500 }) };
  }
  let hit;
  try {
    hit = route(spec, event);
  } catch (err) {
    return { response: new Response(`agentic routing error: ${err.message}`, { status: 500 }) };
  }
  if (!hit) return { response: new Response(`ignored: no agent trigger matches this ${what}`, { status: 200 }) };
  let resolved;
  try {
    resolved = resolveAgent(spec, hit.name, hit.match);
  } catch (err) {
    // e.g. owner outside the allowlist, or a branch capture that is not a
    // declared repo alias: default-deny, never a partial scope.
    return { response: new Response(`ignored: ${err.message}`, { status: 200 }) };
  }
  return { spec, hit, resolved };
}

// agentic.yaml `limits.max_runs_per_hour`, counted per agent per UTC hour in
// KV. A cost/loop guard, not an access control: skipped when no KV binding
// is configured (tests), counted only after a successful dispatch.
async function rateLimitKey(env, resolved) {
  const limit = resolved.limits?.max_runs_per_hour;
  if (!limit || !env.CI_FAILURE_DEDUP) return { key: null, exceeded: false };
  const key = `runs:${resolved.agent}:${Math.floor(Date.now() / 3600000)}`;
  const count = Number(await env.CI_FAILURE_DEDUP.get(key)) || 0;
  return { key, exceeded: count >= limit, count };
}

async function countRun(env, limitState) {
  if (!limitState.key) return;
  await env.CI_FAILURE_DEDUP.put(limitState.key, String((limitState.count || 0) + 1), { expirationTtl: 2 * 3600 });
}

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
// handleReview: resolves the configured owner/repo, sets the
// common headers, and sends eventType + { raw: rawPayload, ...extra }.
async function dispatchRepoEvent(env, token, eventType, rawPayload, extra = {}) {
  return postRepositoryDispatch(env, token, eventType, { raw: rawPayload, ...extra });
}

async function postRepositoryDispatch(env, token, eventType, clientPayload) {
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
      body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
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

  // Likewise, a push has no comment author.
  if (eventType === 'push') {
    return handlePush(payload, env, request.headers.get('X-GitHub-Delivery') || '');
  }

  // Likewise, a review by a reviewer some `review` trigger names (CodeRabbit)
  // is never authored by an allowlisted human and never mentions the bot, so
  // it needs its own bypass flow too.
  const reviewerLogin = (payload.review?.user?.login || '').toLowerCase();
  if (eventType === 'pull_request_review' && systemActors(getSpecOrNull(env), 'review', 'reviewers').has(reviewerLogin)) {
    return handleReview(payload, env);
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
  const headRoutes = headBranchRoutes(getSpecOrNull(env));
  // A bodyless `changes_requested` review is the explicit signal a head-branch
  // route listens for, so it is not an "inline-only" review to skip.
  const reviewHeadRef = payload.pull_request?.head?.ref || '';
  const changesRequested = payload.review?.state === 'changes_requested' &&
    headRoutes.some(r => reviewHeadRef && headBranchMatches(r.glob, reviewHeadRef));
  if (eventType === 'pull_request_review' && !changesRequested && (typeof reviewBody !== 'string' || reviewBody.trim() === '')) {
    return new Response('ignored: review has no top-level body (inline-only review)', { status: 200 });
  }
  if (eventType === 'pull_request_review_comment' && !payload.comment?.pull_request_review_id) {
    return new Response('ignored: comment not tied to a review', { status: 200 });
  }

  // Which agent (if any) this comment fires is decided by agentic.yaml: the
  // catch-all `default` agent matches any @mention, and a reply on a thread
  // the bot itself opened counts as an implicit mention — unless the bot
  // wrote it, or every status update would re-trigger a dispatch (see
  // eventFromWebhook). The agent is re-resolved by dispatcher.yml from the
  // same payload and file, so only the name is forwarded here.
  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  try {
    // issue_comment payloads don't carry the PR's head branch; a head-branch
    // route needs it, so fetch it (only for PR comments, only when such a
    // route exists). A failed lookup leaves it empty: head routes then don't
    // match and the event falls back to default routing.
    let headRef = '';
    let token;
    if (headRoutes.length > 0 && eventType === 'issue_comment' && payload.issue?.pull_request) {
      token = await getInstallationToken(env, installationId);
      headRef = await fetchPrHeadRef(payload.repository?.full_name, payload.issue.number, token);
    }

    const routed = routeEvent(env, eventFromWebhook(getSpecOrNull(env), eventType, payload, { head_ref: headRef }), 'comment');
    if (routed.response) return routed.response;
    const { hit, resolved } = routed;

    // Attempt cap for head-branch routes: bot comments/reviews keep
    // re-triggering, so cap dispatches per (agent, PR) regardless of author.
    const headRoute = headRoutes.find(r => r.name === hit.name);
    const attempts = headRoute ? await attemptState(env, hit.name, payload, headRoute.max_attempts) : null;
    if (attempts?.exceeded) {
      return new Response(`ignored: attempt cap (${attempts.max}) for agent ${hit.name} on this PR reached`, { status: 200 });
    }

    const limit = await rateLimitKey(env, resolved);
    if (limit.exceeded) {
      return new Response(`ignored: rate limit for agent ${hit.name} reached`, { status: 200 });
    }

    token = token || await getInstallationToken(env, installationId);

    const dispatchRes = await dispatchRepoEvent(env, token, eventType, payload, { agent: hit.name, ...(headRef ? { head_ref: headRef } : {}) });

    if (!dispatchRes.ok) {
      const errorText = await dispatchRes.text();
      return new Response(`dispatch failed: ${errorText}`, { status: 502 });
    }

    await countRun(env, limit);
    if (attempts) await countAttempt(env, attempts);
    return new Response('ok', { status: 200 });
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

async function fetchPrHeadRef(fullName, number, token) {
  if (!fullName || !number) return '';
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}/pulls/${number}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'the-intern-bot-relay' },
    });
    if (!res.ok) return '';
    return (await res.json()).head?.ref || '';
  } catch {
    return '';
  }
}

// Dispatches per (head-branch agent, PR), counted in KV after a successful
// dispatch; skipped when no KV binding is configured (tests).
async function attemptState(env, agent, payload, max) {
  if (!env.CI_FAILURE_DEDUP) return { key: null, exceeded: false, max };
  const number = payload.issue?.number ?? payload.pull_request?.number;
  const key = `attempts:${agent}:${payload.repository?.full_name}#${number}`.toLowerCase();
  const count = Number(await env.CI_FAILURE_DEDUP.get(key)) || 0;
  return { key, exceeded: count >= max, count, max };
}

async function countAttempt(env, state) {
  if (!state.key) return;
  await env.CI_FAILURE_DEDUP.put(state.key, String(state.count + 1), { expirationTtl: 14 * 86400 });
}

// eventFromWebhook needs the bot login from the spec; a broken spec is
// reported by routeEvent right after, so a null here is harmless.
function getSpecOrNull(env) {
  try {
    return getSpec(env);
  } catch {
    return { bot: 'the-intern-bot' };
  }
}

// Returns the set of check-run names that are completed+failing (or timed
// out) for a given ref, or null if the API call itself failed. Callers must
// treat null as "unknown" and fail open (dispatch) rather than assume no
// failures.
async function getFailingCheckNames(owner, repo, ref, token) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'the-intern-bot-relay',
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const runs = data.check_runs || [];
    return new Set(
      runs
        .filter(r => r.status === 'completed' && ['failure', 'timed_out'].includes(r.conclusion))
        .map(r => r.name)
    );
  } catch {
    return null;
  }
}

// Auto-queues a fix-CI dispatch when a check suite fails on a PR the bot
// itself opened, so it can fix its own broken PRs without a human comment.
// Deduped per (PR, head commit sha) via the CI_FAILURE_DEDUP KV namespace,
// since a same-repo bot PR commonly triggers both a `push` and a
// `pull_request` Actions run for the identical head sha, producing two
// check suites that would otherwise each fire their own ci_failure dispatch.
// A *new* commit on the same PR still dispatches normally — retry-until-fixed
// across distinct commits is preserved, only the same-commit double-fire is
// suppressed. (handlePush below has no such double-trigger and stays KV-free.)
//
// Guardrail: if every failing check on the PR's head is already failing on
// its base branch, the breakage is pre-existing (e.g. a shared transitive
// CVE) rather than something this PR's diff introduced — skip the dispatch
// so multiple bot PRs don't independently "fix" the same base-branch issue
// (see #109). Fails open (dispatches) when the check-runs lookup errors.
async function handleCheckSuite(payload, env) {
  const checkSuite = payload.check_suite;
  const pullRequests = checkSuite?.pull_requests || [];

  // A PR-less suite on the default branch (a push after a merge) goes to the
  // `branches: [default]` ci_failure route instead.
  const onDefaultBranch = pullRequests.length === 0 && payload.action === 'completed' &&
    !!checkSuite?.head_branch && checkSuite.head_branch === payload.repository?.default_branch;
  if (onDefaultBranch && checkSuite.conclusion === 'success') {
    // A green default branch ends the consecutive-failure streak.
    if (env.CI_FAILURE_DEDUP) await env.CI_FAILURE_DEDUP.delete(mainStreakKey(payload.repository?.full_name));
    return new Response('ignored: check_suite not a relevant failure', { status: 200 });
  }
  if (
    payload.action !== 'completed' ||
    !['failure', 'timed_out'].includes(checkSuite?.conclusion) ||
    (pullRequests.length === 0 && !onDefaultBranch)
  ) {
    return new Response('ignored: check_suite not a relevant failure', { status: 200 });
  }
  if (onDefaultBranch) return handleDefaultBranchFailure(payload, env);

  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  const sourceOwner = payload.repository?.owner?.login;
  const sourceRepo = payload.repository?.name;
  // checkSuite.head_sha is the commit this specific check suite actually ran
  // against and just failed for. The freshly-fetched pullRequest.head.sha
  // below reflects the PR's *current* head as of the API call, which can
  // already be a newer commit if the bot pushed again in between — keying on
  // that would misattribute (or wrongly dedupe) against a commit that hasn't
  // even finished CI yet. checkSuite.head_sha is the authoritative "commit
  // currently failing".
  const sha = checkSuite.head_sha;

  try {
    const token = await getInstallationToken(env, installationId);

    let dispatched = 0;
    let deduped = 0;
    let skippedPreExisting = 0;
    let rateLimited = 0;
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

      // Which PRs are fixable (author allowlist), the dedup window and the
      // pre-existing-failure guard all come from the matching ci_failure
      // agent in agentic.yaml.
      const routed = routeEvent(env, eventFromSystem('ci_failure', {
        repository: payload.repository,
        pull_request: pullRequest,
        check_suite: checkSuite,
      }), 'check suite');
      if (routed.response) {
        if (routed.response.status !== 200) return routed.response;
        continue;
      }
      const { hit, resolved } = routed;
      const trigger = routed.spec.agents[hit.name].trigger.ci_failure;
      const dedupTtl = trigger.dedup ? parseDuration(trigger.dedup) : 0;

      const dedupKey = `ci_failure:${sourceOwner}/${sourceRepo}#${number}@${sha}`;
      if (dedupTtl && await env.CI_FAILURE_DEDUP.get(dedupKey)) {
        deduped++;
        continue;
      }

      const headFailures = trigger.skip_preexisting
        ? await getFailingCheckNames(sourceOwner, sourceRepo, checkSuite.head_sha, token)
        : null;
      if (headFailures && headFailures.size > 0 && pullRequest.base?.sha) {
        const baseFailures = await getFailingCheckNames(sourceOwner, sourceRepo, pullRequest.base.sha, token);
        if (baseFailures && [...headFailures].every(name => baseFailures.has(name))) {
          // Every failing check already fails on the base branch too - pre-existing
          // breakage, not something this PR introduced. Skip the fix-dispatch.
          skippedPreExisting++;
          continue;
        }
      }

      const limit = await rateLimitKey(env, resolved);
      if (limit.exceeded) {
        rateLimited++;
        continue;
      }

      const dispatchRes = await dispatchRepoEvent(env, token, 'ci_failure', {
        repository: payload.repository,
        pull_request: pullRequest,
        check_suite: checkSuite,
        installation: payload.installation,
      }, { agent: hit.name });

      if (!dispatchRes.ok) {
        const errorText = await dispatchRes.text();
        return new Response(`dispatch failed: ${errorText}`, { status: 502 });
      }
      // Marked only after a successful dispatch, so a failed delivery leaves
      // the key unset and a subsequent retry (e.g. GitHub webhook redelivery)
      // can still go through instead of being permanently deduped.
      if (dedupTtl) await env.CI_FAILURE_DEDUP.put(dedupKey, '1', { expirationTtl: dedupTtl });
      await countRun(env, limit);
      dispatched++;
    }

    if (dispatched > 0) {
      return new Response('ok', { status: 200 });
    }
    if (deduped > 0) {
      return new Response('ignored: ci_failure already dispatched for this PR+commit', { status: 200 });
    }
    if (skippedPreExisting > 0) {
      return new Response('ignored: all failures pre-existing on base branch', { status: 200 });
    }
    if (rateLimited > 0) {
      return new Response('ignored: rate limit for the ci_failure agent reached', { status: 200 });
    }
    return new Response('ignored: no bot-authored pull requests', { status: 200 });
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

const DEFAULT_MAX_CONSECUTIVE = 3;
const mainStreakKey = fullName => `ci_main_streak:${fullName}`.toLowerCase();

async function fetchCommit(owner, repo, sha, token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'the-intern-bot-relay' },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// A check suite failed on the default branch with no PR (e.g. right after a
// bot PR merged). Routed to a `ci_failure` agent with `branches: [default]`;
// the commit's author/committer must be in its `pr_authors`. Guards: dedup per
// (repo, sha), skip_preexisting against the previous commit, the per-hour rate
// limit, and `max_consecutive` auto-fix dispatches on main without a green
// run in between (reset by a successful default-branch suite).
async function handleDefaultBranchFailure(payload, env) {
  const checkSuite = payload.check_suite;
  const installationId = payload.installation?.id;
  if (!installationId) return new Response('missing installation id', { status: 400 });
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const fullName = payload.repository?.full_name;
  const sha = checkSuite.head_sha;

  try {
    const token = await getInstallationToken(env, installationId);
    const commit = await fetchCommit(owner, repo, sha, token);
    const raw = {
      repository: payload.repository,
      check_suite: checkSuite,
      commit: { author_login: commit?.author?.login || '', committer_login: commit?.committer?.login || '' },
      installation: payload.installation,
    };
    const routed = routeEvent(env, eventFromSystem('ci_failure', raw), 'default-branch check suite');
    if (routed.response) return routed.response;
    const { hit, resolved } = routed;
    const trigger = routed.spec.agents[hit.name].trigger.ci_failure;

    const dedupTtl = trigger.dedup ? parseDuration(trigger.dedup) : 0;
    const dedupKey = `ci_failure:${owner}/${repo}@${sha}`;
    if (dedupTtl && await env.CI_FAILURE_DEDUP.get(dedupKey)) {
      return new Response('ignored: ci_failure already dispatched for this commit', { status: 200 });
    }

    if (trigger.skip_preexisting) {
      const headFailures = await getFailingCheckNames(owner, repo, sha, token);
      const parent = commit?.parents?.[0]?.sha;
      if (headFailures && headFailures.size > 0 && parent) {
        const baseFailures = await getFailingCheckNames(owner, repo, parent, token);
        if (baseFailures && [...headFailures].every(name => baseFailures.has(name))) {
          return new Response('ignored: all failures pre-existing on previous commit', { status: 200 });
        }
      }
    }

    const max = trigger.max_consecutive || DEFAULT_MAX_CONSECUTIVE;
    const streakKey = mainStreakKey(fullName);
    const streak = env.CI_FAILURE_DEDUP ? Number(await env.CI_FAILURE_DEDUP.get(streakKey)) || 0 : 0;
    if (streak >= max) {
      return new Response(`ignored: ${max} consecutive auto-fix attempts on the default branch reached`, { status: 200 });
    }

    const limit = await rateLimitKey(env, resolved);
    if (limit.exceeded) return new Response(`ignored: rate limit for agent ${hit.name} reached`, { status: 200 });

    const dispatchRes = await dispatchRepoEvent(env, token, 'ci_failure', raw, { agent: hit.name });
    if (!dispatchRes.ok) {
      return new Response(`dispatch failed: ${await dispatchRes.text()}`, { status: 502 });
    }
    if (dedupTtl) await env.CI_FAILURE_DEDUP.put(dedupKey, '1', { expirationTtl: dedupTtl });
    if (env.CI_FAILURE_DEDUP) await env.CI_FAILURE_DEDUP.put(streakKey, String(streak + 1), { expirationTtl: 7 * 86400 });
    await countRun(env, limit);
    return new Response('ok', { status: 200 });
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

// Auto-queues a merge_conflict dispatch when a push to the default branch
// leaves an open bot-authored PR unmergeable. GitHub has no webhook for "PR
// became unmergeable" — mergeable_state is computed asynchronously and only
// exposed by polling GET /pulls/{n}, which can return null mid-computation
// (see pollMergeableState). No dedup/KV: a push only fires this once per PR
// per push (unlike handleCheckSuite's push+pull_request double check-suite),
// and a PR that's still dirty on the next push just re-dispatches, which is
// the intended retry-until-fixed behavior.
async function handlePush(payload, env, deliveryId = '') {
  // agentic.yaml commit triggers (e.g. the specage spec/review branches) come
  // first; a push that matches one never reaches the default-branch logic.
  const defaultBranch = payload.repository?.default_branch;
  const pushedBranch = (payload.ref || '').replace(/^refs\/heads\//, '');
  const onDefaultBranch = !payload.deleted && Boolean(defaultBranch) && pushedBranch === defaultBranch;

  const commitEvent = eventFromWebhook(getSpecOrNull(env), 'push', payload);
  if (commitEvent) {
    const relays = matchRelays(getSpecOrNull(env), commitEvent);
    const relayLog = [];
    const relayReport = explainRelays(getSpecOrNull(env), commitEvent);
    // Relays are side-effect dispatches; they don't suppress an independently
    // matching commit trigger on the same push.
    const relayRes = relays.length ? await handleRelays(commitEvent, relays, payload, env, relayLog) : null;
    await logRelayDecisions(env, commitEvent, payload, deliveryId, relayReport, relayLog);
    const routed = routeEvent(env, commitEvent, 'push');
    if (routed.hit) {
      const res = await handleCommitTrigger(commitEvent, routed, payload, env);
      return relayRes && relayRes.status >= 400 && res.status < 400 ? relayRes : res;
    }
    if (relayRes) return relayRes;
    // A broken spec (500) always wins; a policy miss only matters off the
    // default branch, where nothing else could handle the push.
    if (!onDefaultBranch || routed.response.status !== 200) return routed.response;
  }

  if (!onDefaultBranch) {
    return new Response('ignored: push not on default branch', { status: 200 });
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  const sourceOwner = payload.repository?.owner?.login;
  const sourceRepo = payload.repository?.name;
  const pollAttempts = Number(env.MERGEABLE_POLL_ATTEMPTS) || 5;
  const pollDelayMs = Number(env.MERGEABLE_POLL_DELAY_MS) || 300;

  try {
    const token = await getInstallationToken(env, installationId);

    const openPulls = [];
    let pullsUrl = `https://api.github.com/repos/${sourceOwner}/${sourceRepo}/pulls?state=open&base=${encodeURIComponent(pushedBranch)}&per_page=100`;
    while (pullsUrl) {
      const pullsRes = await fetch(pullsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'the-intern-bot-relay',
        },
      });
      if (!pullsRes.ok) {
        const errorText = await pullsRes.text();
        return new Response(`failed to list pull requests: ${errorText}`, { status: 502 });
      }
      openPulls.push(...(await pullsRes.json()));
      pullsUrl = parseNextLinkUrl(pullsRes.headers.get('Link'));
    }
    // Cheap pre-filter on the PR authors some merge_conflict agent accepts, so
    // other people's PRs never cost a mergeable-state poll; routing below is
    // the authoritative gate.
    const conflictAuthors = systemActors(getSpecOrNull(env), 'merge_conflict', 'pr_authors');
    const botPulls = openPulls.filter(
      pr => conflictAuthors.has((pr.user?.login || '').toLowerCase())
    );

    let dispatched = 0;
    for (const { number, user: listedUser } of botPulls) {
      const polled = await pollMergeableState(
        sourceOwner,
        sourceRepo,
        number,
        token,
        pollAttempts,
        pollDelayMs
      );
      if (!polled || polled.mergeable_state !== 'dirty') continue;
      // The author the pre-filter matched on (the list entry) is authoritative.
      const pullRequest = { ...polled, user: polled.user || listedUser };

      const conflict = { mergeable_state: pullRequest.mergeable_state, base_ref: pushedBranch };
      const routed = routeEvent(env, eventFromSystem('merge_conflict', {
        repository: payload.repository,
        pull_request: pullRequest,
        merge_conflict: conflict,
      }), 'merge conflict');
      if (routed.response) {
        if (routed.response.status !== 200) return routed.response;
        continue;
      }
      const limit = await rateLimitKey(env, routed.resolved);
      if (limit.exceeded) continue;

      const dispatchRes = await dispatchRepoEvent(env, token, 'merge_conflict', {
        repository: payload.repository,
        pull_request: pullRequest,
        merge_conflict: conflict,
        installation: payload.installation,
      }, { agent: routed.hit.name });

      if (!dispatchRes.ok) {
        const errorText = await dispatchRes.text();
        return new Response(`dispatch failed: ${errorText}`, { status: 502 });
      }
      await countRun(env, limit);
      dispatched++;
    }

    if (dispatched > 0) {
      return new Response('ok', { status: 200 });
    }
    return new Response(
      dispatched > 0 ? 'ok' : 'ignored: no bot-authored pull requests became unmergeable',
      { status: 200 }
    );
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

// Commit-driven dispatch: a push matched an agent's `commit` trigger in
// agentic.yaml (repo, branch pattern with captures, trusted author — the
// author check doubles as loop avoidance). Files an `agent_commit`
// repository_dispatch (specage.yml) naming the agent and the structural
// facts of the push; the workflow re-routes the same event through the same
// file and refuses to run if it disagrees. Deduped per (agent, repo, sha) in
// KV and capped by the agent's max_runs_per_hour, both marked only after a
// successful dispatch.
async function handleCommitTrigger(event, { hit, resolved }, payload, env) {
  if (event.deleted) {
    return new Response('ignored: branch deleted', { status: 200 });
  }
  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  const dedupKey = `agent_commit:${hit.name}:${event.repo.toLowerCase()}@${event.sha}`;
  try {
    if (await env.CI_FAILURE_DEDUP.get(dedupKey)) {
      return new Response('ignored: commit already dispatched', { status: 200 });
    }
    const limit = await rateLimitKey(env, resolved);
    if (limit.exceeded) {
      return new Response(`ignored: rate limit for agent ${hit.name} reached`, { status: 200 });
    }

    const owner = env.AGENT_INFRA_OWNER || 'TheDeepestSpace';
    const repo = env.AGENT_INFRA_REPO || 'the-intern';
    const appJwt = mintAppJwt(env.APP_ID, normalizeKey(getPrivateKey(env)));
    const internInstall = env.AGENT_INFRA_INSTALLATION_ID || (await getInstallationIdForRepo(appJwt, `${owner}/${repo}`));
    if (!internInstall) {
      return new Response('app not installed on agent-infra repo', { status: 502 });
    }
    const internToken = await getInstallationToken(env, internInstall);

    const dispatchRes = await postRepositoryDispatch(env, internToken, 'agent_commit', {
      agent: hit.name,
      repo: event.repo,
      branch: event.branch,
      sha: event.sha,
      author: event.author,
      message: event.message,
      paths: event.paths,
      installation_id: String(installationId),
    });
    if (!dispatchRes.ok) {
      return new Response(`dispatch failed: ${await dispatchRes.text()}`, { status: 502 });
    }
    await env.CI_FAILURE_DEDUP.put(dedupKey, '1', { expirationTtl: 60 * 60 * 24 * 14 });
    await countRun(env, limit);
    return new Response('ok', { status: 200 });
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

// agentic.yaml `relays`: fires workflow_dispatch on a workflow in another repo
// (inputs: repo, sha, project). Pure relay; per-entry logic and idempotence
// live in that workflow. Deduped per (relay, repo, branch, sha) in KV.
async function handleRelays(event, relays, payload, env, log = []) {
  try {
    for (const relay of relays) {
      const dedupKey = `relay:${relay.name}:${event.repo.toLowerCase()}:${event.branch}@${event.sha}`;
      if (await env.CI_FAILURE_DEDUP.get(dedupKey)) { log.push({ relay: relay.name, outcome: 'deduped' }); continue; }
      const appJwt = mintAppJwt(env.APP_ID, normalizeKey(getPrivateKey(env)));
      const install = await getInstallationIdForRepo(appJwt, relay.workflow.repo);
      if (!install) {
        log.push({ relay: relay.name, outcome: 'no_install', workflow_repo: relay.workflow.repo });
        return new Response(`app not installed on ${relay.workflow.repo}`, { status: 502 });
      }
      const token = await getInstallationToken(env, install);
      const res = await fetch(
        `https://api.github.com/repos/${relay.workflow.repo}/actions/workflows/${relay.workflow.file}/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'the-intern-bot-relay',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: relay.workflow.ref, inputs: relay.inputs }),
        }
      );
      if (!res.ok) {
        const errBody = await res.text();
        log.push({ relay: relay.name, outcome: 'dispatch_failed', status: res.status, error: errBody.slice(0, 500) });
        return new Response(`relay dispatch failed: ${errBody}`, { status: 502 });
      }
      log.push({ relay: relay.name, outcome: 'dispatched', status: res.status });
      await env.CI_FAILURE_DEDUP.put(dedupKey, '1', { expirationTtl: 60 * 60 * 24 * 14 });
    }
    return new Response('ok', { status: 200 });
  } catch (err) {
    log.push({ outcome: 'error', error: String(err.message).slice(0, 500) });
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

// Relay diagnostics go to the (private) data repo as JSONL under
// relay-logs/YYYY-MM-DD.jsonl — never to console/Actions logs, which are
// public. Best-effort: any failure here is swallowed and never affects the
// relay. Records hold match facts only (no tokens, no payload bodies).
async function logRelayDecisions(env, event, payload, deliveryId, report, log) {
  try {
    if (!report.length) return;
    // Every per-relay decision (match or skip reason) for commit pushes.
    const rows = report.filter(r => r.reason !== 'not_commit' && r.reason !== 'deleted');
    if (!rows.length) return;
    // A log write is itself a push to the data repo; don't log those or the
    // writes would feed back into themselves.
    if (event.paths.length && event.paths.every(p => p.startsWith('relay-logs/'))) return;
    const ts = new Date().toISOString();
    const records = rows.map(r => {
      const rec = {
        ts,
        delivery: deliveryId,
        repo: event.repo,
        ref: payload.ref || '',
        sha: event.sha,
        sender: event.author,
        relay: r.name,
        match: r.match,
        reason: r.reason,
      };
      if (r.expected !== undefined) rec.expected = r.expected;
      if (r.name && log.length) Object.assign(rec, ...log.filter(l => l.relay === r.name || !l.relay).map(({ relay, ...rest }) => rest));
      return JSON.stringify(rec);
    });
    const appJwt = mintAppJwt(env.APP_ID, normalizeKey(getPrivateKey(env)));
    // Always the private data repo (never the pushed repo); each record keeps
    // the source repo in `repo`.
    const dataRepo = `${env.AGENT_INFRA_OWNER || 'TheDeepestSpace'}/${env.DATA_REPO_NAME || 'the-intern-data'}`;
    const install = await getInstallationIdForRepo(appJwt, dataRepo);
    if (!install) return;
    const token = await getInstallationToken(env, install);
    const path = `relay-logs/${ts.slice(0, 10)}.jsonl`;
    const url = `https://api.github.com/repos/${dataRepo}/contents/${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'the-intern-bot-relay',
      'Content-Type': 'application/json',
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      let sha;
      let prior = '';
      const cur = await fetch(url, { headers });
      if (cur.ok) {
        const j = await cur.json();
        sha = j.sha;
        prior = Buffer.from(j.content || '', 'base64').toString('utf8');
      } else if (cur.status !== 404) {
        return;
      }
      const content = Buffer.from(prior + records.join('\n') + '\n').toString('base64');
      const put = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ message: 'relay-logs: append', content, ...(sha ? { sha } : {}) }),
      });
      if (put.ok || (put.status !== 409 && put.status !== 422)) return;
    }
  } catch {
    // best-effort by design
  }
}

function normalizeKey(key) {
  key = (key || '').trim();
  return key.includes('-----BEGIN') ? key : Buffer.from(key, 'base64').toString('utf8');
}

// Polls GET /pulls/{n} for mergeable, retrying past a null response (GitHub
// still computing it) with a short fixed backoff. mergeable_state can turn
// non-null before mergeable finishes computing, so mergeable is the signal
// that the computation actually settled. Gives up and returns null after the
// attempt cap, rather than treating a still-null state as a conflict.
async function pollMergeableState(owner, repo, number, token, attempts, delayMs) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'the-intern-bot-relay',
      },
    });
    if (!prRes.ok) return null;
    const pullRequest = await prRes.json();
    if (pullRequest.mergeable !== null && pullRequest.mergeable !== undefined) {
      return pullRequest;
    }
    if (attempt < attempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

// Extracts the rel="next" URL from a GitHub Link header, or null if there's
// no next page (single-page result, or the final page).
function parseNextLinkUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

// Auto-queues a coderabbit_review dispatch when a reviewer a `review` trigger
// names (CodeRabbit) reviews a PR an allowed author opened (the bot), so
// unaddressed feedback gets picked up without a human having to manually
// re-trigger the bot. Bypasses ALLOWED_USERS/mention gating entirely, like
// handleCheckSuite. Tier-2 injection-safe: only structural fields (repo, PR
// number and author, review URL and reviewer) are ever forwarded here — the
// review body itself is never read by the worker. The dispatched session reads
// the actual review content itself via its own gh/api tool call later, the
// same trust boundary ci_failure already operates under.
async function handleReview(payload, env) {
  const raw = {
    repository: { full_name: payload.repository?.full_name },
    pull_request: { number: payload.pull_request?.number, user: { login: payload.pull_request?.user?.login } },
    coderabbit_review: {
      html_url: payload.review?.html_url,
      reviewer: payload.review?.user?.login,
      action: payload.action,
    },
  };
  const routed = routeEvent(env, eventFromSystem('coderabbit_review', raw), 'review');
  if (routed.response) return routed.response;

  const installationId = payload.installation?.id;
  if (!installationId) {
    return new Response('missing installation id', { status: 400 });
  }

  try {
    const limit = await rateLimitKey(env, routed.resolved);
    if (limit.exceeded) {
      return new Response(`ignored: rate limit for agent ${routed.hit.name} reached`, { status: 200 });
    }

    const token = await getInstallationToken(env, installationId);

    const dispatchRes = await dispatchRepoEvent(env, token, 'coderabbit_review', {
      ...raw,
      installation: { id: installationId },
    }, { agent: routed.hit.name });

    if (!dispatchRes.ok) {
      const errorText = await dispatchRes.text();
      return new Response(`dispatch failed: ${errorText}`, { status: 502 });
    }

    await countRun(env, limit);
    return new Response('ok', { status: 200 });
  } catch (err) {
    return new Response(`internal error: ${err.message}`, { status: 500 });
  }
}

// Returns {file_id, file_name} for a non-image file attachment (document,
// video, audio, voice, animation), or null. Images are handled as photos.
function pickFileAttachment(message) {
  const kinds = [
    ['document', 'document'],
    ['video', 'video'],
    ['audio', 'audio'],
    ['voice', 'voice'],
    ['animation', 'animation'],
  ];
  for (const [key, label] of kinds) {
    const f = message[key];
    if (!f?.file_id || f.mime_type?.startsWith('image/')) continue;
    return { file_id: f.file_id, file_name: f.file_name || label };
  }
  return null;
}

async function handleTelegram(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (env.TG_WEBHOOK_SECRET && secret !== env.TG_WEBHOOK_SECRET) {
    return new Response('bad secret', { status: 401 });
  }

  const update = await request.json();
  const message = update.message;
  const hasImageDocument = message?.document?.mime_type?.startsWith('image/');
  const attachment = message ? pickFileAttachment(message) : null;
  if (!message || (!message.text && !message.photo?.length && !hasImageDocument && !attachment)) {
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

  // agentic.yaml decides whether a Telegram message runs an agent (the
  // `telegram` trigger); telegram-session.yml re-resolves it from the same
  // forwarded text, so only the agent name travels with the payload.
  const routed = routeEvent(env, eventFromTelegram(message), 'telegram message');
  if (routed.response) return routed.response;
  const { hit, resolved } = routed;

  const owner = env.AGENT_INFRA_OWNER || 'TheDeepestSpace';
  const repo = env.AGENT_INFRA_REPO || 'the-intern';

  try {
    const limit = await rateLimitKey(env, resolved);
    if (limit.exceeded) {
      return new Response(`ignored: rate limit for agent ${hit.name} reached`, { status: 200 });
    }

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
      agent: hit.name,
      text: message.text || message.caption || '',
      chat_id: message.chat.id,
      sender_id: message.from.id,
      message_id: message.message_id,
    };
    if (message.photo && message.photo.length > 0) {
      // PhotoSize array is ordered smallest to largest.
      clientPayload.photo_file_id = message.photo[message.photo.length - 1].file_id;
    } else if (hasImageDocument) {
      clientPayload.photo_file_id = message.document.file_id;
    } else if (attachment) {
      clientPayload.file_id = attachment.file_id;
      clientPayload.file_name = attachment.file_name;
    }
    if (message.reply_to_message) {
      const replyTo = message.reply_to_message;
      clientPayload.reply_to_message_id = replyTo.message_id;
      clientPayload.reply_to_text = replyTo.text || replyTo.caption || '';
      if (replyTo.photo && replyTo.photo.length > 0) {
        // PhotoSize array is ordered smallest to largest.
        clientPayload.reply_to_photo_file_id = replyTo.photo[replyTo.photo.length - 1].file_id;
      } else if (replyTo.document?.mime_type?.startsWith('image/')) {
        clientPayload.reply_to_photo_file_id = replyTo.document.file_id;
      } else {
        const replyAttachment = pickFileAttachment(replyTo);
        if (replyAttachment) {
          clientPayload.reply_to_file_id = replyAttachment.file_id;
          clientPayload.reply_to_file_name = replyAttachment.file_name;
        }
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

    await countRun(env, limit);
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
