import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  slugToOwnerRepo,
  parseCandidates,
  isMergedPr,
  deleteBranch,
  getTokenForRepo,
  main,
} from '../cleanup-data-branches.js';

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

describe('slugToOwnerRepo', () => {
  it('recovers owner/repo when the slug starts with the org prefix', () => {
    expect(slugToOwnerRepo('TheDeepestSpace-svsch')).toBe('TheDeepestSpace/svsch');
  });

  it('preserves hyphens that were already part of the repo name', () => {
    expect(slugToOwnerRepo('TheDeepestSpace-my-cool-repo')).toBe('TheDeepestSpace/my-cool-repo');
  });

  it('returns null when the slug does not start with the org prefix', () => {
    expect(slugToOwnerRepo('SomeOtherOrg-widgets')).toBeNull();
  });

  it('returns null for the bare org prefix with nothing after it', () => {
    expect(slugToOwnerRepo('TheDeepestSpace-')).toBeNull();
  });
});

describe('parseCandidates', () => {
  it('groups summaries and workspace branches for the same repo/issue together', () => {
    const output = [
      'aaa\trefs/heads/summaries/TheDeepestSpace-svsch/42',
      'bbb\trefs/heads/workspace/TheDeepestSpace-svsch/42',
    ].join('\n');

    const { candidates, skippedSlugs } = parseCandidates(output);
    expect(candidates).toEqual([
      {
        targetRepo: 'TheDeepestSpace/svsch',
        issueNumber: '42',
        branches: {
          summaries: 'summaries/TheDeepestSpace-svsch/42',
          workspace: 'workspace/TheDeepestSpace-svsch/42',
        },
      },
    ]);
    expect(skippedSlugs).toEqual([]);
  });

  it('keeps a candidate with only one of the two branch kinds', () => {
    const output = 'aaa\trefs/heads/summaries/TheDeepestSpace-svsch/7';
    const { candidates } = parseCandidates(output);
    expect(candidates).toEqual([
      { targetRepo: 'TheDeepestSpace/svsch', issueNumber: '7', branches: { summaries: 'summaries/TheDeepestSpace-svsch/7' } },
    ]);
  });

  it('separates distinct issue numbers into distinct candidates', () => {
    const output = [
      'aaa\trefs/heads/summaries/TheDeepestSpace-svsch/1',
      'bbb\trefs/heads/summaries/TheDeepestSpace-svsch/2',
    ].join('\n');
    const { candidates } = parseCandidates(output);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.issueNumber).sort()).toEqual(['1', '2']);
  });

  it('ignores unrelated refs', () => {
    const output = [
      'aaa\trefs/heads/main',
      'bbb\trefs/heads/pending-retries',
      'ccc\trefs/heads/some-other-branch/thing/1',
    ].join('\n');
    const { candidates, skippedSlugs } = parseCandidates(output);
    expect(candidates).toEqual([]);
    expect(skippedSlugs).toEqual([]);
  });

  it('collects slugs that cannot be mapped back to an owner/repo instead of dropping them silently', () => {
    const output = 'aaa\trefs/heads/summaries/SomeOtherOrg-widgets/5';
    const { candidates, skippedSlugs } = parseCandidates(output);
    expect(candidates).toEqual([]);
    expect(skippedSlugs).toEqual(['SomeOtherOrg-widgets']);
  });

  it('returns nothing for empty input', () => {
    expect(parseCandidates('')).toEqual({ candidates: [], skippedSlugs: [] });
  });
});

describe('isMergedPr', () => {
  it('returns true when the PR is merged', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ merged: true }) }));
    expect(await isMergedPr('acme/widgets', '7', 'tok', fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/widgets/pulls/7',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) })
    );
  });

  it('returns false when the PR exists but is not merged', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ merged: false }) }));
    expect(await isMergedPr('acme/widgets', '7', 'tok', fetchImpl)).toBe(false);
  });

  it('returns false (not an error) on a 404 — a plain issue, not a PR', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
    expect(await isMergedPr('acme/widgets', '7', 'tok', fetchImpl)).toBe(false);
  });

  it('throws on a real API error instead of treating it as unmerged', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(isMergedPr('acme/widgets', '7', 'tok', fetchImpl)).rejects.toThrow(/500/);
  });
});

describe('getTokenForRepo', () => {
  it('mints once and reuses the cached token for the same repo', async () => {
    const mintFn = vi.fn(async () => 'tok-123');
    const cache = new Map();
    const env = { APP_ID: 'app', APP_PRIVATE_KEY: 'key' };

    const a = await getTokenForRepo('acme/widgets', env, cache, mintFn);
    const b = await getTokenForRepo('acme/widgets', env, cache, mintFn);

    expect(a).toBe('tok-123');
    expect(b).toBe('tok-123');
    expect(mintFn).toHaveBeenCalledTimes(1);
    expect(mintFn).toHaveBeenCalledWith({
      appId: 'app',
      privateKey: 'key',
      targetRepo: 'acme/widgets',
      permissions: { pull_requests: 'read' },
    });
  });

  it('caches a mint failure as null instead of retrying every call', async () => {
    const mintFn = vi.fn(async () => {
      throw new Error('installation not found');
    });
    const cache = new Map();
    const env = { APP_ID: 'app', APP_PRIVATE_KEY: 'key' };

    const a = await getTokenForRepo('acme/widgets', env, cache, mintFn);
    const b = await getTokenForRepo('acme/widgets', env, cache, mintFn);

    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(mintFn).toHaveBeenCalledTimes(1);
  });
});

describe('deleteBranch (against a real git remote)', () => {
  let tmpRoot;
  let dataRemoteDir;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-data-branches-'));
    dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(dataRemoteDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('deletes an existing branch and returns true', () => {
    const work = path.join(tmpRoot, 'work');
    initWorkRepo(work);
    sh(`git push "${dataRemoteDir}" main:refs/heads/summaries/TheDeepestSpace-svsch/1 -q`, work);
    process.chdir(work);

    expect(deleteBranch(dataRemoteDir, 'summaries/TheDeepestSpace-svsch/1')).toBe(true);
    expect(sh('git ls-remote --heads .', dataRemoteDir)).not.toContain('summaries/TheDeepestSpace-svsch/1');
  });

  it('returns false instead of throwing when the branch is already gone', () => {
    const work = path.join(tmpRoot, 'work2');
    initWorkRepo(work);
    process.chdir(work);

    expect(deleteBranch(dataRemoteDir, 'summaries/TheDeepestSpace-svsch/never-existed')).toBe(false);
  });
});

describe('main (orchestration)', () => {
  // resolveDataRepoRemoteUrl (data-repo-remote.js) reads DATA_REPO_REMOTE_URL
  // straight off process.env rather than the env object passed to main() —
  // same test/manual escape hatch manage-pending-retries.test.js and
  // manage-summaries.test.js rely on to simulate the-intern-data with a
  // local bare repo, so it's set on process.env here too.
  const baseEnv = { APP_ID: 'app', APP_PRIVATE_KEY: 'key' };
  let tmpRoot;
  let dataRemoteDir;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    process.exitCode = 0;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-data-branches-main-'));
    dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(dataRemoteDir);
    process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.DATA_REPO_TOKEN;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('deletes both branches for a merged PR and leaves an unmerged one alone', async () => {
    const work = path.join(tmpRoot, 'work');
    initWorkRepo(work);
    sh(`git push "${dataRemoteDir}" main:refs/heads/summaries/TheDeepestSpace-svsch/1 -q`, work);
    sh(`git push "${dataRemoteDir}" main:refs/heads/workspace/TheDeepestSpace-svsch/1 -q`, work);
    sh(`git push "${dataRemoteDir}" main:refs/heads/summaries/TheDeepestSpace-svsch/2 -q`, work);
    process.chdir(work);

    const isMergedPrFn = vi.fn(async (targetRepo, issueNumber) => issueNumber === '1');
    const getTokenForRepoFn = vi.fn(async () => 'tok');

    await main(baseEnv, { isMergedPrFn, deleteBranchFn: deleteBranch, getTokenForRepoFn });

    const remaining = sh('git ls-remote --heads .', dataRemoteDir);
    expect(remaining).not.toContain('summaries/TheDeepestSpace-svsch/1');
    expect(remaining).not.toContain('workspace/TheDeepestSpace-svsch/1');
    expect(remaining).toContain('summaries/TheDeepestSpace-svsch/2');
    expect(process.exitCode).toBe(0);
  });

  it('skips a candidate whose repo has no mintable token, without failing the run', async () => {
    const work = path.join(tmpRoot, 'work');
    initWorkRepo(work);
    sh(`git push "${dataRemoteDir}" main:refs/heads/summaries/TheDeepestSpace-svsch/1 -q`, work);
    process.chdir(work);

    const isMergedPrFn = vi.fn();
    const getTokenForRepoFn = vi.fn(async () => null);

    await main(baseEnv, { isMergedPrFn, deleteBranchFn: deleteBranch, getTokenForRepoFn });

    expect(isMergedPrFn).not.toHaveBeenCalled();
    expect(sh('git ls-remote --heads .', dataRemoteDir)).toContain('summaries/TheDeepestSpace-svsch/1');
    expect(process.exitCode).toBe(0);
  });

  it('errors out up front when APP_ID/APP_PRIVATE_KEY are missing', async () => {
    await main({}, {});
    expect(process.exitCode).toBe(1);
  });

  it('errors out up front when the-intern-data remote is not configured', async () => {
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.DATA_REPO_TOKEN;
    await main(baseEnv, {});
    expect(process.exitCode).toBe(1);
  });
});
