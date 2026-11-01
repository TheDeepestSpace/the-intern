// Nightly crawl driver (issue #257) — the scripted half of
// nightly-crawl.yml. One subcommand per workflow phase:
//
//   plan            enumerate every repo the App is installed on, dispatch
//                   conflict fixes for the bot's dirty PRs, and list the
//                   Dependabot PRs that need an agent review (matrix output)
//   review-prompt   write the per-PR review prompt the agent job runs
//   record-verdict  turn the agent's result.json into a verdict artifact
//   act             merge / confirm / flag each reviewed Dependabot PR and
//                   persist the state (2-day clock) to the-intern-data
//   report          deliver the night's log to the owner
//
// All GitHub access goes through per-repo App installation tokens
// (mint-installation-token.js), the same trust path the dispatcher uses;
// the only use of this repo's own GITHUB_TOKEN is the repository_dispatch
// back into the-intern for conflict fixes.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getInstallationToken, getPrivateKey, mintAppJwt } = require('./mint-installation-token.js');
const { DATA_REPO } = require('./data-repo-remote.js');
const store = require('./nightly-crawl-store.js');
const { readState, updateState } = require('./manage-nightly-crawl-state.js');
const { postReportComment } = require('./send-report.js');

const GH_API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REVIEWS = 20;
const MERGEABLE_POLL_ATTEMPTS = 4;
const MERGEABLE_POLL_DELAY_MS = 1500;

// ------------------------------------------------------------ GitHub API

function ghHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'User-Agent': 'the-intern-bot-nightly-crawl',
    'Content-Type': 'application/json',
  };
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function ghRequest(token, url, { method = 'GET', body, accept } = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url.startsWith('http') ? url : `${GH_API}${url}`, {
    method,
    headers: ghHeaders(token, accept),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${method} ${url} failed (${res.status}): ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function ghJson(token, url, opts, fetchImpl) {
  const res = await ghRequest(token, url, opts, fetchImpl);
  if (res.status === 204) return null;
  return res.json();
}

// Array endpoints are concatenated; object-shaped pages (e.g.
// /installation/repositories' { total_count, repositories }) are collected
// as-is for the caller to unwrap.
async function ghPaginate(token, url, fetchImpl) {
  const items = [];
  let next = url;
  while (next) {
    const res = await ghRequest(token, next, {}, fetchImpl);
    const page = await res.json();
    if (Array.isArray(page)) items.push(...page);
    else items.push(page);
    next = parseNextLink(res.headers?.get ? res.headers.get('Link') : null);
  }
  return items;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------- repo enumeration

// "Every project the-intern serves" = every repo the GitHub App is
// installed on (the worker is webhook-driven off those same
// installations; there is no separate static list). NIGHTLY_CRAWL_REPOS
// (comma-separated owner/repo) narrows that for manual runs.
async function enumerateRepos(env, deps) {
  const { fetchImpl = fetch, mintAppJwt: mintAppJwtFn = mintAppJwt } = deps;
  const appJwt = mintAppJwtFn(env.APP_ID, getPrivateKey(env));
  const skip = new Set([DATA_REPO.toLowerCase(), (env.DATA_REPO || '').toLowerCase()]);

  const override = (env.NIGHTLY_CRAWL_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (override.length > 0) {
    const repos = [];
    for (const repo of override) {
      const data = await ghJson(appJwt, `/repos/${repo}/installation`, {}, fetchImpl);
      repos.push({ repo, installationId: data.id });
    }
    return repos;
  }

  const installations = await ghPaginate(appJwt, '/app/installations?per_page=100', fetchImpl);
  const repos = [];
  for (const installation of installations) {
    const token = await deps.mintToken({ installationId: installation.id, scopeToRepo: false });
    const page = await ghPaginate(token, '/installation/repositories?per_page=100', fetchImpl);
    const list = page.flatMap((p) => (Array.isArray(p.repositories) ? p.repositories : []));
    for (const r of list) {
      if (r.archived || r.disabled) continue;
      if (skip.has((r.full_name || '').toLowerCase())) continue;
      repos.push({ repo: r.full_name, installationId: installation.id, defaultBranch: r.default_branch });
    }
  }
  return repos;
}

function makeTokenMinter(env, permissions) {
  const cache = new Map();
  return async ({ targetRepo, installationId, scopeToRepo = true }) => {
    const cacheKey = `${installationId}:${scopeToRepo ? targetRepo : '*'}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const token = await getInstallationToken({
      appId: env.APP_ID,
      privateKey: getPrivateKey(env),
      installationId,
      targetRepo,
      scopeToRepo,
      permissions,
    });
    cache.set(cacheKey, token);
    return token;
  };
}

// ------------------------------------------------------------ PR helpers

// mergeable/mergeable_state are computed lazily by GitHub and come back
// null until the computation finishes; poll a few times like the worker's
// pollMergeableState does.
async function getPrDetail(token, repo, number, deps) {
  const { fetchImpl = fetch, sleep: sleepFn = sleep } = deps;
  let pr = null;
  for (let attempt = 0; attempt < MERGEABLE_POLL_ATTEMPTS; attempt++) {
    pr = await ghJson(token, `/repos/${repo}/pulls/${number}`, {}, fetchImpl);
    if (pr.state !== 'open' || pr.mergeable !== null) return pr;
    await sleepFn(MERGEABLE_POLL_DELAY_MS);
  }
  return pr;
}

async function getPrDiff(token, repo, number, deps) {
  const res = await ghRequest(token, `/repos/${repo}/pulls/${number}`, { accept: 'application/vnd.github.diff' }, deps.fetchImpl);
  return res.text();
}

async function listRecentBotComments(token, repo, number, since, deps) {
  const url = `/repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(since)}&per_page=100`;
  return ghPaginate(token, url, deps.fetchImpl);
}

async function listOpenAlerts(token, repo, deps) {
  try {
    return await ghPaginate(token, `/repos/${repo}/dependabot/alerts?state=open&per_page=100`, deps.fetchImpl);
  } catch (err) {
    // 403/404 = the App lacks vulnerability_alerts or alerts are disabled;
    // classification falls back to label + body heuristics.
    console.log(`Dependabot alerts unavailable for ${repo} (${err.status || '?'}); using label/body classification only.`);
    return [];
  }
}

async function dispatchMergeConflict(env, { repo, pr, installationId, defaultBranch }, deps) {
  const raw = {
    repository: {
      full_name: repo,
      name: repo.split('/')[1],
      owner: { login: repo.split('/')[0] },
      default_branch: defaultBranch || pr.base?.ref,
    },
    pull_request: {
      number: pr.number,
      title: pr.title,
      html_url: pr.html_url,
      head: { ref: pr.head?.ref, sha: pr.head?.sha },
      base: { ref: pr.base?.ref },
      mergeable_state: pr.mergeable_state,
    },
    merge_conflict: { mergeable_state: pr.mergeable_state, base_ref: pr.base?.ref },
    installation: { id: installationId },
    nightly_crawl: true,
  };
  await ghRequest(env.GH_TOKEN || env.GITHUB_TOKEN, `/repos/${env.GITHUB_REPOSITORY}/dispatches`, {
    method: 'POST',
    body: { event_type: 'merge_conflict', client_payload: { raw } },
  }, deps.fetchImpl);
}

function slugify(repo) {
  return repo.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function appendOutput(env, key, value) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// ------------------------------------------------------------------ plan

async function plan(env = process.env, deps = {}) {
  const dryRun = env.DRY_RUN === 'true';
  const now = deps.now ? deps.now() : Date.now();
  const maxReviews = Number(env.MAX_REVIEWS) > 0 ? Number(env.MAX_REVIEWS) : DEFAULT_MAX_REVIEWS;
  const mintToken = deps.mintToken || makeTokenMinter(env);
  const d = { fetchImpl: fetch, sleep, ...deps, mintToken };

  const state = await (deps.readState || readState)();
  const repos = await (deps.enumerateRepos || enumerateRepos)(env, d);
  console.log(`Crawling ${repos.length} repo(s)${dryRun ? ' (dry run)' : ''}.`);

  const planOut = {
    generatedAt: new Date(now).toISOString(),
    dryRun,
    crawledRepos: [],
    openKeys: [],
    conflicts: [],
    dependabot: [],
    reviews: [],
  };
  const dispatchedKeys = [];
  const since = new Date(now - store.CONFLICT_DEDUPE_MS).toISOString();

  for (const { repo, installationId, defaultBranch } of repos) {
    let pulls;
    let token;
    try {
      token = await mintToken({ targetRepo: repo, installationId });
      pulls = await ghPaginate(token, `/repos/${repo}/pulls?state=open&per_page=100`, d.fetchImpl);
    } catch (err) {
      console.warn(`::warning::Skipping ${repo}: ${err.message}`);
      continue;
    }
    planOut.crawledRepos.push(repo);
    const dependabotPrs = pulls.filter(store.isDependabotPr);
    const alerts = dependabotPrs.length > 0 ? await listOpenAlerts(token, repo, d) : [];

    for (const pr of pulls) {
      const key = store.prKey(repo, pr.number);
      planOut.openKeys.push(key);
      try {
        if (store.isBotPr(pr)) {
          const detail = await getPrDetail(token, repo, pr.number, d);
          if (!store.isConflicting(detail)) continue;
          const comments = await listRecentBotComments(token, repo, pr.number, since, d);
          const decision = store.shouldDispatchConflictFix({ key, state, botComments: comments, now });
          const entry = { key, url: pr.html_url, dispatched: false, reason: decision.reason };
          if (decision.dispatch) {
            if (!dryRun) {
              await dispatchMergeConflict(env, { repo, pr: detail, installationId, defaultBranch }, d);
              dispatchedKeys.push(key);
            }
            entry.dispatched = !dryRun;
            entry.reason = dryRun ? 'dry run: would dispatch' : null;
            console.log(`${key}: conflicting${dryRun ? ' (dry run, not dispatched)' : ', dispatched merge_conflict'}.`);
          } else {
            console.log(`${key}: conflicting but skipped — ${decision.reason}`);
          }
          planOut.conflicts.push(entry);
        } else if (store.isDependabotPr(pr)) {
          const detail = await getPrDetail(token, repo, pr.number, d);
          const diff = await getPrDiff(token, repo, pr.number, d);
          const diffHash = store.computeDiffHash(diff);
          const parsed = store.parseDependabotTitle(detail.title);
          const candidate = {
            key,
            repo,
            number: pr.number,
            slug: slugify(repo),
            installationId,
            title: detail.title,
            url: detail.html_url,
            package: parsed.package,
            from: parsed.from,
            to: parsed.to,
            classification: store.classifyDependabotPr(detail, alerts),
            headSha: detail.head?.sha,
            diffHash,
            mergeableState: detail.mergeable_state,
            needsReview: store.needsReview(state.dependabot[key], diffHash),
          };
          planOut.dependabot.push(candidate);
          console.log(`${key}: dependabot ${candidate.classification} update (${parsed.package}) — ${candidate.needsReview ? 'needs review' : 'verdict cached'}.`);
        }
      } catch (err) {
        console.warn(`::warning::${key}: ${err.message}`);
      }
    }
  }

  const needing = planOut.dependabot.filter((c) => c.needsReview);
  planOut.reviews = needing.slice(0, maxReviews).map(({ key, repo, number, slug, installationId, title }) => ({
    key, repo, number, slug, installation_id: String(installationId), title,
  }));
  if (needing.length > planOut.reviews.length) {
    console.log(`${needing.length - planOut.reviews.length} review(s) deferred to a later run (MAX_REVIEWS=${maxReviews}).`);
  }

  if (dispatchedKeys.length > 0) {
    await (deps.updateState || updateState)((current) => {
      let next = current;
      for (const key of dispatchedKeys) next = store.markConflictDispatched(next, key, now);
      return { state: next };
    });
  }

  const planFile = env.PLAN_FILE || 'plan.json';
  fs.writeFileSync(planFile, `${JSON.stringify(planOut, null, 2)}\n`);
  appendOutput(env, 'has_reviews', planOut.reviews.length > 0 ? 'true' : 'false');
  appendOutput(env, 'matrix', JSON.stringify({ include: planOut.reviews }));
  console.log(`Plan: ${planOut.conflicts.length} conflicting bot PR(s), ${planOut.dependabot.length} dependabot PR(s), ${planOut.reviews.length} review(s) to run.`);
  return planOut;
}

// ---------------------------------------------------------- review prompt

function buildReviewPrompt({ repo, number, title }) {
  return [
    `You are @the-intern-bot performing a supply-chain security review of Dependabot pull request #${number} in repository ${repo}${title ? ` ("${title}")` : ''}.`,
    '',
    'You have a READ-ONLY GitHub token in `gh`. Do not comment, label, approve, merge, push, or otherwise modify anything on GitHub — this is a review only.',
    '',
    'Inspect the PR diff (`gh pr diff ' + number + ' --repo ' + repo + '`) and the metadata of every package version the PR introduces (registry API / `npm view` / `pip index` / `cargo info` / the ecosystem\'s equivalent, plus the package\'s source repository and release page). NEVER install the packages or execute any code from them — read tarball contents with `npm pack --dry-run`, `tar -t`, or by fetching files from the registry only.',
    '',
    'Look for malicious or high-risk indicators:',
    '- maintainer/ownership change, takeover, or recent package-ownership transfer; new or rogue publisher',
    '- new or changed install/postinstall/preinstall scripts, build hooks, or setup.py side effects',
    '- obfuscated, minified-only, base64/hex-encoded, or eval-based code added to the package',
    '- unexpected network, child-process/exec, filesystem, credential, or environment-variable access',
    '- version jump anomalies (a surprise major bump, a version far ahead of the release cadence, a re-published/yanked version)',
    '- typosquatting or lookalike names, dependency substitution, or a changed source repository/homepage',
    '- known advisories (GHSA/CVE) for the new version',
    '- lockfile changes pulling in packages the manifest never asked for',
    '',
    'When the diff only touches a lockfile/manifest and the new version\'s published contents look like a routine release from the same maintainers, the verdict is "safe". Reserve "suspicious" for concrete indicators you can cite, not for ordinary uncertainty.',
    '',
    'Your FINAL message must be exactly one JSON object and nothing else, in this shape:',
    '{"verdict": "safe" | "suspicious", "reasons": ["<concrete indicator or check performed>", ...], "summary": "<one sentence>"}',
  ].join('\n');
}

function reviewPrompt(env = process.env) {
  const prompt = buildReviewPrompt({ repo: env.REPO, number: env.PR_NUMBER, title: env.PR_TITLE || '' });
  fs.writeFileSync(env.PROMPT_FILE || '/tmp/prompt.txt', prompt);
}

// ---------------------------------------------------------- record verdict

function recordVerdict(env = process.env, now = Date.now()) {
  const resultFile = env.RESULT_FILE || '/tmp/result.json';
  let verdict;
  try {
    const raw = fs.readFileSync(resultFile, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { result: raw, is_error: false };
    }
    const text = typeof data.result === 'string' ? data.result : JSON.stringify(data.result ?? data);
    verdict = store.parseVerdict(text);
    if (data.is_error && verdict.verdict !== 'suspicious') {
      verdict = { verdict: 'error', reasons: [`agent run reported an error: ${text.slice(0, 300)}`], summary: '' };
    }
  } catch (err) {
    verdict = { verdict: 'error', reasons: [`could not read agent result: ${err.message}`], summary: '' };
  }
  const out = {
    key: store.prKey(env.REPO, env.PR_NUMBER),
    repo: env.REPO,
    number: Number(env.PR_NUMBER),
    ...verdict,
    reviewedAt: new Date(now).toISOString(),
  };
  fs.writeFileSync(env.VERDICT_FILE || 'verdict.json', `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Verdict for ${out.key}: ${out.verdict}${out.reasons.length ? ` — ${out.reasons.join('; ')}` : ''}`);
  return out;
}

function loadVerdicts(dir) {
  const verdicts = new Map();
  if (!dir || !fs.existsSync(dir)) return verdicts;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        try {
          const v = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (v.key) verdicts.set(v.key, v);
        } catch (err) {
          console.warn(`::warning::Ignoring unreadable verdict file ${full}: ${err.message}`);
        }
      }
    }
  };
  walk(dir);
  return verdicts;
}

// ------------------------------------------------------------------- act

async function ensureLabel(token, repo, name, { color, description }, deps) {
  try {
    await ghJson(token, `/repos/${repo}/labels`, { method: 'POST', body: { name, color, description } }, deps.fetchImpl);
  } catch (err) {
    if (err.status !== 422) throw err; // 422 = already exists
  }
}

async function addLabel(token, repo, number, name, deps) {
  await ghJson(token, `/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels: [name] } }, deps.fetchImpl);
}

async function postComment(token, repo, number, body, deps) {
  await ghJson(token, `/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } }, deps.fetchImpl);
}

async function pickMergeMethod(token, repo, cache, deps) {
  if (cache.has(repo)) return cache.get(repo);
  const settings = await ghJson(token, `/repos/${repo}`, {}, deps.fetchImpl);
  const method = settings.allow_squash_merge ? 'squash' : settings.allow_merge_commit ? 'merge' : 'rebase';
  cache.set(repo, method);
  return method;
}

// Plain PUT /merge with the reviewed head SHA: GitHub refuses (405/409)
// when branch protection, required checks, or a moved head say no — this
// never uses an admin bypass.
async function mergePr(token, repo, number, sha, method, deps) {
  return ghJson(token, `/repos/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    body: { merge_method: method, sha },
  }, deps.fetchImpl);
}

async function fetchCi(token, repo, sha, deps) {
  const checks = await ghJson(token, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, {}, deps.fetchImpl);
  const combinedStatus = await ghJson(token, `/repos/${repo}/commits/${sha}/status`, {}, deps.fetchImpl);
  return store.isCiGreen({ checkRuns: checks?.check_runs || [], combinedStatus });
}

async function act(env = process.env, deps = {}) {
  const dryRun = env.DRY_RUN === 'true';
  const now = deps.now ? deps.now() : Date.now();
  const mintToken = deps.mintToken || makeTokenMinter(env);
  const d = { fetchImpl: fetch, sleep, ...deps, mintToken };

  const planOut = JSON.parse(fs.readFileSync(env.PLAN_FILE || 'plan.json', 'utf8'));
  const verdicts = loadVerdicts(env.VERDICTS_DIR || 'verdicts');
  const state = await (deps.readState || readState)();

  const events = {
    merged: [],
    flagged: [],
    confirmed: [],
    pending: [],
    errors: [],
    conflicts: planOut.conflicts.filter((c) => c.dispatched),
  };
  const mutations = [];
  const mergeMethods = new Map();
  let working = state;

  for (const cand of planOut.dependabot) {
    const { key, repo, number } = cand;
    const item = {
      key,
      url: cand.url,
      title: cand.title,
      package: cand.package,
      from: cand.from,
      to: cand.to,
      classification: cand.classification,
    };
    try {
      const fresh = verdicts.get(key);
      if (fresh) {
        if (fresh.verdict === 'error') {
          events.errors.push({ key, reason: `review failed: ${(fresh.reasons || []).join('; ')}` });
          continue;
        }
        const update = {
          diffHash: cand.diffHash,
          headSha: cand.headSha,
          verdict: fresh.verdict,
          reasons: fresh.reasons || [],
          summary: fresh.summary || '',
          classification: cand.classification,
          now,
        };
        working = store.applyVerdict(working, key, update);
        mutations.push((s) => store.applyVerdict(s, key, update));
      }
      let record = working.dependabot[key];
      if (store.needsReview(record, cand.diffHash)) {
        events.pending.push({ ...item, reason: 'awaiting agent review (deferred to a later run)' });
        continue;
      }
      item.summary = record.summary;
      item.reasons = record.reasons;

      const token = await mintToken({ targetRepo: repo, installationId: cand.installationId });
      const pr = await getPrDetail(token, repo, number, d);
      if (pr.state !== 'open') {
        console.log(`${key}: no longer open; skipping.`);
        continue;
      }
      if (pr.head?.sha !== record.headSha) {
        const diffHash = store.computeDiffHash(await getPrDiff(token, repo, number, d));
        if (diffHash !== record.diffHash) {
          events.pending.push({ ...item, reason: 'head moved and the diff changed since review; re-reviewing next run' });
          continue;
        }
        const rebased = { ...record, headSha: pr.head.sha, now };
        working = store.applyVerdict(working, key, rebased);
        mutations.push((s) => store.applyVerdict(s, key, rebased));
        record = working.dependabot[key];
      }

      const ci = await fetchCi(token, repo, pr.head.sha, d);
      const decision = store.decideDependabotAction({
        record,
        classification: cand.classification,
        ci,
        mergeableState: pr.mergeable_state,
        now,
      });
      console.log(`${key}: ${decision.action} — ${decision.reason}`);

      if (decision.action === 'merge') {
        if (dryRun) {
          events.pending.push({ ...item, reason: `dry run: would merge (${decision.reason})` });
          continue;
        }
        const method = await pickMergeMethod(token, repo, mergeMethods, d);
        try {
          await mergePr(token, repo, number, pr.head.sha, method, d);
        } catch (err) {
          events.errors.push({ key, reason: `merge refused (${err.status || '?'}): ${err.message.slice(0, 300)}` });
          continue;
        }
        events.merged.push(item);
        mutations.push((s) => ({ ...s, dependabot: Object.fromEntries(Object.entries(s.dependabot).filter(([k]) => k !== key)) }));
      } else if (decision.action === 'confirm') {
        if (!dryRun) {
          await ensureLabel(token, repo, store.CONFIRMED_LABEL, { color: '0e8a16', description: 'Nightly crawl: reviewed safe; auto-merges after 2 days if CI stays green' }, d);
          await addLabel(token, repo, number, store.CONFIRMED_LABEL, d);
          await postComment(token, repo, number, store.confirmationComment(record, now), d);
          mutations.push((s) => store.markConfirmed(s, key, now));
        }
        events.confirmed.push(item);
      } else if (decision.action === 'flag') {
        if (!dryRun) {
          await ensureLabel(token, repo, store.SUSPICIOUS_LABEL, { color: 'b60205', description: 'Nightly crawl: review flagged this update as suspicious' }, d);
          await addLabel(token, repo, number, store.SUSPICIOUS_LABEL, d);
          await postComment(token, repo, number, store.suspiciousComment(record), d);
          mutations.push((s) => store.markFlagged(s, key, now));
        }
        events.flagged.push({ ...item, reasons: record.reasons, summary: record.summary });
      } else {
        events.pending.push({ ...item, reason: decision.reason });
      }
    } catch (err) {
      console.error(`::error::${key}: ${err.message}`);
      events.errors.push({ key, reason: err.message.slice(0, 300) });
    }
  }

  if (!dryRun) {
    await (deps.updateState || updateState)((current) => {
      let next = current;
      for (const m of mutations) next = m(next);
      next = store.pruneState(next, planOut.openKeys, planOut.crawledRepos);
      return { state: next };
    });
  }

  fs.writeFileSync(env.EVENTS_FILE || 'report-events.json', `${JSON.stringify(events, null, 2)}\n`);
  console.log(`Act: ${events.merged.length} merged, ${events.flagged.length} flagged, ${events.confirmed.length} confirmed, ${events.pending.length} waiting, ${events.errors.length} error(s).`);
  return events;
}

// ---------------------------------------------------------------- report

function sendTelegram(text, env) {
  execFileSync(process.execPath, [path.join(__dirname, 'send-telegram.js'), text], {
    stdio: 'inherit',
    timeout: FETCH_TIMEOUT_MS,
    env: { ...env, CHAT_ID: env.TG_ADMIN_CHAT_ID },
  });
}

async function report(env = process.env, deps = {}) {
  const dryRun = env.DRY_RUN === 'true';
  const events = JSON.parse(fs.readFileSync(env.EVENTS_FILE || 'report-events.json', 'utf8'));
  const built = store.buildReport(events, { runUrl: env.RUN_URL || '', date: deps.now ? deps.now() : Date.now() });
  fs.writeFileSync(env.REPORT_FILE || 'report.txt', built.text);

  if (!built.shouldSend) {
    console.log('Nothing merged, flagged, confirmed, or dispatched tonight; no report sent.');
    return { sent: [] };
  }
  if (dryRun) {
    console.log(`Dry run; report not sent:\n${built.text}`);
    return { sent: [] };
  }

  const sent = [];
  const postCommentFn = deps.postReportComment || postReportComment;
  const sendTelegramFn = deps.sendTelegram || sendTelegram;

  try {
    const { url } = await postCommentFn(built, env);
    sent.push(`issue${url ? `:${url}` : ''}`);
  } catch (err) {
    console.warn(`::warning::Report issue comment failed: ${err.message}`);
  }
  if (env.TG_BOT_TOKEN && env.TG_ADMIN_CHAT_ID) {
    try {
      sendTelegramFn(built.telegram, env);
      sent.push('telegram');
    } catch (err) {
      console.warn(`::warning::Telegram delivery failed: ${err.message}`);
    }
  }
  if (sent.length === 0) {
    console.error('::error::Report could not be delivered through any channel.');
    process.exitCode = 1;
  } else {
    console.log(`Report delivered via ${sent.join(', ')}.`);
  }
  return { sent };
}

// ------------------------------------------------------------------ main

const COMMANDS = { plan, 'review-prompt': reviewPrompt, 'record-verdict': recordVerdict, act, report };

if (require.main === module) {
  const command = COMMANDS[process.argv[2]];
  if (!command) {
    console.error(`Usage: nightly-crawl.js <${Object.keys(COMMANDS).join('|')}>`);
    process.exit(1);
  }
  Promise.resolve(command()).catch((err) => {
    console.error(`::error::nightly-crawl ${process.argv[2]} failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseNextLink,
  ghPaginate,
  enumerateRepos,
  makeTokenMinter,
  getPrDetail,
  dispatchMergeConflict,
  buildReviewPrompt,
  plan,
  reviewPrompt,
  recordVerdict,
  loadVerdicts,
  act,
  report,
};
