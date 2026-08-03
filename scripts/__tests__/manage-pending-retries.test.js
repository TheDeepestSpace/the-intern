import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readEntries, updateEntries, buildDispatchPayload, BRANCH_NAME } from '../manage-pending-retries.js';
import { upsertStall, resolveEntry } from '../pending-retries-store.js';

// Same real-git-against-scratch-repos approach as manage-summaries.test.js —
// this module's actual failure modes (branch-not-created-yet, concurrent
// push races) only show up against a real git binary.

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: process.env }).trim();
}

function initBareRemote(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init --bare -b main .', dir);
}

function initWorkRepo(dir, remoteDir) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -b main .', dir);
  sh('git config user.name "test"', dir);
  sh('git config user.email "test@example.com"', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# scratch repo\n');
  sh('git add README.md', dir);
  sh('git commit -m "initial commit"', dir);
  sh(`git remote add origin "${remoteDir}"`, dir);
}

const DISPATCH = { type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: { target_repo: 'acme/widgets' } };

describe('manage-pending-retries', () => {
  let originalHome;
  let originalCwd;
  let tmpRoot;
  let fakeHome;
  let remoteDir;

  beforeAll(() => {
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-retries-home-'));
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-retries-'));
    remoteDir = path.join(tmpRoot, 'remote.git');
    initBareRemote(remoteDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function newWorkDir(name) {
    const dir = path.join(tmpRoot, name);
    initWorkRepo(dir, remoteDir);
    return dir;
  }

  it('readEntries returns [] when the branch does not exist yet', () => {
    process.chdir(newWorkDir('work-read-empty'));
    expect(readEntries()).toEqual([]);
  });

  it('round-trips an upserted entry through the branch', () => {
    const writer = newWorkDir('work-write');
    process.chdir(writer);
    process.env.GITHUB_TOKEN = 'fake-token-for-push';

    const { entry } = updateEntries((entries) =>
      upsertStall(entries, {
        key: 'dispatcher:acme/widgets#7',
        source: 'dispatcher',
        targetRepo: 'acme/widgets',
        issueNumber: '7',
        retryAfter: '2026-08-03T20:00:00.000Z',
        matchedText: 'usage limit reached',
        maxRetries: 3,
        dispatch: DISPATCH,
      })
    );
    expect(entry.retryCount).toBe(0);

    const reader = newWorkDir('work-read');
    process.chdir(reader);
    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('dispatcher:acme/widgets#7');
    expect(entries[0].dispatch).toEqual(DISPATCH);

    const branches = sh('git ls-remote --heads .', remoteDir);
    expect(branches).toContain(`refs/heads/${BRANCH_NAME}`);
  });

  it('resolveEntry removes a previously-queued entry', () => {
    const writer = newWorkDir('work-resolve-write');
    process.chdir(writer);
    process.env.GITHUB_TOKEN = 'fake-token-for-push';
    updateEntries((entries) =>
      upsertStall(entries, { key: 'k', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH })
    );

    const resolver = newWorkDir('work-resolve');
    process.chdir(resolver);
    const { removed } = updateEntries((entries) => resolveEntry(entries, 'k'));
    expect(removed.key).toBe('k');

    const reader = newWorkDir('work-resolve-read');
    process.chdir(reader);
    expect(readEntries()).toEqual([]);
  });

  it('does not push when resolving a key that was never queued (no-op mutation)', () => {
    const work = newWorkDir('work-noop');
    process.chdir(work);
    process.env.GITHUB_TOKEN = 'fake-token-for-push';

    const { removed } = updateEntries((entries) => resolveEntry(entries, 'never-queued'));
    expect(removed).toBeNull();

    const branches = sh('git ls-remote --heads .', remoteDir);
    expect(branches).not.toContain(BRANCH_NAME);
  });

  it('retries and succeeds when a concurrent writer already pushed first (mirrors manage-summaries #49 regression)', () => {
    const workA = newWorkDir('work-race-a');
    const workB = newWorkDir('work-race-b');

    process.chdir(workA);
    process.env.GITHUB_TOKEN = 'fake-token-for-push';
    updateEntries((entries) =>
      upsertStall(entries, { key: 'a', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH })
    );

    process.chdir(workB);
    updateEntries((entries) =>
      upsertStall(entries, { key: 'b', source: 'dispatcher', retryAfter: 'B', maxRetries: 3, dispatch: DISPATCH })
    );

    const reader = newWorkDir('work-race-read');
    process.chdir(reader);
    const entries = readEntries();
    expect(entries.map((e) => e.key).sort()).toEqual(['a', 'b']);
  });
});

describe('buildDispatchPayload', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-payload-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('builds a workflow_dispatch payload from the event file inputs', () => {
    const eventPath = path.join(tmpRoot, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ inputs: { target_repo: 'acme/widgets', pr_number: '7' } }));

    const payload = buildDispatchPayload({
      eventName: 'workflow_dispatch',
      eventPath,
      workflowFile: 'dispatcher.yml',
      ref: 'main',
    });

    expect(payload).toEqual({
      type: 'workflow_dispatch',
      workflow: 'dispatcher.yml',
      ref: 'main',
      inputs: { target_repo: 'acme/widgets', pr_number: '7' },
    });
  });

  it('builds a repository_dispatch payload from action/event_type + client_payload', () => {
    const eventPath = path.join(tmpRoot, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ action: 'telegram_message', client_payload: { chat_id: 123, text: 'hi' } }));

    const payload = buildDispatchPayload({ eventName: 'repository_dispatch', eventPath });

    expect(payload).toEqual({
      type: 'repository_dispatch',
      eventType: 'telegram_message',
      clientPayload: { chat_id: 123, text: 'hi' },
    });
  });

  it('defaults ref to main when unset', () => {
    const eventPath = path.join(tmpRoot, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ inputs: {} }));
    const payload = buildDispatchPayload({ eventName: 'workflow_dispatch', eventPath, workflowFile: 'x.yml' });
    expect(payload.ref).toBe('main');
  });

  it('returns null for an unrecognized event name', () => {
    expect(buildDispatchPayload({ eventName: 'push', eventPath: '' })).toBeNull();
  });
});
