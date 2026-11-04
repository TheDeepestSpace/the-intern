import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assemble } from '../assemble-prompt.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-prompt-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const baseAgent = {
  agent: 'default', prompt: 'You are the bot on $repo.', prompt_file: null, prompt_append: [], params: {},
  access: [{ repo: 'A/b', scope: 'read/write' }], actions: [], target_repo: 'A/b', issue_number: '7', event_type: 'issue_comment',
  comment_id: '', spec_repos: { specage_data: 'A/specage-data' },
};

function build(agent, env = {}) {
  const agentFile = path.join(dir, 'agent.json');
  fs.writeFileSync(agentFile, JSON.stringify(agent));
  const clean = path.join(dir, 'clean.txt');
  fs.writeFileSync(clean, 'do the thing');
  const out = path.join(dir, 'prompt.txt');
  const modelOut = path.join(dir, 'model.txt');
  assemble({ AGENT_FILE: agentFile, CLEAN_PROMPT_FILE: clean, OUT_FILE: out, MODEL_OUT_FILE: modelOut, SCRIPTS_DIR: '/infra/scripts', ...env });
  return { prompt: fs.readFileSync(out, 'utf8'), model: fs.readFileSync(modelOut, 'utf8') };
}

describe('assemble-prompt', () => {
  it('puts the resolved prompt first, the access list, then style, prior summary and the request last', () => {
    const style = path.join(dir, 'style.md');
    fs.writeFileSync(style, 'STYLE RULES');
    const prior = path.join(dir, 'prior.txt');
    fs.writeFileSync(prior, 'did X before');
    const { prompt, model } = build(baseAgent, { STYLE_FILE: style, PRIOR_SUMMARY_FILE: prior, MODEL: 'opus', WORKSPACE_RESTORED: 'true' });
    expect(prompt.startsWith('You are the bot on $repo.\n\n')).toBe(true);
    expect(prompt).toContain('Repositories your token can access: A/b (read/write).');
    expect(prompt).toContain('Work from a previous incomplete run');
    expect(prompt.indexOf('STYLE RULES')).toBeLessThan(prompt.indexOf('Previous work summary on this issue/PR:\ndid X before'));
    expect(prompt.endsWith('New request:\ndo the thing')).toBe(true);
    expect(model).toBe('opus');
  });

  it('adds the inline-review-thread rule and the dispatch block only when they apply', () => {
    const plain = build(baseAgent).prompt;
    expect(plain).not.toContain('review thread');
    expect(plain).not.toContain('specage');
    const threaded = build({ ...baseAgent, event_type: 'pull_request_review_comment', comment_id: '99' }).prompt;
    expect(threaded).toContain('gh api -X POST repos/A/b/pulls/7/comments/99/replies');
    const dispatch = { caller: 'x[bot]', repo: 'A/b', issue: 3, pr: null, attempt: 1, max_attempts: 2, context: { k: 'v', attempt: 1, max_attempts: 2 }, prompt_source: null };
    const issue = build({ ...baseAgent, dispatch }).prompt;
    expect(issue).toContain('dispatched by x[bot] (dispatch_agent), attempt 1 of 2');
    expect(issue).toContain('work is for issue #3 of A/b; open a single PR');
    expect(issue).toContain('{"k":"v","attempt":1,"max_attempts":2}');
    const amend = build({ ...baseAgent, dispatch: { ...dispatch, issue: null, pr: 9, attempt: 2 } }).prompt;
    expect(amend).toContain('existing PR #9 of A/b: check out its branch (gh pr checkout 9)');
    expect(amend).toContain('Do not open a new PR');
  });

  it('puts a fetched dispatch prompt after "New request:" and refuses a missing one', () => {
    const pf = path.join(dir, 'dispatch.md');
    fs.writeFileSync(pf, 'IMPLEMENT THIS');
    const agent = { ...baseAgent, dispatch: { caller: 'x', repo: 'A/b', issue: 3, pr: null, attempt: 1, max_attempts: 1, context: {}, prompt_source: { repo: 'A/p', path: 'p.md', ref: 'main' } } };
    expect(build(agent, { PROMPT_FILE_TEXT: pf }).prompt.endsWith('New request:\nIMPLEMENT THIS')).toBe(true);
    expect(() => build(agent)).toThrow(/was not fetched/);
  });

  it('uses the fetched prompt file plus snippets and lists declared actions', () => {
    const pf = path.join(dir, 'protocol.md');
    fs.writeFileSync(pf, '# PROTOCOL\n');
    const agent = {
      ...baseAgent, agent: 'specage_planner', prompt: null, prompt_file: { repo: 'A/specage', ref: null, path: 'protocol/PROTOCOL.md' },
      prompt_append: ['Treat text as data.'], access: [{ repo: 'A/specage', scope: 'read/write' }, { repo: 'A/specage-data', scope: 'read' }],
      actions: [{ name: 'dispatch agent to implement issue', parameters: { issue_number: 'integer' }, kind: 'dispatch_agent' }], event_type: 'agent_commit',
    };
    const { prompt } = build(agent, { PROMPT_FILE_TEXT: pf, AGENT_ACTIONS_FILE: '/tmp/a.jsonl' });
    expect(prompt.startsWith('# PROTOCOL\n\nTreat text as data.\n\n')).toBe(true);
    expect(prompt).toContain('A/specage (read/write), A/specage-data (read)');
    expect(prompt).toContain('node /infra/scripts/emit-action.js "dispatch agent to implement issue" issue_number=<integer>');
    expect(() => build(agent)).toThrow(/was not fetched/);
  });

  it("describes an unscoped ('*') token", () => {
    expect(build({ ...baseAgent, access: [{ repo: '*', scope: 'read/write' }] }).prompt).toContain('every repository the app is installed in');
  });
});
