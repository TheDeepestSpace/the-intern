import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readEntries, updateEntries, buildDispatchPayload, BRANCH_NAME } from '../manage-pending-retries.js';
import { upsertStall, resolveEntry } from '../pending-retries-store.js';

// Same real-git-against-scratch-repos approach as manage-summaries.test.js —
// this module's actual failure modes (branch-not-created-yet, concurrent
// push races) only show up against a real git binary. the-intern-data is
// simulated by a local bare repo pointed to via DATA_REPO_REMOTE_URL, the same
// test/manual escape hatch the module itself uses to bypass installation-token
// minting.

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

const DISPATCH = { type: 'workflow_dispatch', workflow: 'dispatcher.yml', ref: 'main', inputs: { target_repo: 'acme/widgets' } };

describe('manage-pending-retries', () => {
  let originalHome;
  let originalCwd;
  let tmpRoot;
  let fakeHome;
  let dataRemoteDir;

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
    dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(dataRemoteDir);
    process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.APP_ID;
    delete process.env.APP_PRIVATE_KEY;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function newWorkDir(name) {
    const dir = path.join(tmpRoot, name);
    initWorkRepo(dir);
    return dir;
  }

  it('readEntries returns [] when the branch does not exist yet', async () => {
    process.chdir(newWorkDir('work-read-empty'));
    expect(await readEntries()).toEqual([]);
  });

  it('readEntries returns [] when the-intern-data remote cannot be resolved', async () => {
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.APP_ID;
    delete process.env.APP_PRIVATE_KEY;
    process.chdir(newWorkDir('work-read-no-remote'));

    expect(await readEntries()).toEqual([]);
  });

  it('updateEntries throws when the-intern-data remote cannot be resolved', async () => {
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.APP_ID;
    delete process.env.APP_PRIVATE_KEY;
    process.chdir(newWorkDir('work-write-no-remote'));

    await expect(
      updateEntries((entries) => resolveEntry(entries, 'k'))
    ).rejects.toThrow(/the-intern-data remote is not configured/);
  });

  it('round-trips an upserted entry through the branch', async () => {
    const writer = newWorkDir('work-write');
    process.chdir(writer);

    const { entry } = await updateEntries((entries) =>
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
    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('dispatcher:acme/widgets#7');
    expect(entries[0].dispatch).toEqual(DISPATCH);

    const branches = sh('git ls-remote --heads .', dataRemoteDir);
    expect(branches).toContain(`refs/heads/${BRANCH_NAME}`);
  });

  it('resolveEntry removes a previously-queued entry', async () => {
    const writer = newWorkDir('work-resolve-write');
    process.chdir(writer);
    await updateEntries((entries) =>
      upsertStall(entries, { key: 'k', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH })
    );

    const resolver = newWorkDir('work-resolve');
    process.chdir(resolver);
    const { removed } = await updateEntries((entries) => resolveEntry(entries, 'k'));
    expect(removed.key).toBe('k');

    const reader = newWorkDir('work-resolve-read');
    process.chdir(reader);
    expect(await readEntries()).toEqual([]);
  });

  it('does not push when resolving a key that was never queued (no-op mutation)', async () => {
    const work = newWorkDir('work-noop');
    process.chdir(work);

    const { removed } = await updateEntries((entries) => resolveEntry(entries, 'never-queued'));
    expect(removed).toBeNull();

    const branches = sh('git ls-remote --heads .', dataRemoteDir);
    expect(branches).not.toContain(BRANCH_NAME);
  });

  it('leaves the caller checkout on its original branch with its files intact', async () => {
    const work = newWorkDir('work-branch-preserved');
    process.chdir(work);

    await updateEntries((entries) =>
      upsertStall(entries, { key: 'k', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH })
    );

    expect(sh('git rev-parse --abbrev-ref HEAD', work)).toBe('main');
    expect(fs.existsSync(path.join(work, 'README.md'))).toBe(true);
  });

  it('retries and succeeds when the local pending-retries branch has diverged from the remote (mirrors manage-summaries #49 regression)', async () => {
    // Seed the remote with an initial entry.
    const seeder = newWorkDir('work-race-seed');
    process.chdir(seeder);
    await updateEntries((entries) =>
      upsertStall(entries, { key: 'a', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH })
    );

    // workB fetches that state, then makes an unpushed local commit on
    // pending-retries directly (bypassing updateEntries) so its local branch
    // diverges from whatever the remote does next. A plain "writer B writes,
    // then writer A writes" race is always a fast-forward for B's subsequent
    // fetch and never actually rejects the push (verified against real git);
    // only a genuinely diverged local branch forces the rejection this test
    // means to exercise.
    const workB = newWorkDir('work-race-b');
    process.chdir(workB);
    sh(`git fetch "${dataRemoteDir}" ${BRANCH_NAME}:${BRANCH_NAME}`, workB);
    sh(`git checkout ${BRANCH_NAME}`, workB);
    fs.writeFileSync(path.join(workB, 'pending-retries.json'), '[{"key":"a"},{"key":"stale-local"}]\n');
    sh('git add pending-retries.json', workB);
    sh('git commit -m "stale local commit, never pushed"', workB);
    sh('git checkout main', workB);

    // Another writer advances the remote past what workB's local branch knows.
    const workC = newWorkDir('work-race-c');
    process.chdir(workC);
    await updateEntries((entries) =>
      upsertStall(entries, { key: 'c', source: 'dispatcher', retryAfter: 'C', maxRetries: 3, dispatch: DISPATCH })
    );

    // workB's write is rejected on attempt 1 (its local branch has diverged)
    // and must succeed after the retry logic discards it and rebuilds on top
    // of the current remote tip.
    process.chdir(workB);
    await updateEntries((entries) =>
      upsertStall(entries, { key: 'b', source: 'dispatcher', retryAfter: 'B', maxRetries: 3, dispatch: DISPATCH })
    );

    const reader = newWorkDir('work-race-read');
    process.chdir(reader);
    const entries = await readEntries();
    expect(entries.map((e) => e.key).sort()).toEqual(['a', 'b', 'c']);
  });

  function pushCorruptBranch(work) {
    sh(`git checkout -q --orphan ${BRANCH_NAME}`, work);
    sh('git rm -rf -q .', work);
    fs.writeFileSync(path.join(work, 'pending-retries.json'), 'not valid json');
    sh('git add pending-retries.json', work);
    sh('git commit -qm corrupt', work);
    sh(`git push -q "${dataRemoteDir}" ${BRANCH_NAME}`, work);
    sh('git checkout -q main', work);
  }

  it('readEntries logs and returns [] instead of throwing on a corrupt branch', async () => {
    const writer = newWorkDir('work-corrupt-write');
    pushCorruptBranch(writer);

    const reader = newWorkDir('work-corrupt-read');
    process.chdir(reader);
    expect(await readEntries()).toEqual([]);
  });

  it('updateEntries throws instead of silently wiping a corrupt branch', async () => {
    const writer = newWorkDir('work-corrupt-write2');
    pushCorruptBranch(writer);

    const work = newWorkDir('work-corrupt-update');
    process.chdir(work);

    await expect(
      updateEntries((entries) =>
        upsertStall(entries, { key: 'k', source: 'dispatcher', retryAfter: 'A', maxRetries: 3, dispatch: DISPATCH })
      )
    ).rejects.toThrow(/not valid JSON/);

    const reader = newWorkDir('work-corrupt-verify');
    process.chdir(reader);
    sh(`git fetch -q "${dataRemoteDir}" ${BRANCH_NAME}:${BRANCH_NAME}`, reader);
    expect(sh(`git show ${BRANCH_NAME}:pending-retries.json`, reader)).toBe('not valid json');
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

  it('returns null instead of throwing when the event file is malformed', () => {
    const eventPath = path.join(tmpRoot, 'event.json');
    fs.writeFileSync(eventPath, 'not json at all');
    expect(buildDispatchPayload({ eventName: 'workflow_dispatch', eventPath, workflowFile: 'dispatcher.yml' })).toBeNull();
  });

  it('returns null for a repository_dispatch with no action or event_type', () => {
    const eventPath = path.join(tmpRoot, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ client_payload: { chat_id: 123 } }));
    expect(buildDispatchPayload({ eventName: 'repository_dispatch', eventPath })).toBeNull();
  });

  it('returns null for a workflow_dispatch with no workflowFile', () => {
    const eventPath = path.join(tmpRoot, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ inputs: {} }));
    expect(buildDispatchPayload({ eventName: 'workflow_dispatch', eventPath, workflowFile: '' })).toBeNull();
  });
});
