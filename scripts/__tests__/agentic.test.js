import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadSpec, explain, accessAllows, route, branchPattern } from '../lib/agentic.js';
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
