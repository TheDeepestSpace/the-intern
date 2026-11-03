import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { fetchPromptFile, main } from '../fetch-prompt-file.js';

const SHA = 'a'.repeat(40);
let originalDispatcher;
let agent;
beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(() => setGlobalDispatcher(originalDispatcher));

describe('fetch-prompt-file', () => {
  it('resolves the default branch to a commit sha and fetches the file at that sha', async () => {
    const c = agent.get('https://api.github.com');
    c.intercept({ method: 'GET', path: '/repos/A/specage' }).reply(200, { default_branch: 'main' });
    c.intercept({ method: 'GET', path: '/repos/A/specage/commits/main' }).reply(200, { sha: SHA });
    c.intercept({ method: 'GET', path: `/repos/A/specage/contents/protocol/PROTOCOL.md?ref=${SHA}` }).reply(200, '# protocol');
    const r = await fetchPromptFile({ repo: 'A/specage', path: 'protocol/PROTOCOL.md', ref: '', token: 't' });
    expect(r).toEqual({ text: '# protocol', sha: SHA, ref: 'main' });
  });

  it('pins to the given ref, writes OUT_FILE and the prompt_sha output', async () => {
    const c = agent.get('https://api.github.com');
    c.intercept({ method: 'GET', path: '/repos/A/d/commits/specages%2Fp%2Fspec' }).reply(200, { sha: SHA });
    c.intercept({ method: 'GET', path: `/repos/A/d/contents/.specage/PROTOCOL.md?ref=${SHA}` }).reply(200, 'text');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-file-'));
    const out = path.join(dir, 'p.txt');
    const ghOut = path.join(dir, 'out');
    const log = console.log;
    console.log = () => {};
    try {
      await main({ PROMPT_REPO: 'A/d', PROMPT_PATH: '.specage/PROTOCOL.md', PROMPT_REF: 'specages/p/spec', GH_TOKEN: 't', OUT_FILE: out, GITHUB_OUTPUT: ghOut });
    } finally {
      console.log = log;
    }
    expect(fs.readFileSync(out, 'utf8')).toBe('text');
    expect(fs.readFileSync(ghOut, 'utf8')).toBe(`prompt_sha=${SHA}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails on a missing file, an empty file or bad inputs', async () => {
    const c = agent.get('https://api.github.com');
    c.intercept({ method: 'GET', path: '/repos/A/d/commits/main' }).reply(200, { sha: SHA }).times(2);
    c.intercept({ method: 'GET', path: `/repos/A/d/contents/x.md?ref=${SHA}` }).reply(404, 'nope');
    await expect(fetchPromptFile({ repo: 'A/d', path: 'x.md', ref: 'main', token: 't' })).rejects.toThrow(/404/);
    c.intercept({ method: 'GET', path: `/repos/A/d/contents/x.md?ref=${SHA}` }).reply(200, '  ');
    await expect(fetchPromptFile({ repo: 'A/d', path: 'x.md', ref: 'main', token: 't' })).rejects.toThrow(/empty/);
    await expect(fetchPromptFile({ repo: 'bad', path: 'x.md', ref: 'main', token: 't' })).rejects.toThrow(/owner\/repo/);
    await expect(fetchPromptFile({ repo: 'A/d', path: '../x.md', ref: 'main', token: 't' })).rejects.toThrow(/relative/);
    await expect(fetchPromptFile({ repo: 'A/d', path: 'x.md', ref: 'main', token: '' })).rejects.toThrow(/GH_TOKEN/);
  });
});
