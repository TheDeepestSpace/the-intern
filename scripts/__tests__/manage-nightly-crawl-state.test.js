import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readState, updateState, BRANCH_NAME, FILE_NAME } from '../manage-nightly-crawl-state.js';
import { emptyState, markConflictDispatched, applyVerdict } from '../nightly-crawl-store.js';

// Same real-git-against-scratch-repos approach as manage-pending-retries.test.js:
// the-intern-data is a local bare repo reached via DATA_REPO_REMOTE_URL.

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: process.env }).trim();
}

function initBareRemote(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init --bare -b main .', dir);
}

function initWorkRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -b main .', dir);
  sh('git config user.name "test"', dir);
  sh('git config user.email "test@example.com"', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# scratch repo\n');
  sh('git add README.md', dir);
  sh('git commit -m "initial commit"', dir);
}

const NOW = Date.parse('2026-11-01T04:30:00Z');

describe('manage-nightly-crawl-state', () => {
  let originalHome;
  let originalCwd;
  let tmpRoot;
  let fakeHome;
  let dataRemoteDir;
  let workDir;

  beforeAll(() => {
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-crawl-home-'));
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-crawl-'));
    dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(dataRemoteDir);
    process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
    workDir = path.join(tmpRoot, 'work');
    initWorkRepo(workDir);
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.DATA_REPO_REMOTE_URL;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads an empty state before the branch exists', async () => {
    expect(await readState()).toEqual(emptyState());
  });

  it('creates the branch on first write and round-trips the state', async () => {
    await updateState((state) => ({ state: markConflictDispatched(state, 'acme/widgets#1', NOW) }));
    const remoteFile = sh(`git show ${BRANCH_NAME}:${FILE_NAME}`, dataRemoteDir);
    expect(JSON.parse(remoteFile).conflicts['acme/widgets#1'].dispatchedAt).toBe(new Date(NOW).toISOString());
    expect(await readState()).toEqual(markConflictDispatched(emptyState(), 'acme/widgets#1', NOW));
  });

  it('applies a mutation on top of the remote tip and returns the rest of the result', async () => {
    await updateState((state) => ({ state: markConflictDispatched(state, 'a/b#1', NOW) }));
    const result = await updateState((state) => ({
      state: applyVerdict(state, 'a/b#2', { diffHash: 'h', headSha: 's', verdict: 'safe', classification: 'regular', now: NOW }),
      touched: 1,
    }));
    expect(result).toEqual({ touched: 1 });
    const state = await readState();
    expect(Object.keys(state.conflicts)).toEqual(['a/b#1']);
    expect(state.dependabot['a/b#2'].verdict).toBe('safe');
  });

  it('does not commit when the mutation is a no-op', async () => {
    await updateState((state) => ({ state }));
    expect(sh(`git ls-remote --heads ${dataRemoteDir}`, workDir)).toBe('');
  });

  it('builds the first orphan commit from only the state file (no workflow files)', async () => {
    fs.mkdirSync(path.join(workDir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yaml'), 'name: ci\n');
    sh('git add -A && git commit -m "add workflow"', workDir);

    await updateState((state) => ({ state: markConflictDispatched(state, 'a/b#1', NOW) }));

    const files = sh(`git ls-tree -r --name-only ${BRANCH_NAME}`, dataRemoteDir).split('\n');
    expect(files).toEqual([FILE_NAME]);
    expect(sh(`git rev-list --count ${BRANCH_NAME}`, dataRemoteDir)).toBe('1');
  });

  it('leaves the caller checkout untouched', async () => {
    await updateState((state) => ({ state: markConflictDispatched(state, 'a/b#1', NOW) }));
    expect(sh('git rev-parse --abbrev-ref HEAD', workDir)).toBe('main');
    expect(fs.existsSync(path.join(workDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, FILE_NAME))).toBe(false);
  });

  it('throws instead of overwriting a corrupt remote file', async () => {
    const scratch = path.join(tmpRoot, 'scratch');
    initWorkRepo(scratch);
    sh(`git checkout --orphan ${BRANCH_NAME}`, scratch);
    sh('git rm -rf .', scratch);
    fs.writeFileSync(path.join(scratch, FILE_NAME), '{broken');
    sh(`git add ${FILE_NAME} && git commit -m corrupt`, scratch);
    sh(`git push ${dataRemoteDir} ${BRANCH_NAME}`, scratch);

    await expect(readState()).rejects.toThrow(/not valid JSON/);
    await expect(updateState((state) => ({ state }))).rejects.toThrow(/not valid JSON/);
    expect(sh(`git show ${BRANCH_NAME}:${FILE_NAME}`, dataRemoteDir)).toBe('{broken');
  });

  it('fails clearly when no remote is configured', async () => {
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.DATA_REPO_TOKEN;
    await expect(readState()).rejects.toThrow(/not configured/);
  });
});
