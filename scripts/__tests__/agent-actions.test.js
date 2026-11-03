import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { emit } from '../emit-action.js';
import { execute, readQueued, coerce } from '../execute-actions.js';
import { loadSpecFile, route } from '../lib/agentic-yaml.js';

let dir;
let originalDispatcher;
let agent;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-actions-'));
  originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function plannerAgentFile() {
  const spec = loadSpecFile();
  const hit = route(spec, { kind: 'commit', repo: 'TheDeepestSpace/specage-data', branch: 'specages/specage/spec', author: 'specage-app[bot]', sha: 'abc' });
  const file = path.join(dir, 'agent.json');
  fs.writeFileSync(file, JSON.stringify({ agent: hit.name, match: hit.match, spec }));
  return file;
}

describe('emit-action', () => {
  it('appends one JSON line per call, keeping values as strings', () => {
    const file = path.join(dir, 'actions.jsonl');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emit(['dispatch agent to implement issue', 'issue_number=12'], { AGENT_ACTIONS_FILE: file });
    emit(['dispatch agent to implement issue', 'issue_number=13'], { AGENT_ACTIONS_FILE: file });
    log.mockRestore();
    expect(readQueued(file)).toEqual([
      { name: 'dispatch agent to implement issue', parameters: { issue_number: '12' } },
      { name: 'dispatch agent to implement issue', parameters: { issue_number: '13' } },
    ]);
    expect(() => emit([], {})).toThrow(/usage/);
    expect(() => emit(['x', 'bad'], {})).toThrow(/key=value/);
  });

  it('coerces by declared type and reports unparsable lines', () => {
    expect(coerce({ n: 'integer', b: 'boolean', s: 'string' }, { n: '4', b: 'true', s: '5' })).toEqual({ n: 4, b: true, s: '5' });
    const file = path.join(dir, 'actions.jsonl');
    fs.writeFileSync(file, '{"name":"a"}\nnot json\n{"nope":1}\n');
    const q = readQueued(file);
    expect(q[0]).toEqual({ name: 'a', parameters: {} });
    expect(q[1].error).toMatch(/line 2/);
    expect(q[2].error).toMatch(/line 3/);
  });
});

describe('execute-actions', () => {
  const env = (file) => ({
    AGENT_FILE: plannerAgentFile(), AGENT_ACTIONS_FILE: file, APP_ID: '1', APP_PRIVATE_KEY: 'k',
    GITHUB_REPOSITORY: 'TheDeepestSpace/the-intern', DISPATCH_REF: 'main', WORKFLOW_FILE: 'dispatcher.yml',
  });

  it('does nothing when no actions were queued', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await execute({ AGENT_ACTIONS_FILE: path.join(dir, 'none.jsonl') });
    log.mockRestore();
    expect(r).toEqual({ dispatched: [], errors: [] });
  });

  it('dispatches a declared action as a workflow_dispatch of dispatcher.yml with typed parameters', async () => {
    const file = path.join(dir, 'actions.jsonl');
    fs.writeFileSync(file, JSON.stringify({ name: 'dispatch agent to implement issue', parameters: { issue_number: '12' } }) + '\n');
    let seenBody;
    agent.get('https://api.github.com')
      .intercept({ method: 'POST', path: '/repos/TheDeepestSpace/the-intern/actions/workflows/dispatcher.yml/dispatches', body: (b) => { seenBody = JSON.parse(b); return true; } })
      .reply(204);
    const mint = vi.fn(async (opts) => {
      expect(opts.access).toEqual([{ repo: 'TheDeepestSpace/the-intern', scope: 'read/write' }]);
      return 'tok';
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await execute(env(file), { mint });
    log.mockRestore();
    expect(r.errors).toEqual([]);
    expect(r.dispatched).toEqual([{ kind: 'dispatch_agent', agent: 'specage_implementer', parameters: { repo: 'TheDeepestSpace/specage', issue_number: 12 } }]);
    expect(seenBody).toEqual({ ref: 'main', inputs: { agent: 'specage_implementer', parameters: '{"repo":"TheDeepestSpace/specage","issue_number":12}' } });
  });

  it('rejects undeclared actions and mistyped parameters without dispatching', async () => {
    const file = path.join(dir, 'actions.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ name: 'open the vault', parameters: {} }),
      JSON.stringify({ name: 'dispatch agent to implement issue', parameters: { issue_number: 'twelve' } }),
    ].join('\n') + '\n');
    const mint = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await execute(env(file), { mint });
    err.mockRestore();
    expect(mint).not.toHaveBeenCalled();
    expect(r.dispatched).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/no action 'open the vault'/);
    expect(r.errors[1]).toMatch(/integer/);
  });
});
