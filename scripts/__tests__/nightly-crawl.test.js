import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseNextLink,
  ghPaginate,
  enumerateRepos,
  buildReviewPrompt,
  plan,
  recordVerdict,
  loadVerdicts,
  act,
  report,
} from '../nightly-crawl.js';
import { emptyState, computeDiffHash, applyVerdict, markConfirmed, CONFIRMED_LABEL, SUSPICIOUS_LABEL, COMMENT_MARKER } from '../nightly-crawl-store.js';

const NOW = Date.parse('2026-11-01T04:30:00Z');
const DAY = 24 * 60 * 60 * 1000;
const API = 'https://api.github.com';

// Minimal fake GitHub: routes keyed by "METHOD url" (url relative to the API
// root, query string included). Each handler returns { status?, body? }
// where body is JSON unless `text` is set.
function fakeGitHub(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const rel = url.startsWith(API) ? url.slice(API.length) : url;
    const key = `${method} ${rel}`;
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers });
    const handler = routes[key];
    if (!handler) {
      return { ok: false, status: 404, text: async () => `no fake route for ${key}`, json: async () => ({}), headers: { get: () => null } };
    }
    const result = typeof handler === 'function' ? handler({ body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers }) : handler;
    const status = result.status ?? 200;
    const payload = result.text ?? JSON.stringify(result.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => payload,
      json: async () => (result.text !== undefined ? {} : (result.body ?? {})),
      headers: { get: (name) => (name.toLowerCase() === 'link' ? result.link || null : null) },
    };
  });
  return { fetchImpl, calls, called: (key) => calls.filter((c) => c.key === key) };
}

function memoryStore(initial = emptyState()) {
  let state = initial;
  return {
    readState: vi.fn(async () => state),
    updateState: vi.fn(async (mutate) => {
      const { state: next, ...rest } = mutate(state);
      state = next;
      return rest;
    }),
    get: () => state,
  };
}

function pr(overrides) {
  return {
    number: 1,
    state: 'open',
    title: 'Bump undici from 7.29.1 to 7.30.0',
    body: '',
    html_url: 'https://github.com/acme/widgets/pull/1',
    user: { login: 'dependabot[bot]' },
    labels: [],
    head: { ref: 'dependabot/npm_and_yarn/undici-7.30.0', sha: 'sha1' },
    base: { ref: 'main' },
    mergeable: true,
    mergeable_state: 'clean',
    ...overrides,
  };
}

let tmpDir;
let originalCwd;
beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-crawl-test-'));
  process.chdir(tmpDir);
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('parseNextLink / ghPaginate', () => {
  it('follows rel=next links', async () => {
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"')).toBe('https://api.github.com/x?page=2');
    expect(parseNextLink(null)).toBeNull();
    const gh = fakeGitHub({
      'GET /items?per_page=2': { body: [1, 2], link: '<https://api.github.com/items?per_page=2&page=2>; rel="next"' },
      'GET /items?per_page=2&page=2': { body: [3] },
    });
    expect(await ghPaginate('t', '/items?per_page=2', gh.fetchImpl)).toEqual([1, 2, 3]);
  });
});

describe('enumerateRepos', () => {
  const env = { APP_ID: '1', APP_PRIVATE_KEY: 'unused' };

  it('lists every non-archived repo across every installation, skipping the data repo', async () => {
    const gh = fakeGitHub({
      'GET /app/installations?per_page=100': { body: [{ id: 11 }, { id: 22 }] },
      'GET /installation/repositories?per_page=100': ({ headers }) => ({
        body: headers.Authorization === 'Bearer tok-11'
          ? { repositories: [{ full_name: 'acme/widgets', default_branch: 'main' }, { full_name: 'acme/old', archived: true }] }
          : { repositories: [{ full_name: 'TheDeepestSpace/the-intern-data' }, { full_name: 'acme/gadgets', default_branch: 'develop' }] },
      }),
    });
    const mintToken = vi.fn(async ({ installationId }) => `tok-${installationId}`);
    const repos = await enumerateRepos(env, { fetchImpl: gh.fetchImpl, mintToken, mintAppJwt: () => 'jwt' });
    expect(repos).toEqual([
      { repo: 'acme/widgets', installationId: 11, defaultBranch: 'main' },
      { repo: 'acme/gadgets', installationId: 22, defaultBranch: 'develop' },
    ]);
    expect(mintToken).toHaveBeenCalledWith({ installationId: 11, scopeToRepo: false });
  });

  it('honours the NIGHTLY_CRAWL_REPOS override by looking up each installation', async () => {
    const gh = fakeGitHub({ 'GET /repos/acme/widgets/installation': { body: { id: 33 } } });
    const repos = await enumerateRepos({ ...env, NIGHTLY_CRAWL_REPOS: ' acme/widgets ' }, { fetchImpl: gh.fetchImpl, mintToken: vi.fn(), mintAppJwt: () => 'jwt' });
    expect(repos).toEqual([{ repo: 'acme/widgets', installationId: 33 }]);
    expect(gh.calls[0].headers.Authorization).toBe('Bearer jwt');
  });
});

describe('plan', () => {
  const baseEnv = { GH_TOKEN: 'gha-token', GITHUB_REPOSITORY: 'TheDeepestSpace/the-intern', PLAN_FILE: 'plan.json' };
  const repos = [{ repo: 'acme/widgets', installationId: 11, defaultBranch: 'main' }];

  it('dispatches a merge_conflict for a dirty bot PR and records it in state', async () => {
    const botPr = pr({ number: 5, user: { login: 'the-intern-bot[bot]' }, title: 'feat', mergeable: false, mergeable_state: 'dirty', head: { ref: 'feat', sha: 'b1' } });
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls?state=open&per_page=100': { body: [botPr] },
      'GET /repos/acme/widgets/pulls/5': { body: botPr },
      [`GET /repos/acme/widgets/issues/5/comments?since=${encodeURIComponent(new Date(NOW - DAY).toISOString())}&per_page=100`]: { body: [] },
      'POST /repos/TheDeepestSpace/the-intern/dispatches': { status: 204, text: '' },
    });
    const s = memoryStore();
    const outputFile = path.join(tmpDir, 'out.txt');
    const result = await plan({ ...baseEnv, GITHUB_OUTPUT: outputFile }, {
      fetchImpl: gh.fetchImpl, mintToken: async () => 'repo-token', enumerateRepos: async () => repos, now: () => NOW, ...s,
    });

    expect(result.conflicts).toEqual([{ key: 'acme/widgets#5', url: botPr.html_url, dispatched: true, reason: null }]);
    const dispatch = gh.called('POST /repos/TheDeepestSpace/the-intern/dispatches')[0];
    expect(dispatch.headers.Authorization).toBe('Bearer gha-token');
    expect(dispatch.body.event_type).toBe('merge_conflict');
    expect(dispatch.body.client_payload.raw).toMatchObject({
      repository: { full_name: 'acme/widgets', default_branch: 'main' },
      pull_request: { number: 5 },
      merge_conflict: { mergeable_state: 'dirty', base_ref: 'main' },
      installation: { id: 11 },
    });
    expect(s.get().conflicts['acme/widgets#5'].dispatchedAt).toBe(new Date(NOW).toISOString());
    expect(fs.readFileSync(outputFile, 'utf8')).toContain('has_reviews=false');
    expect(fs.readFileSync(outputFile, 'utf8')).toContain('matrix={"include":[]}');
    expect(JSON.parse(fs.readFileSync('plan.json', 'utf8')).openKeys).toEqual(['acme/widgets#5']);
  });

  it('skips a dirty bot PR that was dispatched within 24h, and ignores clean ones and human PRs', async () => {
    const botPr = pr({ number: 5, user: { login: 'the-intern-bot[bot]' }, mergeable_state: 'dirty', mergeable: false });
    const cleanBotPr = pr({ number: 6, user: { login: 'the-intern-bot[bot]' } });
    const humanPr = pr({ number: 7, user: { login: 'human' }, mergeable_state: 'dirty', mergeable: false });
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls?state=open&per_page=100': { body: [botPr, cleanBotPr, humanPr] },
      'GET /repos/acme/widgets/pulls/5': { body: botPr },
      'GET /repos/acme/widgets/pulls/6': { body: cleanBotPr },
      [`GET /repos/acme/widgets/issues/5/comments?since=${encodeURIComponent(new Date(NOW - DAY).toISOString())}&per_page=100`]: { body: [] },
    });
    const s = memoryStore({ ...emptyState(), conflicts: { 'acme/widgets#5': { dispatchedAt: new Date(NOW - 3600000).toISOString() } } });
    const result = await plan(baseEnv, { fetchImpl: gh.fetchImpl, mintToken: async () => 't', enumerateRepos: async () => repos, now: () => NOW, ...s });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].dispatched).toBe(false);
    expect(gh.called('POST /repos/TheDeepestSpace/the-intern/dispatches')).toHaveLength(0);
    expect(gh.called('GET /repos/acme/widgets/pulls/7')).toHaveLength(0);
    expect(s.updateState).not.toHaveBeenCalled();
  });

  it('does not dispatch in dry-run mode', async () => {
    const botPr = pr({ number: 5, user: { login: 'the-intern-bot[bot]' }, mergeable_state: 'dirty', mergeable: false });
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls?state=open&per_page=100': { body: [botPr] },
      'GET /repos/acme/widgets/pulls/5': { body: botPr },
      [`GET /repos/acme/widgets/issues/5/comments?since=${encodeURIComponent(new Date(NOW - DAY).toISOString())}&per_page=100`]: { body: [] },
    });
    const s = memoryStore();
    const result = await plan({ ...baseEnv, DRY_RUN: 'true' }, { fetchImpl: gh.fetchImpl, mintToken: async () => 't', enumerateRepos: async () => repos, now: () => NOW, ...s });
    expect(result.conflicts[0]).toMatchObject({ dispatched: false, reason: 'dry run: would dispatch' });
    expect(gh.called('POST /repos/TheDeepestSpace/the-intern/dispatches')).toHaveLength(0);
    expect(s.updateState).not.toHaveBeenCalled();
  });

  it('collects dependabot PRs with diff hash + classification and puts unreviewed ones in the matrix', async () => {
    const regular = pr({ number: 1 });
    const security = pr({ number: 2, title: 'Bump lodash from 4.17.20 to 4.17.21', labels: [{ name: 'security' }], head: { sha: 'sha2' } });
    const cached = pr({ number: 3, title: 'Bump vitest from 5.0.0 to 5.1.0', head: { sha: 'sha3' } });
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls?state=open&per_page=100': { body: [regular, security, cached] },
      'GET /repos/acme/widgets/dependabot/alerts?state=open&per_page=100': { status: 403, text: 'nope' },
      'GET /repos/acme/widgets/pulls/1': ({ headers }) => (headers.Accept.includes('diff') ? { text: 'diff one' } : { body: regular }),
      'GET /repos/acme/widgets/pulls/2': ({ headers }) => (headers.Accept.includes('diff') ? { text: 'diff two' } : { body: security }),
      'GET /repos/acme/widgets/pulls/3': ({ headers }) => (headers.Accept.includes('diff') ? { text: 'diff three' } : { body: cached }),
    });
    const s = memoryStore(applyVerdict(emptyState(), 'acme/widgets#3', { diffHash: computeDiffHash('diff three'), headSha: 'old', verdict: 'safe', classification: 'regular', now: NOW - DAY }));
    const outputFile = path.join(tmpDir, 'out.txt');
    const result = await plan({ ...baseEnv, GITHUB_OUTPUT: outputFile, MAX_REVIEWS: '1' }, {
      fetchImpl: gh.fetchImpl, mintToken: async () => 't', enumerateRepos: async () => repos, now: () => NOW, ...s,
    });

    expect(result.dependabot.map((c) => [c.key, c.classification, c.needsReview])).toEqual([
      ['acme/widgets#1', 'regular', true],
      ['acme/widgets#2', 'security', true],
      ['acme/widgets#3', 'regular', false],
    ]);
    expect(result.dependabot[0]).toMatchObject({ package: 'undici', from: '7.29.1', to: '7.30.0', headSha: 'sha1', diffHash: computeDiffHash('diff one'), slug: 'acme-widgets' });
    // MAX_REVIEWS=1 caps the matrix; the second review is deferred.
    expect(result.reviews).toEqual([{ key: 'acme/widgets#1', repo: 'acme/widgets', number: 1, slug: 'acme-widgets', installation_id: '11', title: regular.title }]);
    const out = fs.readFileSync(outputFile, 'utf8');
    expect(out).toContain('has_reviews=true');
    expect(JSON.parse(out.match(/^matrix=(.*)$/m)[1]).include).toHaveLength(1);
  });

  it('keeps going when one repo cannot be listed and leaves it out of crawledRepos', async () => {
    const gh = fakeGitHub({
      'GET /repos/acme/gadgets/pulls?state=open&per_page=100': { body: [] },
    });
    const twoRepos = [{ repo: 'acme/widgets', installationId: 11 }, { repo: 'acme/gadgets', installationId: 11 }];
    const result = await plan(baseEnv, { fetchImpl: gh.fetchImpl, mintToken: async () => 't', enumerateRepos: async () => twoRepos, now: () => NOW, ...memoryStore() });
    expect(result.crawledRepos).toEqual(['acme/gadgets']);
  });
});

describe('buildReviewPrompt / recordVerdict / loadVerdicts', () => {
  it('builds a read-only review prompt that demands a JSON verdict', () => {
    const prompt = buildReviewPrompt({ repo: 'acme/widgets', number: 4, title: 'Bump x' });
    expect(prompt).toContain('pull request #4 in repository acme/widgets ("Bump x")');
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('"verdict": "safe" | "suspicious"');
  });

  it('records a parsed verdict from the agent result file', () => {
    fs.writeFileSync('result.json', JSON.stringify({ result: 'Looked at it.\n{"verdict":"safe","reasons":["same publisher"],"summary":"routine"}', is_error: false }));
    const out = recordVerdict({ RESULT_FILE: 'result.json', VERDICT_FILE: 'v.json', REPO: 'acme/widgets', PR_NUMBER: '4' }, NOW);
    expect(out).toEqual({ key: 'acme/widgets#4', repo: 'acme/widgets', number: 4, verdict: 'safe', reasons: ['same publisher'], summary: 'routine', reviewedAt: new Date(NOW).toISOString() });
    expect(JSON.parse(fs.readFileSync('v.json', 'utf8'))).toEqual(out);
  });

  it('records an error verdict when the agent errored or left nothing usable', () => {
    fs.writeFileSync('result.json', JSON.stringify({ result: 'usage limit reached', is_error: true }));
    expect(recordVerdict({ RESULT_FILE: 'result.json', VERDICT_FILE: 'v.json', REPO: 'a/b', PR_NUMBER: '1' }).verdict).toBe('error');
    expect(recordVerdict({ RESULT_FILE: 'missing.json', VERDICT_FILE: 'v.json', REPO: 'a/b', PR_NUMBER: '1' }).reasons[0]).toMatch(/could not read/);
    fs.writeFileSync('result.json', 'not json at all');
    expect(recordVerdict({ RESULT_FILE: 'result.json', VERDICT_FILE: 'v.json', REPO: 'a/b', PR_NUMBER: '1' }).verdict).toBe('error');
  });

  it('keeps a suspicious verdict even when the run was marked as an error', () => {
    fs.writeFileSync('result.json', JSON.stringify({ result: '{"verdict":"suspicious","reasons":["x"]}', is_error: true }));
    expect(recordVerdict({ RESULT_FILE: 'result.json', VERDICT_FILE: 'v.json', REPO: 'a/b', PR_NUMBER: '1' }).verdict).toBe('suspicious');
  });

  it('loads every verdict json under a directory tree, keyed by PR', () => {
    fs.mkdirSync('verdicts/nested', { recursive: true });
    fs.writeFileSync('verdicts/a.json', JSON.stringify({ key: 'a/b#1', verdict: 'safe' }));
    fs.writeFileSync('verdicts/nested/b.json', JSON.stringify({ key: 'a/b#2', verdict: 'suspicious' }));
    fs.writeFileSync('verdicts/bad.json', '{');
    const verdicts = loadVerdicts('verdicts');
    expect([...verdicts.keys()].sort()).toEqual(['a/b#1', 'a/b#2']);
    expect(loadVerdicts('nope').size).toBe(0);
  });
});

describe('act', () => {
  const env = { PLAN_FILE: 'plan.json', VERDICTS_DIR: 'verdicts', EVENTS_FILE: 'events.json' };

  function candidate(overrides) {
    return {
      key: 'acme/widgets#1',
      repo: 'acme/widgets',
      number: 1,
      slug: 'acme-widgets',
      installationId: 11,
      title: 'Bump undici from 7.29.1 to 7.30.0',
      url: 'https://github.com/acme/widgets/pull/1',
      package: 'undici',
      from: '7.29.1',
      to: '7.30.0',
      classification: 'regular',
      headSha: 'sha1',
      diffHash: computeDiffHash('diff one'),
      mergeableState: 'clean',
      needsReview: true,
      ...overrides,
    };
  }

  function writePlan(dependabot, extra = {}) {
    fs.writeFileSync('plan.json', JSON.stringify({ crawledRepos: ['acme/widgets'], openKeys: dependabot.map((c) => c.key), conflicts: [], dependabot, ...extra }));
  }

  function writeVerdict(key, verdict, reasons = [], summary = '') {
    fs.mkdirSync('verdicts', { recursive: true });
    fs.writeFileSync(`verdicts/${key.replace(/[^a-z0-9]/gi, '-')}.json`, JSON.stringify({ key, verdict, reasons, summary }));
  }

  const greenCi = {
    'GET /repos/acme/widgets/commits/sha1/check-runs?per_page=100': { body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] } },
    'GET /repos/acme/widgets/commits/sha1/status': { body: { state: 'success', total_count: 0 } },
  };

  it('merges a safe security update immediately with the repo-preferred merge method and the reviewed sha', async () => {
    writePlan([candidate({ classification: 'security' })]);
    writeVerdict('acme/widgets#1', 'safe', ['same maintainer'], 'routine');
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls/1': { body: pr() },
      ...greenCi,
      'GET /repos/acme/widgets': { body: { allow_squash_merge: false, allow_merge_commit: true } },
      'PUT /repos/acme/widgets/pulls/1/merge': { body: { merged: true } },
    });
    const s = memoryStore();
    const events = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.merged).toEqual([{ key: 'acme/widgets#1', url: 'https://github.com/acme/widgets/pull/1', title: 'Bump undici from 7.29.1 to 7.30.0', package: 'undici', from: '7.29.1', to: '7.30.0', classification: 'security', summary: 'routine', reasons: ['same maintainer'] }]);
    expect(gh.called('PUT /repos/acme/widgets/pulls/1/merge')[0].body).toEqual({ merge_method: 'merge', sha: 'sha1' });
    expect(s.get().dependabot['acme/widgets#1']).toBeUndefined();
    expect(JSON.parse(fs.readFileSync('events.json', 'utf8')).merged).toHaveLength(1);
  });

  it('confirms a safe regular update: label + comment + clock, no merge', async () => {
    writePlan([candidate()]);
    writeVerdict('acme/widgets#1', 'safe', [], 'fine');
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls/1': { body: pr() },
      ...greenCi,
      'POST /repos/acme/widgets/labels': { status: 422, text: 'already exists' },
      'POST /repos/acme/widgets/issues/1/labels': { body: [] },
      'POST /repos/acme/widgets/issues/1/comments': { status: 201, body: {} },
    });
    const s = memoryStore();
    const events = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.confirmed.map((c) => c.key)).toEqual(['acme/widgets#1']);
    expect(events.merged).toEqual([]);
    expect(gh.called('POST /repos/acme/widgets/issues/1/labels')[0].body).toEqual({ labels: [CONFIRMED_LABEL] });
    expect(gh.called('POST /repos/acme/widgets/issues/1/comments')[0].body.body).toContain(COMMENT_MARKER);
    expect(gh.called('PUT /repos/acme/widgets/pulls/1/merge')).toHaveLength(0);
    const record = s.get().dependabot['acme/widgets#1'];
    expect(record).toMatchObject({ verdict: 'safe', diffHash: computeDiffHash('diff one'), confirmedAt: new Date(NOW).toISOString() });
  });

  it('merges a regular update once confirmed ≥ 2 days ago, reusing the cached verdict', async () => {
    writePlan([candidate({ needsReview: false })]);
    const initial = markConfirmed(
      applyVerdict(emptyState(), 'acme/widgets#1', { diffHash: computeDiffHash('diff one'), headSha: 'sha1', verdict: 'safe', classification: 'regular', now: NOW - 3 * DAY }),
      'acme/widgets#1',
      NOW - 2 * DAY
    );
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls/1': { body: pr() },
      ...greenCi,
      'GET /repos/acme/widgets': { body: { allow_squash_merge: true } },
      'PUT /repos/acme/widgets/pulls/1/merge': { body: { merged: true } },
    });
    const s = memoryStore(initial);
    const events = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.merged).toHaveLength(1);
    expect(gh.called('PUT /repos/acme/widgets/pulls/1/merge')[0].body.merge_method).toBe('squash');
  });

  it('waits (and keeps the clock) when a confirmed update was rebased without changing the diff', async () => {
    writePlan([candidate({ needsReview: false, headSha: 'sha1' })]);
    const initial = markConfirmed(
      applyVerdict(emptyState(), 'acme/widgets#1', { diffHash: computeDiffHash('diff one'), headSha: 'sha1', verdict: 'safe', classification: 'regular', now: NOW - DAY }),
      'acme/widgets#1',
      NOW - DAY
    );
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls/1': ({ headers }) => (headers.Accept.includes('diff') ? { text: 'diff one' } : { body: pr({ head: { sha: 'sha2' } }) }),
      'GET /repos/acme/widgets/commits/sha2/check-runs?per_page=100': { body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] } },
      'GET /repos/acme/widgets/commits/sha2/status': { body: { state: 'pending', total_count: 0 } },
    });
    const s = memoryStore(initial);
    const events = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.pending[0].reason).toMatch(/eligible to merge after/);
    expect(s.get().dependabot['acme/widgets#1']).toMatchObject({ headSha: 'sha2', confirmedAt: new Date(NOW - DAY).toISOString() });
  });

  it('defers a PR whose diff changed after the review instead of acting on the stale verdict', async () => {
    writePlan([candidate({ needsReview: false })]);
    const initial = applyVerdict(emptyState(), 'acme/widgets#1', { diffHash: computeDiffHash('diff one'), headSha: 'sha1', verdict: 'safe', classification: 'security', now: NOW - DAY });
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls/1': ({ headers }) => (headers.Accept.includes('diff') ? { text: 'diff CHANGED' } : { body: pr({ head: { sha: 'sha2' } }) }),
    });
    const s = memoryStore(initial);
    const events = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.pending[0].reason).toMatch(/diff changed/);
    expect(gh.called('PUT /repos/acme/widgets/pulls/1/merge')).toHaveLength(0);
  });

  it('flags a suspicious update with label + reasons comment, once per diff', async () => {
    writePlan([candidate({ classification: 'security' })]);
    writeVerdict('acme/widgets#1', 'suspicious', ['new postinstall script', 'publisher changed'], 'bad');
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls/1': { body: pr() },
      ...greenCi,
      'POST /repos/acme/widgets/labels': { status: 201, body: {} },
      'POST /repos/acme/widgets/issues/1/labels': { body: [] },
      'POST /repos/acme/widgets/issues/1/comments': { status: 201, body: {} },
    });
    const s = memoryStore();
    const events = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.flagged[0]).toMatchObject({ key: 'acme/widgets#1', reasons: ['new postinstall script', 'publisher changed'] });
    expect(gh.called('POST /repos/acme/widgets/issues/1/labels')[0].body).toEqual({ labels: [SUSPICIOUS_LABEL] });
    expect(gh.called('POST /repos/acme/widgets/issues/1/comments')[0].body.body).toContain('- new postinstall script');
    expect(gh.called('PUT /repos/acme/widgets/pulls/1/merge')).toHaveLength(0);
    expect(s.get().dependabot['acme/widgets#1'].flaggedDiffHash).toBe(computeDiffHash('diff one'));

    // Second night, same diff: no second comment.
    fs.rmSync('verdicts', { recursive: true });
    writePlan([candidate({ classification: 'security', needsReview: false })]);
    const events2 = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW + DAY, ...s });
    expect(events2.flagged).toEqual([]);
    expect(events2.pending[0].reason).toMatch(/already flagged/);
    expect(gh.called('POST /repos/acme/widgets/issues/1/comments')).toHaveLength(1);
  });

  it('reports a merge the API refused (branch protection) as an error, not a merge', async () => {
    writePlan([candidate({ classification: 'security' })]);
    writeVerdict('acme/widgets#1', 'safe');
    const gh = fakeGitHub({
      'GET /repos/acme/widgets/pulls/1': { body: pr() },
      ...greenCi,
      'GET /repos/acme/widgets': { body: { allow_squash_merge: true } },
      'PUT /repos/acme/widgets/pulls/1/merge': { status: 405, text: 'Required status check "x" is expected.' },
    });
    const s = memoryStore();
    const events = await act(env, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.merged).toEqual([]);
    expect(events.errors[0].reason).toMatch(/merge refused \(405\)/);
  });

  it('treats error verdicts and unreviewed candidates as pending/errors, and prunes closed PRs from state', async () => {
    writePlan([candidate({ key: 'acme/widgets#1', number: 1 }), candidate({ key: 'acme/widgets#2', number: 2, headSha: 'sha2' })], { openKeys: ['acme/widgets#1', 'acme/widgets#2'] });
    writeVerdict('acme/widgets#1', 'error', ['usage limit']);
    const initial = applyVerdict(emptyState(), 'acme/widgets#9', { diffHash: 'x', headSha: 'y', verdict: 'safe', classification: 'regular', now: NOW });
    const s = memoryStore({ ...initial, dependabot: { ...initial.dependabot, 'other/repo#3': { verdict: 'safe', diffHash: 'z' } } });
    const events = await act(env, { fetchImpl: fakeGitHub({}).fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.errors[0]).toEqual({ key: 'acme/widgets#1', reason: 'review failed: usage limit' });
    expect(events.pending[0]).toMatchObject({ key: 'acme/widgets#2', reason: expect.stringMatching(/awaiting agent review/) });
    expect(Object.keys(s.get().dependabot)).toEqual(['other/repo#3']);
  });

  it('does nothing on GitHub or in state during a dry run', async () => {
    writePlan([candidate({ classification: 'security' })]);
    writeVerdict('acme/widgets#1', 'safe');
    const gh = fakeGitHub({ 'GET /repos/acme/widgets/pulls/1': { body: pr() }, ...greenCi });
    const s = memoryStore();
    const events = await act({ ...env, DRY_RUN: 'true' }, { fetchImpl: gh.fetchImpl, mintToken: async () => 'w', now: () => NOW, ...s });
    expect(events.pending[0].reason).toMatch(/dry run: would merge/);
    expect(gh.calls.some((c) => c.key.startsWith('PUT') || c.key.startsWith('POST'))).toBe(false);
    expect(s.updateState).not.toHaveBeenCalled();
  });
});

describe('report', () => {
  const events = { merged: [{ key: 'a/b#1', url: 'u', package: 'p', from: '1', to: '2', classification: 'security' }], flagged: [], confirmed: [], pending: [], errors: [], conflicts: [] };

  function setup(ev = events) {
    fs.writeFileSync('events.json', JSON.stringify(ev));
    return { EVENTS_FILE: 'events.json', REPORT_FILE: 'report.txt', RUN_URL: 'https://run' };
  }

  it('sends nothing when the night was a no-op', async () => {
    const env = setup({ merged: [], flagged: [], confirmed: [], pending: [{ key: 'x#1', reason: 'waiting' }], errors: [], conflicts: [] });
    const sendEmail = vi.fn();
    const result = await report({ ...env, RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c' }, { sendEmail, postReportIssue: vi.fn(), sendTelegram: vi.fn() });
    expect(result.sent).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fs.existsSync('report.txt')).toBe(true);
  });

  it('emails when Resend is configured and also pings Telegram, without the issue fallback', async () => {
    const env = { ...setup(), RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c', TG_BOT_TOKEN: 't', TG_ADMIN_CHAT_ID: '1' };
    const sendEmail = vi.fn(async () => ({ id: 'x' }));
    const postReportIssue = vi.fn();
    const sendTelegram = vi.fn();
    const result = await report(env, { sendEmail, postReportIssue, sendTelegram });
    expect(result.sent).toEqual(['email', 'telegram']);
    expect(sendEmail.mock.calls[0][0].subject).toContain('1 merged');
    expect(postReportIssue).not.toHaveBeenCalled();
    expect(sendTelegram.mock.calls[0][0]).toContain('✅ merged: a/b#1');
  });

  it('falls back to the data-repo issue when email is unconfigured or fails', async () => {
    const env = { ...setup(), DATA_REPO_TOKEN: 'd' };
    const postReportIssue = vi.fn(async () => ({ url: 'https://issue' }));
    expect((await report(env, { sendEmail: vi.fn(), postReportIssue, sendTelegram: vi.fn() })).sent).toEqual(['issue:https://issue']);

    const failing = vi.fn(async () => { throw new Error('resend down'); });
    const result = await report({ ...env, RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c' }, { sendEmail: failing, postReportIssue, sendTelegram: vi.fn() });
    expect(result.sent).toEqual(['issue:https://issue']);
  });

  it('flags a total delivery failure via exit code', async () => {
    const env = setup();
    const result = await report(env, { sendEmail: vi.fn(), postReportIssue: vi.fn(async () => { throw new Error('no'); }), sendTelegram: vi.fn() });
    expect(result.sent).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('prints but does not deliver in dry-run mode', async () => {
    const env = { ...setup(), DRY_RUN: 'true', RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c' };
    const sendEmail = vi.fn();
    expect((await report(env, { sendEmail, postReportIssue: vi.fn(), sendTelegram: vi.fn() })).sent).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
