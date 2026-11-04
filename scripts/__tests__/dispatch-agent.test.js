import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSpecFile, loadSpec, explain, eventFromDispatch } from '../lib/agentic-yaml.js';
import { main } from '../resolve-agent.js';
import { sendCallback, statusFrom, findPr } from '../send-callback.js';

const spec = loadSpecFile();
const PROJECT = 'TheDeepestSpace/some-project';
const CALLER = 'specage-app[bot]';
const base = {
  prompt: 'TheDeepestSpace/specage:prompts/implement.md@main',
  repo: PROJECT, issue: 12, backend: 'claude', model: 'claude-fable-5-1',
  access: [{ repo: 'TheDeepestSpace/specage-data', scope: 'read/write' }],
  callback: { repo: 'TheDeepestSpace/specage', workflow: 'callback.yml' },
  context: { project: 'p', spec_ids: ['S1'] }, attempt: 1, max_attempts: 3,
};
const go = (over = {}, actor = CALLER) => explain(spec, eventFromDispatch(actor, JSON.stringify({ ...base, ...over })));

describe('dispatch_agent allowlist', () => {
  it('resolves an allowlisted request into scope, settings and dispatch info', () => {
    const r = go();
    expect(r).toMatchObject({ matched: true, agent: 'dispatched', backend: 'claude', model: 'claude-fable-5-1', issue_number: 12, repo: PROJECT });
    expect(r.access).toEqual([
      { repo: PROJECT, scope: 'read/write' },
      { repo: 'TheDeepestSpace/specage-data', scope: 'read/write' },
    ]);
    expect(r.params).toEqual({ backend: 'claude' });
    expect(r.dispatch).toMatchObject({
      caller: CALLER, pr: null, issue: 12, prompt_source: { repo: 'TheDeepestSpace/specage', path: 'prompts/implement.md', ref: 'main' },
      callback: { repo: 'TheDeepestSpace/specage', workflow: 'callback.yml' },
      context: { project: 'p', spec_ids: ['S1'], attempt: 1, max_attempts: 3 },
    });
  });

  it('uses pr as the issue/PR number so the run amends that PR', () => {
    const r = go({ issue: undefined, pr: 40, attempt: 2 });
    expect(r).toMatchObject({ matched: true, issue_number: 40 });
    expect(r.dispatch).toMatchObject({ pr: 40, issue: null, attempt: 2 });
  });

  it.each([
    ['an unknown caller', {}, 'someone-else', /not in dispatch.callers/],
    ['the bot itself (loop avoidance)', {}, 'the-intern-bot[bot]', /loop avoidance/],
    ['a repo owner outside the allowlist', { repo: 'evil/x' }, CALLER, /not allowlisted/],
    ['extra access above the allowed scope', { access: [{ repo: 'TheDeepestSpace/specage', scope: 'read/write' }] }, CALLER, /not allowed/],
    ['extra access to an unlisted repo', { access: [{ repo: 'TheDeepestSpace/the-intern', scope: 'read' }] }, CALLER, /not allowed/],
    ['a callback outside the allowlist', { callback: { repo: 'TheDeepestSpace/specage', workflow: 'evil.yml' } }, CALLER, /callback .* not allowed/],
    ['a prompt path outside the allowlist', { prompt: 'TheDeepestSpace/specage:secrets/x.md@main' }, CALLER, /prompt source .* not allowed/],
    ['a prompt ref outside the allowlist', { prompt: 'TheDeepestSpace/specage:prompts/a.md@evil-branch' }, CALLER, /prompt source .* not allowed/],
    ['a prompt repo outside the allowlist', { prompt: 'TheDeepestSpace/other:prompts/a.md@main' }, CALLER, /prompt source .* not allowed/],
    ['a traversing prompt path', { prompt: 'TheDeepestSpace/specage:prompts/../x.md@main' }, CALLER, /safe relative/],
    ['an inline prompt when not permitted', { prompt: 'just do it' }, CALLER, /inline prompts are not allowed/],
    ['attempt > max_attempts', { attempt: 4, max_attempts: 3 }, CALLER, /attempt 4 exceeds max_attempts 3/],
    ['max_attempts above the cap', { max_attempts: 99 }, CALLER, /exceeds the cap/],
    ['a missing issue/pr', { issue: undefined }, CALLER, /issue or pr is required/],
    ['an unknown field', { sudo: true }, CALLER, /unknown field/],
    ['a bad backend', { backend: 'gpt' }, CALLER, /invalid backend/],
  ])('rejects %s', (_name, over, actor, re) => {
    const r = go(over, actor);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(re);
  });

  it('allows inline prompts only for callers with inline_prompt: true', () => {
    const text = fs.readFileSync(new URL('../../agentic.yaml', import.meta.url), 'utf8').replace('inline_prompt: false', 'inline_prompt: true');
    const s = loadSpec(text).spec;
    const r = explain(s, eventFromDispatch(CALLER, JSON.stringify({ ...base, prompt: 'fix the thing' })));
    expect(r).toMatchObject({ matched: true, text: 'fix the thing' });
    expect(r.dispatch.prompt_source).toBeNull();
  });

  it('rejects malformed input and validates the allowlist itself', () => {
    expect(() => eventFromDispatch(CALLER, 'not json')).toThrow(/not valid JSON/);
    expect(() => eventFromDispatch(CALLER, '[1]')).toThrow(/JSON object/);
    const text = fs.readFileSync(new URL('../../agentic.yaml', import.meta.url), 'utf8');
    const bad = loadSpec(text.replace("repos: ['TheDeepestSpace/*']", 'repos: []')).errors.join('\n');
    expect(bad).toMatch(/dispatch.callers.*repos: non-empty list required/);
    expect(loadSpec(text.replace('workflow: callback.yml', 'workflow: ../x')).errors.join('\n')).toMatch(/workflow file name/);
  });
});

describe('resolve-agent (workflow_dispatch with dispatch input)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (input, actor = CALLER) => {
    const env = {
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR: actor, INPUT_DISPATCH: JSON.stringify(input),
      GITHUB_OUTPUT: path.join(dir, 'out.txt'), CLEAN_PROMPT_FILE: path.join(dir, 'clean.txt'), AGENT_FILE: path.join(dir, 'agent.json'),
    };
    const log = console.log;
    console.log = () => {};
    try {
      return { outputs: main(env), agent: JSON.parse(fs.readFileSync(env.AGENT_FILE, 'utf8')), out: fs.readFileSync(env.GITHUB_OUTPUT, 'utf8') };
    } finally {
      console.log = log;
    }
  };

  it('routes to the dispatched agent and exposes prompt source, callback and access outputs', () => {
    const { outputs, agent, out } = run(base);
    expect(outputs).toMatchObject({
      agent: 'dispatched', target_repo: PROJECT, issue_number: '12', backend: 'claude', backend_explicit: 'true', model: 'claude-fable-5-1',
      prompt_repo: 'TheDeepestSpace/specage', prompt_ref: 'main', prompt_path: 'prompts/implement.md', callback_repo: 'TheDeepestSpace/specage',
    });
    expect(agent.dispatch.context).toMatchObject({ attempt: 1, max_attempts: 3, project: 'p' });
    expect(agent.prompt).toMatch(/^You are @the-intern-bot working on repository TheDeepestSpace\/some-project, issue\/PR #12\./);
    // Context is opaque caller data: it goes to agent.json only, never $GITHUB_OUTPUT.
    expect(out).not.toContain('spec_ids');
  });

  it('refuses (non-zero exit path) when attempt > max_attempts or the caller is unknown', () => {
    expect(() => run({ ...base, attempt: 4 })).toThrow(/attempt 4 exceeds max_attempts 3/);
    expect(() => run(base, 'mallory')).toThrow(/not in dispatch.callers/);
  });
});

describe('send-callback', () => {
  const agentFile = (dispatch) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-callback-'));
    const file = path.join(dir, 'agent.json');
    fs.writeFileSync(file, JSON.stringify({ bot_login: 'the-intern-bot[bot]', dispatch }));
    return file;
  };
  const dispatch = {
    repo: PROJECT, issue: 12, pr: null, callback: { repo: 'TheDeepestSpace/specage', workflow: 'callback.yml' },
    context: { project: 'p', attempt: 1, max_attempts: 3 },
  };
  let calls;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 204, json: async () => ({ default_branch: 'main' }), text: async () => '' };
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; });
  const mint = async () => 'tok';
  const env = (file, result) => ({ AGENT_FILE: file, RUN_RESULT: result, RUN_URL: 'https://run', APP_ID: '1', APP_PRIVATE_KEY: 'k' });

  it('maps job results to success|failure|cancelled', () => {
    expect(['success', 'failure', 'cancelled', 'skipped', ''].map(statusFrom)).toEqual(['success', 'failure', 'cancelled', 'failure', 'failure']);
  });

  it.each(['success', 'failure', 'cancelled'])('dispatches the callback workflow with string inputs on %s', async (result) => {
    const pr = { number: 40, head: { ref: 'fix/x', sha: 'a'.repeat(40) } };
    const inputs = await sendCallback(env(agentFile(dispatch), result), { mint, findPrFn: async () => pr });
    expect(inputs).toEqual({
      status: result, run_url: 'https://run', pr: '40', issue: '12', branch: 'fix/x', head_sha: 'a'.repeat(40),
      context: JSON.stringify(dispatch.context),
    });
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post.url).toBe('https://api.github.com/repos/TheDeepestSpace/specage/actions/workflows/callback.yml/dispatches');
    expect(JSON.parse(post.init.body)).toEqual({ ref: 'main', inputs });
    expect(Object.values(inputs).every((v) => typeof v === 'string')).toBe(true);
  });

  it('still sends the callback (without a PR) when the PR lookup fails, and does nothing without a callback', async () => {
    const inputs = await sendCallback(env(agentFile(dispatch), 'failure'), { mint, findPrFn: async () => { throw new Error('boom'); } });
    expect(inputs).toMatchObject({ status: 'failure', pr: '', branch: '', head_sha: '' });
    calls.length = 0;
    expect(await sendCallback(env(agentFile({ ...dispatch, callback: null }), 'success'), { mint })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('finds the bot PR that references the issue, or the given pr', async () => {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => (url.includes('/pulls/7') ? { number: 7 } : [
        { number: 3, user: { login: 'other' }, title: 'x', body: 'Closes #12' },
        { number: 2, user: { login: 'the-intern-bot[bot]' }, title: 'y', body: 'Closes #123' },
        { number: 1, user: { login: 'the-intern-bot[bot]' }, title: 'z', body: 'Fixes #12' },
      ]),
    });
    expect((await findPr({ repo: PROJECT, issue: 12, botLogin: 'the-intern-bot[bot]' }, 't')).number).toBe(1);
    expect((await findPr({ repo: PROJECT, pr: 7 }, 't')).number).toBe(7);
  });
});
