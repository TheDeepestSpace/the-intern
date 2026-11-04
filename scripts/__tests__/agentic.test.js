import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadSpec, explain, accessAllows, route, branchPattern, resolveAction, eventFromWebhook, eventFromTelegram } from '../lib/agentic-yaml.js';
import { main } from '../validate-agentic.js';

const ROOT_FILE = path.join(import.meta.dirname, '..', '..', 'agentic.yaml');
const rootText = fs.readFileSync(ROOT_FILE, 'utf8');

const BASE = `
version: 1
repos:
  data: Acme/data
  proj: Acme/proj
  tool: Acme/tool
agents:
`;
const load = agents => loadSpec(BASE + agents);
const errs = agents => load(agents).errors;

describe('agentic.yaml (checked in)', () => {
  it('is valid', () => {
    expect(loadSpec(rootText).errors).toEqual([]);
  });

  it('validator CLI exits 0 for it and 1 for a broken file', () => {
    const log = console.log;
    console.log = () => {};
    try {
      expect(main([ROOT_FILE])).toBe(0);
    } finally {
      console.log = log;
    }
    const tmp = path.join(import.meta.dirname, 'tmp-bad-agentic.yaml');
    fs.writeFileSync(tmp, 'version: 2\nagents: {}\n');
    const e = console.error;
    console.error = () => {};
    try {
      expect(main([tmp])).toBe(1);
    } finally {
      console.error = e;
      fs.unlinkSync(tmp);
    }
  });
});

describe('validation', () => {
  it('rejects bad YAML, version and unknown keys', () => {
    expect(loadSpec('a: [').errors[0]).toMatch(/invalid YAML/);
    expect(loadSpec('version: 2\nagents: {x: 1}').errors).toContain('version: must be 1');
    expect(errs(`  a:\n    trigger: {manual: {}}\n    prompt: hi\n    bogus: 1\n`)).toContain("agents.a: unknown key 'bogus'");
  });

  it('requires exactly one trigger and one prompt source', () => {
    expect(errs(`  a:\n    trigger: {manual: {}, comment: {}}\n    prompt: hi\n`).join()).toMatch(/exactly one of/);
    expect(errs(`  a:\n    trigger: {manual: {}}\n`).join()).toMatch(/prompt\|prompt_file/);
  });

  it('rejects undefined repo aliases and bad scopes', () => {
    const e = errs(`  a:\n    trigger: {manual: {}}\n    access: {repos: [{name: nope, scope: admin}]}\n    prompt: hi\n`);
    expect(e.join()).toMatch(/undefined repo alias 'nope'/);
    expect(e.join()).toMatch(/scope/);
  });

  it('rejects unknown variables and vars the trigger does not provide', () => {
    const e = errs(`  a:\n    trigger: {manual: {parameters: {n: integer}}}\n    prompt: do $trigger.commit.sha $param.n $param.zzz\n`);
    expect(e).toHaveLength(2);
    expect(e.join()).toMatch(/\$trigger\.commit\.sha/);
    expect(e.join()).toMatch(/\$param\.zzz/);
  });

  it('never allows free-form comment params or text as an access repo', () => {
    const e = errs(`  a:\n    trigger: {comment: {params: {repo: string}}}\n    access: {repos: [{name: $trigger.comment.param.repo, scope: read}]}\n    prompt: hi\n`);
    expect(e.join()).toMatch(/not a trusted source/);
  });

  it('requires a commit author (loop avoidance) and branch', () => {
    const e = errs(`  a:\n    trigger: {commit: {repo: data}}\n    prompt: hi\n`).join();
    expect(e).toMatch(/branch: required/);
    expect(e).toMatch(/author: required/);
  });

  it('checks prompt_file repo is in access or prompt_repos, and path', () => {
    const f = (extra, pf) => errs(`  a:\n    trigger: {manual: {}}\n    ${extra}\n    prompt_file: ${pf}\n`);
    expect(f('', '{repo: tool, path: p.md}').join()).toMatch(/must be in access or prompt_repos/);
    expect(f('access: {repos: [{name: tool, scope: read}]}', '{repo: tool, path: p.md}')).toEqual([]);
    expect(f('access: {repos: [{name: tool, scope: read}]}', '{repo: tool, path: ../p.md}').join()).toMatch(/path/);
  });

  it('validates dispatch_agent targets, params and access', () => {
    const base = (withs, access = 'access: {repos: [{name: proj, scope: read}]}') => errs(`
  planner:
    trigger: {manual: {}}
    ${access}
    prompt: hi
    actions:
      - name: go
        parameters: {n: integer}
        dispatch_agent: {agent: impl, with: ${withs}}
  impl:
    trigger: {manual: {parameters: {repo: string, n: integer}}}
    prompt: hi
`);
    expect(base('{repo: proj, n: $n}')).toEqual([]);
    expect(base('{repo: proj}').join()).toMatch(/missing parameter 'n'/);
    expect(base('{repo: proj, n: $n, x: 1}').join()).toMatch(/unknown parameter 'x'/);
    expect(base('{repo: tool, n: $n}').join()).toMatch(/not in the agent's access/);
    expect(base('{repo: proj, n: $nope}').join()).toMatch(/unknown variable/);
    expect(errs(`  a:\n    trigger: {manual: {}}\n    prompt: hi\n    actions: [{name: x, dispatch_agent: {agent: ghost}}]\n`).join()).toMatch(/unknown agent 'ghost'/);
  });

  it('validates system triggers (ci_failure, merge_conflict, review)', () => {
    const ok = `  a:
    trigger: {ci_failure: {pr_authors: ["bot[bot]"], skip_preexisting: true, dedup: 14d}}
    access: {repos: [{name: $trigger.ci_failure.repo, scope: read/write}]}
    prompt: 'fix $repo#$issue_number'
    request: 'CI failed ($trigger.ci_failure.conclusion) at $trigger.ci_failure.head_sha'
`;
    expect(errs(ok)).toEqual([]);
    // The PR-author gate is mandatory: no list must never mean "any PR".
    expect(errs(ok.replace('pr_authors: ["bot[bot]"], ', '')).join()).toMatch(/pr_authors: non-empty list required/);
    expect(errs(ok.replace('pr_authors: ["bot[bot]"]', 'pr_authors: []')).join()).toMatch(/pr_authors: non-empty list required/);
    expect(errs(ok.replace('    request:', '    #request:')).join()).toMatch(/request: required for a ci_failure trigger/);
    expect(errs(ok.replace('$trigger.ci_failure.head_sha', '$trigger.ci_failure.nope')).join()).toMatch(/unknown variable/);
    expect(errs(ok.replace('14d', '14w')).join()).toMatch(/dedup/);
    expect(errs(`  a:\n    trigger: {merge_conflict: {pr_authors: [x], skip_preexisting: true}}\n    prompt: hi\n    request: hi\n`).join()).toMatch(/unknown key 'skip_preexisting'/);
    expect(errs(`  a:\n    trigger: {review: {pr_authors: [x]}}\n    prompt: hi\n    request: hi\n`).join()).toMatch(/reviewers: non-empty list required/);
    expect(errs(`  a:\n    trigger: {manual: {}}\n    prompt: hi\n    request: hi\n`).join()).toMatch(/request: only valid with/);
    // Free text is never a trusted source for a repo, but the event's repo is.
    expect(errs(ok.replace('$trigger.ci_failure.repo', '$trigger.ci_failure.conclusion')).join()).toMatch(/not a trusted source/);
  });

  it('validates schedule job agents', () => {
    const ok = `  j:
    trigger: {schedule: {cron: '0 7 * * *'}}
    job: cleanup-data-branches
    concurrency: grp
    secrets: [DATA_REPO_TOKEN]
    settings: {n: 3, flag: true}
`;
    expect(errs(ok)).toEqual([]);
    expect(errs(ok.replace('job: cleanup-data-branches', 'job: rm-rf')).join()).toMatch(/job: must be one of/);
    expect(errs(ok.replace('    job: cleanup-data-branches\n', '    prompt: hi\n')).join()).toMatch(/job: required for a schedule trigger/);
    expect(errs(ok + '    prompt: hi\n').join()).toMatch(/prompt: not allowed on a job agent/);
    expect(errs(ok.replace("'0 7 * * *'", "'0 7 *'")).join()).toMatch(/5-field cron/);
    expect(errs(ok.replace('{n: 3, flag: true}', '{n: [1]}')).join()).toMatch(/settings.n: must be a scalar/);
    expect(errs(`  a:\n    trigger: {manual: {}}\n    prompt: hi\n    job: update-model-list\n`).join()).toMatch(/job: only valid with a schedule trigger/);
    expect(errs(ok.replace('agents:', '') + `  k:\n    trigger: {schedule: {cron: '0 7 * * *'}}\n    job: update-model-list\n`).join()).toMatch(/ambiguous trigger/);
  });

  it('flags ambiguous triggers', () => {
    const e = errs(`  a:\n    trigger: {comment: {verb: go}}\n    prompt: hi\n  b:\n    trigger: {comment: {verb: GO}}\n    prompt: hi\n`);
    expect(e.join()).toMatch(/ambiguous trigger/);
  });
});

describe('trigger matching and resolution', () => {
  const spec = loadSpec(rootText).spec;
  const commit = (over = {}) => ({
    kind: 'commit', repo: 'TheDeepestSpace/specage-data', branch: 'specages/specage/spec',
    author: 'specage-app[bot]', sha: 'abc', ...over,
  });

  it('captures branch segments', () => {
    const { re } = branchPattern('specages/@project/spec');
    expect(re.exec('specages/foo/spec').groups.project).toBe('foo');
    expect(re.exec('specages/foo/bar/spec')).toBeNull();
  });

  it('routes a spec push to the planner with captures and scoped access', () => {
    const r = explain(spec, commit());
    expect(r.matched).toBe(true);
    expect(r.agent).toBe('specage_planner');
    expect(r.access).toEqual([
      { repo: 'TheDeepestSpace/specage', scope: 'read/write' },
      { repo: 'TheDeepestSpace/specage-data', scope: 'read' },
    ]);
    expect(r.prompt_file.repo).toBe('TheDeepestSpace/specage');
    expect(r.prompt_pinned).toBe(false);
    expect(accessAllows(r, 'TheDeepestSpace/specage', 'write')).toBe(true);
    expect(accessAllows(r, 'TheDeepestSpace/specage-data', 'write')).toBe(false);
    expect(accessAllows(r, 'TheDeepestSpace/other')).toBe(false);
  });

  it('ignores commits by other authors (loop avoidance), other repos and branches', () => {
    expect(explain(spec, commit({ author: 'mallory' })).matched).toBe(false);
    expect(explain(spec, commit({ repo: 'evil/specage-data' })).matched).toBe(false);
    expect(explain(spec, commit({ branch: 'specages/specage/trail' })).matched).toBe(false);
  });

  it('routes the review branch to the reviewer only for the bot author', () => {
    const e = commit({ branch: 'specages/specage/review', author: 'the-intern-bot[bot]' });
    expect(route(spec, e).name).toBe('specage_reviewer');
    expect(explain(spec, { ...e, author: 'specage-app[bot]' }).matched).toBe(false);
  });

  it('denies a project capture that is not a declared repo alias', () => {
    const r = explain(spec, commit({ branch: 'specages/unknown/spec' }));
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/resolved to nothing|not a valid owner\/repo/);
  });

  it('parses comment verb and declared params; default otherwise', () => {
    const ev = body => ({ kind: 'comment', repo: 'TheDeepestSpace/the-intern', author: 'u', on: 'issue', issue_number: 7, body });
    const r = explain(spec, ev('@the-intern-bot backend=codex model=gpt-x fix it'));
    expect(r).toMatchObject({ matched: true, agent: 'default', backend: 'codex', model: 'gpt-x', effort: 'default', timeout_seconds: 3600 });
    expect(r.access).toEqual([{ repo: 'TheDeepestSpace/the-intern', scope: 'read/write' }]);
    expect(r.prompt).toMatch(/^You are @the-intern-bot working on repository TheDeepestSpace\/the-intern, issue\/PR #7\.\nYou have access to the GitHub CLI/);
    expect(explain(spec, ev('@the-intern-bot')).backend).toBe('claude');
    expect(explain(spec, ev('please @the-intern-bot codex fix it')).backend).toBe('codex');
    expect(explain(spec, ev('@the-intern-bot fix it model=x')).params).toEqual({});
    expect(explain(spec, ev('hey, no mention')).matched).toBe(false);
    expect(explain(spec, ev('@the-intern-botx hi')).matched).toBe(false);
  });

  it('denies owners outside the allowlist', () => {
    const r = explain(spec, { kind: 'comment', repo: 'evil/repo', author: 'u', on: 'issue', issue_number: 1, body: '@the-intern-bot fix' });
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/not allowlisted/);
  });

  it('validates manual parameters and resolves repo from them', () => {
    const ev = parameters => ({ kind: 'manual', agent: 'specage_implementer', parameters });
    const ok = explain(spec, ev({ repo: 'TheDeepestSpace/specage', issue_number: 3 }));
    expect(ok.matched).toBe(true);
    expect(ok.prompt).toMatch(/Implement TheDeepestSpace\/specage#3/);
    expect(explain(spec, ev({ repo: 'TheDeepestSpace/specage', issue_number: '3' })).reason).toMatch(/integer/);
    expect(explain(spec, ev({ repo: 'evil/x', issue_number: 3 })).reason).toMatch(/not allowlisted/);
    expect(explain(spec, ev({ repo: 'TheDeepestSpace/specage', issue_number: 3, extra: 1 })).reason).toMatch(/unknown parameter/);
  });

  it('matches telegram messages, taking backend= from the text', () => {
    const ev = body => ({ kind: 'telegram', chat_id: 1, message_id: 2, body });
    const r = explain(spec, ev('hello backend=codex'));
    expect(r.matched).toBe(true);
    expect(r.agent).toBe('telegram');
    expect(r.backend).toBe('codex');
    expect(explain(spec, ev('hello')).backend).toBe('claude');
    expect(r.access).toEqual([{ repo: '*', scope: 'read/write' }]);
  });

  it('reports ambiguity at runtime instead of guessing', () => {
    const s = loadSpec(`${BASE}  a:\n    trigger: {issue: {events: [opened]}}\n    prompt: hi\n  b:\n    trigger: {issue: {events: [opened]}}\n    prompt: hi\n`).spec;
    expect(explain(s, { kind: 'issue', repo: 'Acme/x', author: 'u', action: 'opened', number: 1 }).reason).toMatch(/ambiguous/);
  });

  it('applies pr/issue label filters and agent overrides of defaults', () => {
    const s = loadSpec(`${BASE}  a:\n    trigger: {pull_request: {events: [opened], labels: [review]}}\n    timeout: 5m\n    prompt: look at $repo#$issue_number\n`).spec;
    const ev = labels => ({ kind: 'pull_request', repo: 'Acme/x', author: 'u', action: 'opened', number: 4, labels });
    expect(explain(s, ev([])).matched).toBe(false);
    expect(explain(s, ev(['review']))).toMatchObject({ matched: true, timeout_seconds: 300, prompt: 'look at Acme/x#4' });
  });
});

describe('cutover behaviours (issue #273)', () => {
  const spec = loadSpec(rootText).spec;
  const comment = (body, over = {}) => ({ kind: 'comment', repo: 'TheDeepestSpace/the-intern', author: 'u', on: 'issue', issue_number: 7, body, ...over });

  it('strips every mention and the leading declared tokens into `text`, like parse-trigger.js did', () => {
    expect(explain(spec, comment('hey @the-intern-bot please help')).text).toBe('hey please help');
    const r = explain(spec, comment('@the-intern-bot codex model=gpt-x effort=high specage=true fix the -c model="sol" flag'));
    expect(r.params).toEqual({ backend: 'codex', model: 'gpt-x', effort: 'high', specage: true });
    expect(r.text).toBe('fix the -c model="sol" flag');
    // An undeclared key=value ends the control-token run and stays prompt text.
    expect(explain(spec, comment('@the-intern-bot foo=1 model=x do it')).text).toBe('foo=1 model=x do it');
    expect(explain(spec, comment('@the-intern-bot')).text).toBe('');
  });

  it('matches inline review-thread comments and implicit mentions (bot-authored thread, system events)', () => {
    expect(explain(spec, comment('@the-intern-bot x', { on: 'review_thread' })).matched).toBe(true);
    expect(explain(spec, comment('sounds good, go ahead')).matched).toBe(false);
    const r = explain(spec, comment('sounds good, go ahead backend=codex', { implicit: true }));
    expect(r.matched).toBe(true);
    expect(r.text).toBe('sounds good, go ahead backend=codex');
    expect(r.backend).toBe('claude');
    expect(explain(spec, comment('backend=codex go', { implicit: true })).backend).toBe('codex');
  });

  it('grants the specage data repo only when specage=true (access `when`)', () => {
    expect(explain(spec, comment('@the-intern-bot fix')).access).toEqual([{ repo: 'TheDeepestSpace/the-intern', scope: 'read/write' }]);
    expect(explain(spec, comment('@the-intern-bot specage=true implement')).access).toEqual([
      { repo: 'TheDeepestSpace/the-intern', scope: 'read/write' },
      { repo: 'TheDeepestSpace/specage-data', scope: 'read' },
    ]);
    expect(explain(spec, comment('@the-intern-bot specage=yes implement')).access).toHaveLength(1);
    expect(errs(`  a:\n    trigger: {comment: {params: {x: string}}}\n    access: {repos: [{name: data, scope: read, when: $trigger.comment.param.x}]}\n    prompt: hi\n`).join()).toMatch(/boolean param/);
    expect(errs(`  a:\n    trigger: {comment: {params: {x: boolean}}}\n    access: {repos: [{name: data, scope: read, when: $trigger.comment.param.x}]}\n    prompt: hi\n`)).toEqual([]);
  });

  it('takes backend/model/effort from anywhere in a telegram message and strips them', () => {
    const r = explain(spec, { kind: 'telegram', chat_id: 1, message_id: 2, body: 'please model=opus do it effort=high' });
    expect(r).toMatchObject({ backend: 'claude', model: 'opus', effort: 'high', timeout_seconds: 2700, text: 'please do it' });
  });

  it('resolves prompt files and validates prompt_file.ref vars', () => {
    const r = explain(spec, { kind: 'commit', repo: 'TheDeepestSpace/specage-data', branch: 'specages/specage/spec', author: 'specage-app[bot]', sha: 'abc' });
    expect(r.prompt_file).toEqual({ repo: 'TheDeepestSpace/specage', ref: null, path: 'protocol/PROTOCOL.md' });
    expect(r.actions).toEqual([{ name: 'dispatch agent to implement issue', parameters: { issue_number: 'integer' }, kind: 'dispatch_agent' }]);
    const pinned = loadSpec(`${BASE}  a:\n    trigger: {commit: {repo: data, branch: x/@p, author: b}}\n    access: {repos: [{name: data, scope: read}]}\n    prompt_file: {repo: data, ref: $trigger.commit.sha, path: P.md}\n`).spec;
    const e = explain(pinned, { kind: 'commit', repo: 'Acme/data', branch: 'x/y', author: 'b', sha: 'deadbeef' });
    expect(e.prompt_file.ref).toBe('deadbeef');
    expect(e.prompt_pinned).toBe(true);
    expect(errs(`  a:\n    trigger: {commit: {repo: data, branch: x, author: b}}\n    access: {repos: [{name: data, scope: read}]}\n    prompt_file: {repo: data, ref: $trigger.commit.author, path: P.md}\n`).join()).toMatch(/not a trusted source for a ref/);
  });

  it('executes dispatch_agent actions with typed, access-checked parameters', () => {
    const match = route(spec, { kind: 'commit', repo: 'TheDeepestSpace/specage-data', branch: 'specages/specage/spec', author: 'specage-app[bot]', sha: 'abc' }).match;
    expect(resolveAction(spec, 'specage_planner', match, 'dispatch agent to implement issue', { issue_number: 12 })).toEqual({
      kind: 'dispatch_agent', agent: 'specage_implementer', parameters: { repo: 'TheDeepestSpace/specage', issue_number: 12 },
    });
    expect(() => resolveAction(spec, 'specage_planner', match, 'dispatch agent to implement issue', { issue_number: '12' })).toThrow(/integer/);
    expect(() => resolveAction(spec, 'specage_planner', match, 'dispatch agent to implement issue', { issue_number: 1, x: 2 })).toThrow(/unknown parameter/);
    expect(() => resolveAction(spec, 'specage_planner', match, 'nope', {})).toThrow(/no action 'nope'/);
    expect(() => resolveAction(spec, 'specage_reviewer', match, 'dispatch agent to implement issue', {})).toThrow(/no action/);
  });

  it('normalizes GitHub webhook payloads consistently for the worker and the workflows', () => {
    const bot = 'the-intern-bot[bot]';
    const ic = eventFromWebhook(spec, 'issue_comment', {
      repository: { full_name: 'A/b' }, comment: { user: { login: 'alice' }, body: 'hi' }, issue: { number: 4, user: { login: bot }, pull_request: {} },
    });
    expect(ic).toMatchObject({ kind: 'comment', repo: 'A/b', author: 'alice', on: 'pr', issue_number: 4, body: 'hi', implicit: true });
    expect(eventFromWebhook(spec, 'issue_comment', { comment: { user: { login: bot }, body: 'x' }, issue: { number: 4, user: { login: bot } } }).implicit).toBe(false);
    expect(eventFromWebhook(spec, 'pull_request_review_comment', {
      repository: { full_name: 'A/b' }, comment: { id: 9, user: { login: 'a' }, body: 'x' }, pull_request: { number: 2, user: { login: 'z' } },
    })).toMatchObject({ on: 'review_thread', comment_id: 9, issue_number: 2, implicit: false });
    expect(eventFromWebhook(spec, 'push', {
      ref: 'refs/heads/specages/p/spec', after: 'abc', sender: { login: 's' }, repository: { full_name: 'A/d' },
      head_commit: { message: 'm' }, commits: [{ added: ['x'], modified: ['y'] }, { removed: ['x'] }],
    })).toEqual({ kind: 'commit', repo: 'A/d', author: 's', branch: 'specages/p/spec', sha: 'abc', deleted: false, message: 'm', paths: ['x', 'y'] });
    expect(eventFromWebhook(spec, 'push', { ref: 'refs/tags/v1' })).toBeNull();
    expect(eventFromWebhook(spec, 'push', { ref: 'refs/heads/b', after: '0'.repeat(40), deleted: true }).deleted).toBe(true);
    expect(eventFromWebhook(spec, 'star', {})).toBeNull();
    expect(eventFromTelegram({ chat: { id: 1 }, message_id: 2, caption: 'c' })).toEqual({ kind: 'telegram', chat_id: 1, message_id: 2, body: 'c' });
  });
});
