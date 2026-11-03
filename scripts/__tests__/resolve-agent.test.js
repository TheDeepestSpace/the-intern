import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { main, resolve } from '../resolve-agent.js';

// Parity tests, one per trigger type (issue #273): the same events the worker
// forwards (or a workflow_dispatch) resolve to the same agent, scope, settings
// and request text the pre-agentic.yaml scripts produced.
const INTERN = 'TheDeepestSpace/the-intern';
const DATA = 'TheDeepestSpace/specage-data';
const SPECAGE = 'TheDeepestSpace/specage';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-agent-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(eventName, event, extra = {}) {
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(event));
  const env = {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: path.join(dir, 'out.txt'),
    CLEAN_PROMPT_FILE: path.join(dir, 'clean_prompt.txt'),
    AGENT_FILE: path.join(dir, 'agent.json'),
    ...extra,
  };
  const log = console.log;
  console.log = () => {};
  try {
    const outputs = main(env);
    return {
      outputs,
      text: fs.readFileSync(env.CLEAN_PROMPT_FILE, 'utf8'),
      agent: JSON.parse(fs.readFileSync(env.AGENT_FILE, 'utf8')),
      githubOutput: fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    };
  } finally {
    console.log = log;
  }
}

const dispatch = (type, client_payload) => ({ action: type, client_payload });

describe('comment trigger (issue_comment)', () => {
  it('resolves the default agent, params, scope and request text', () => {
    const { outputs, text, agent, githubOutput } = run('repository_dispatch', dispatch('issue_comment', {
      agent: 'default',
      raw: {
        installation: { id: 4242 },
        repository: { full_name: INTERN },
        issue: { number: 7, user: { login: 'bob' } },
        comment: { user: { login: 'alice' }, body: '@the-intern-bot backend=codex model=gpt-x please help' },
      },
    }));
    expect(outputs).toMatchObject({
      agent: 'default', target_repo: INTERN, issue_number: '7', installation_id: '4242', backend: 'codex',
      backend_explicit: 'true', model: 'gpt-x', effort: 'default', timeout_minutes: 60, event_type: 'issue_comment',
      comment_id: '', specage: 'false', prompt_repo: '', actions_count: 0,
    });
    expect(JSON.parse(outputs.access)).toEqual([{ repo: INTERN, scope: 'read/write' }]);
    expect(text).toBe('please help');
    expect(agent.prompt).toMatch(/^You are @the-intern-bot working on repository TheDeepestSpace\/the-intern, issue\/PR #7\./);
    // Untrusted text never reaches $GITHUB_OUTPUT.
    expect(githubOutput).not.toContain('please help');
  });

  it('widens access to the data repo for specage=true and falls back to the default request', () => {
    const { outputs, text } = run('repository_dispatch', dispatch('issue_comment', {
      raw: { repository: { full_name: INTERN }, issue: { number: 1, user: { login: 'b' } }, comment: { user: { login: 'a' }, body: '@the-intern-bot specage=true' } },
    }));
    expect(outputs.specage).toBe('true');
    expect(JSON.parse(outputs.access)).toEqual([{ repo: INTERN, scope: 'read/write' }, { repo: DATA, scope: 'read' }]);
    expect(text).toBe('Please inspect the context and assist with this issue or pull request.');
  });

  it('treats a reply on a bot-authored thread as an implicit request', () => {
    const { outputs, text } = run('repository_dispatch', dispatch('issue_comment', {
      raw: { repository: { full_name: INTERN }, issue: { number: 1, user: { login: 'the-intern-bot[bot]' } }, comment: { user: { login: 'a' }, body: 'go ahead' } },
    }));
    expect(outputs.agent).toBe('default');
    expect(outputs.backend_explicit).toBe('false');
    expect(text).toBe('go ahead');
  });

  it('fails closed when nothing matches, the agent disagrees with the worker, or the owner is not allowlisted', () => {
    const base = { repository: { full_name: INTERN }, issue: { number: 1, user: { login: 'b' } } };
    expect(() => run('repository_dispatch', dispatch('issue_comment', { raw: { ...base, comment: { user: { login: 'a' }, body: 'no mention' } } }))).toThrow(/no agent trigger/);
    expect(() => run('repository_dispatch', dispatch('issue_comment', { agent: 'telegram', raw: { ...base, comment: { user: { login: 'a' }, body: '@the-intern-bot x' } } }))).toThrow(/routes this event to 'default'/);
    expect(() => run('repository_dispatch', dispatch('issue_comment', { raw: { ...base, repository: { full_name: 'evil/x' }, comment: { user: { login: 'a' }, body: '@the-intern-bot x' } } }))).toThrow(/not allowlisted/);
  });

  it('fails closed when agentic.yaml is missing or invalid', () => {
    const bad = path.join(dir, 'bad.yaml');
    fs.writeFileSync(bad, 'version: 2\n');
    const ev = dispatch('issue_comment', { raw: { repository: { full_name: INTERN }, issue: { number: 1, user: { login: 'b' } }, comment: { user: { login: 'a' }, body: '@the-intern-bot x' } } });
    expect(() => run('repository_dispatch', ev, { AGENTIC_FILE: bad })).toThrow(/invalid/);
    expect(() => run('repository_dispatch', ev, { AGENTIC_FILE: path.join(dir, 'missing.yaml') })).toThrow(/missing/);
  });
});

describe('comment trigger (review comment, system events, workflow_dispatch)', () => {
  it('keeps the inline review thread comment id and event type', () => {
    const { outputs } = run('repository_dispatch', dispatch('pull_request_review_comment', {
      raw: { repository: { full_name: INTERN }, pull_request: { number: 3, user: { login: 'z' } }, comment: { id: 555, user: { login: 'a' }, body: '@the-intern-bot agy address this', pull_request_review_id: 1 } },
    }));
    expect(outputs).toMatchObject({ agent: 'default', issue_number: '3', comment_id: '555', event_type: 'pull_request_review_comment', backend: 'agy' });
  });

  it('routes a synthesized ci_failure to the default agent with the synthesized text', () => {
    const { outputs, text } = run('repository_dispatch', dispatch('ci_failure', {
      raw: {
        installation: { id: 1 }, repository: { full_name: INTERN }, pull_request: { number: 9 },
        check_suite: { conclusion: 'failure', html_url: 'https://x/checks', head_sha: 'deadbeef' },
      },
    }));
    expect(outputs).toMatchObject({ agent: 'default', target_repo: INTERN, issue_number: '9', event_type: 'ci_failure', backend: 'claude' });
    expect(text).toMatch(/^CI is failing on this PR \(conclusion: failure\)/);
    expect(text).toContain('deadbeef');
  });

  it('routes legacy workflow_dispatch inputs (incl. queued retries) to the default agent', () => {
    const { outputs, text } = run('workflow_dispatch', { inputs: {} }, {
      INPUT_TARGET_REPO: INTERN, INPUT_PR_NUMBER: '55', INPUT_COMMENT_BODY: 'specage=true Review specage PR x#55', INPUT_INSTALLATION_ID: '777',
    });
    expect(outputs).toMatchObject({ agent: 'default', target_repo: INTERN, issue_number: '55', installation_id: '777', specage: 'true', event_type: 'workflow_dispatch' });
    expect(text).toBe('Review specage PR x#55');
  });
});

describe('manual trigger (workflow_dispatch with agent + parameters)', () => {
  it('resolves the implementer with typed parameters and its own scope', () => {
    const { outputs, text, agent } = run('workflow_dispatch', { inputs: { agent: 'specage_implementer', parameters: JSON.stringify({ repo: SPECAGE, issue_number: 12 }) } });
    expect(outputs).toMatchObject({ agent: 'specage_implementer', target_repo: SPECAGE, issue_number: '12', event_type: 'manual', backend: 'claude' });
    expect(JSON.parse(outputs.access)).toEqual([{ repo: SPECAGE, scope: 'read/write' }, { repo: DATA, scope: 'read' }]);
    expect(agent.prompt).toBe('Implement TheDeepestSpace/specage#12 following the spec in the specage data repo.');
    expect(text).toContain('specage_implementer');
    expect(text).toContain('issue_number=12');
  });

  it('rejects mistyped parameters, unknown agents and bad JSON', () => {
    expect(() => run('workflow_dispatch', { inputs: { agent: 'specage_implementer', parameters: '{"repo":"TheDeepestSpace/specage","issue_number":"12"}' } })).toThrow(/integer/);
    expect(() => run('workflow_dispatch', { inputs: { agent: 'ghost', parameters: '{}' } })).toThrow(/no agent trigger/);
    expect(() => run('workflow_dispatch', { inputs: { agent: 'specage_implementer', parameters: '{nope' } })).toThrow(/valid JSON/);
  });
});

describe('commit trigger (agent_commit)', () => {
  const push = (over = {}) => dispatch('agent_commit', {
    agent: 'specage_planner', repo: DATA, branch: 'specages/specage/spec', sha: 'abc123', author: 'specage-app[bot]',
    message: 'spec: add node', paths: ['spec.specage'], installation_id: '42', ...over,
  });

  it('resolves the planner: project from the branch capture, prompt file, actions and a request naming the push', () => {
    const { outputs, text, agent } = run('repository_dispatch', push());
    expect(outputs).toMatchObject({
      agent: 'specage_planner', target_repo: DATA, issue_number: '', installation_id: '42', event_type: 'agent_commit',
      prompt_repo: SPECAGE, prompt_ref: '', prompt_path: 'protocol/PROTOCOL.md', actions_count: 1,
    });
    expect(JSON.parse(outputs.access)).toEqual([{ repo: SPECAGE, scope: 'read/write' }, { repo: DATA, scope: 'read' }]);
    expect(text).toBe(`Commit abc123 was pushed to branch specages/specage/spec of ${DATA} by specage-app[bot].\nBranch captures: project=specage.\n\nCommit message:\nspec: add node`);
    expect(agent.match.values.matcher).toEqual({ project: 'specage' });
  });

  it('resolves the reviewer (read-only scope) from a review-branch push by the bot', () => {
    const { outputs } = run('repository_dispatch', push({ agent: 'specage_reviewer', branch: 'specages/specage/review', author: 'the-intern-bot[bot]', message: `review ${SPECAGE}#12` }));
    expect(outputs.agent).toBe('specage_reviewer');
    expect(JSON.parse(outputs.access)).toEqual([{ repo: SPECAGE, scope: 'read' }, { repo: DATA, scope: 'read' }]);
  });

  it('fails closed on an undeclared project, a wrong author, or a worker/workflow agent mismatch', () => {
    expect(() => run('repository_dispatch', push({ branch: 'specages/unknown/spec' }))).toThrow(/access:/);
    expect(() => run('repository_dispatch', push({ author: 'mallory' }))).toThrow(/no agent trigger/);
    expect(() => run('repository_dispatch', push({ agent: 'specage_reviewer' }))).toThrow(/routes this event to 'specage_planner'/);
  });
});

describe('telegram trigger (telegram_message)', () => {
  it('resolves the telegram agent: unscoped access, 45m timeout, params from anywhere in the text', () => {
    const { outputs, text } = run('repository_dispatch', dispatch('telegram_message', { agent: 'telegram', text: 'backend=codex fix the parser bug model=sol', chat_id: 777, message_id: 101 }));
    expect(outputs).toMatchObject({ agent: 'telegram', target_repo: '', issue_number: '', backend: 'codex', model: 'sol', timeout_minutes: 45, prompt_repo: INTERN, prompt_path: 'instructions/telegram.md' });
    expect(JSON.parse(outputs.access)).toEqual([{ repo: '*', scope: 'read/write' }]);
    expect(text).toBe('fix the parser bug');
  });

  it('handles a queued retry payload without an agent name and empty text', () => {
    const { outputs, text } = run('repository_dispatch', dispatch('telegram_message', { chat_id: 1, message_id: 2 }));
    expect(outputs.agent).toBe('telegram');
    expect(text).toBe('');
  });
});

describe('resolve()', () => {
  it('rejects unsupported events', () => {
    expect(() => resolve({ GITHUB_EVENT_NAME: 'push' })).toThrow(/unsupported event/);
  });
});
