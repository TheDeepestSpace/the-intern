import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { fetchBackend, fetchSummary, fetchLatestSummary, resolveBackend, saveSummary } from '../manage-summaries.js';

// These tests run real git against scratch repos in a tmpdir rather than mocking
// git, per the issue: the bugs this module has actually had (dubious-ownership,
// duplicate-push race) only show up against a real git binary.

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: process.env }).trim();
}

function initBareRemote(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init --bare -b main .', dir);
}

// Each work dir simulates a separate job's independent checkout, so its own
// `main` history is local only (never pushed) — otherwise two work dirs
// racing to push their unrelated `main` histories to the same remote would
// collide on a ref the code under test never even reads.
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

describe('manage-summaries', () => {
  let originalHome;
  let originalCwd;
  let tmpRoot;
  let fakeHome;
  let remoteDir;

  beforeAll(() => {
    // git config --global --add safe.directory writes to $HOME/.gitconfig; point
    // HOME at a throwaway dir so these tests never touch the real user's config.
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-summaries-home-'));
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-summaries-'));
    remoteDir = path.join(tmpRoot, 'remote.git');
    initBareRemote(remoteDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_OUTPUT;
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.APP_ID;
    delete process.env.APP_PRIVATE_KEY;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function newWorkDir(name) {
    const dir = path.join(tmpRoot, name);
    initWorkRepo(dir, remoteDir);
    return dir;
  }

  describe('resolveBackend', () => {
    it('prefers an explicit backend over a persisted backend', () => {
      expect(resolveBackend('codex', true, 'claude')).toBe('codex');
    });

    it('uses the persisted backend when the trigger is implicit', () => {
      expect(resolveBackend('claude', false, 'codex')).toBe('codex');
    });

    it('defaults unsupported or missing choices to claude', () => {
      expect(resolveBackend('unsupported', true, 'codex')).toBe('claude');
      expect(resolveBackend('claude', false, '')).toBe('claude');
    });
  });

  describe('fetchSummary', () => {
    it('returns an empty string and does not throw when no summary branch exists', async () => {
      const work = newWorkDir('work-fetch-empty');
      process.chdir(work);

      const result = await fetchSummary('acme/widgets', '7');

      expect(result).toBe('');
    });

    it('returns "" without touching git when targetRepo or issueNumber is missing', async () => {
      const work = newWorkDir('work-fetch-missing');
      process.chdir(work);

      expect(await fetchSummary('', '7')).toBe('');
      expect(await fetchSummary('acme/widgets', '')).toBe('');
    });

    it('round-trips a saved summary back out via fetch', async () => {
      const saver = newWorkDir('work-save');
      process.chdir(saver);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      await saveSummary('acme/widgets', '7', 'the original prompt', 'the execution result', 'codex');
      expect(process.exitCode).toBe(0);

      const fetcher = newWorkDir('work-fetch');
      process.chdir(fetcher);
      const result = await fetchSummary('acme/widgets', '7');

      expect(result).toContain('the original prompt');
      expect(result).toContain('the execution result');
      expect(result).toContain('acme/widgets');
      expect(result).toContain('#7');
      expect(result).toContain('**Backend**: codex');
      expect(await fetchBackend('acme/widgets', '7')).toBe('codex');
    });

    it('writes the summary to GITHUB_OUTPUT using a heredoc delimiter', async () => {
      const saver = newWorkDir('work-save-out');
      process.chdir(saver);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      await saveSummary('acme/widgets', '9', 'prompt', 'result');

      const fetcher = newWorkDir('work-fetch-out');
      process.chdir(fetcher);
      const outputFile = path.join(tmpRoot, 'gh-output');
      fs.writeFileSync(outputFile, '');
      process.env.GITHUB_OUTPUT = outputFile;

      await fetchSummary('acme/widgets', '9');

      const contents = fs.readFileSync(outputFile, 'utf8');
      expect(contents).toMatch(/summary<<EOF_\w+\n[\s\S]*result[\s\S]*\nEOF_\w+\n/);
    });

    it('writes the persisted backend to GITHUB_OUTPUT', async () => {
      const saver = newWorkDir('work-save-backend-out');
      process.chdir(saver);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      await saveSummary('acme/widgets', '10', 'prompt', 'result', 'codex');

      const fetcher = newWorkDir('work-fetch-backend-out');
      process.chdir(fetcher);
      const outputFile = path.join(tmpRoot, 'backend-output');
      fs.writeFileSync(outputFile, '');
      process.env.GITHUB_OUTPUT = outputFile;

      expect(await fetchBackend('acme/widgets', '10')).toBe('codex');
      expect(fs.readFileSync(outputFile, 'utf8')).toContain('backend=codex\n');
    });

    it('returns the backend from the most recent summary', async () => {
      const saver = newWorkDir('work-save-latest-backend');
      process.chdir(saver);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      const now = vi.spyOn(Date, 'now').mockReturnValue(1000);

      try {
        await saveSummary('acme/widgets', '14', 'first prompt', 'first result', 'codex');
        await saveSummary('acme/widgets', '14', 'second prompt', 'second result', 'claude');
      } finally {
        now.mockRestore();
      }

      const fetcher = newWorkDir('work-fetch-latest-backend');
      process.chdir(fetcher);

      expect(await fetchBackend('acme/widgets', '14')).toBe('claude');
    });

    it('records the effective fallback for an unsupported backend', async () => {
      const saver = newWorkDir('work-save-invalid-backend');
      process.chdir(saver);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      await saveSummary('acme/widgets', '12', 'prompt', 'result', 'unsupported');

      const fetcher = newWorkDir('work-fetch-invalid-backend');
      process.chdir(fetcher);

      // saveSummary records the actual fallback backend, never an unusable value.
      expect(await fetchBackend('acme/widgets', '12')).toBe('claude');
    });

    it('sanitizes non-alphanumeric characters in the repo name into the branch/dir slug', async () => {
      const saver = newWorkDir('work-save-slug');
      process.chdir(saver);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      await saveSummary('acme/weird.repo!name', '3', 'p', 'r');

      const branches = sh('git ls-remote --heads .', remoteDir);
      expect(branches).toContain('refs/heads/summaries/acme-weird-repo-name/3');
    });
  });

  describe('saveSummary', () => {
    it('does nothing when targetRepo or issueNumber is missing', async () => {
      const work = newWorkDir('work-save-missing');
      process.chdir(work);

      await saveSummary('', '7', 'p', 'r');
      await saveSummary('acme/widgets', '', 'p', 'r');

      const branches = sh('git ls-remote --heads .', remoteDir);
      expect(branches).not.toContain('summaries/');
    });

    it('refuses to save when the issue number is not a positive integer', async () => {
      const work = newWorkDir('work-save-invalid-issue');
      process.chdir(work);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';

      await saveSummary('acme/widgets', 'not-a-number', 'p', 'r');

      expect(process.exitCode).toBe(1);
      const branches = sh('git ls-remote --heads .', remoteDir);
      expect(branches).not.toContain('summaries/');
    });

    it('refuses "0" as an issue number', async () => {
      const work = newWorkDir('work-save-zero-issue');
      process.chdir(work);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';

      await saveSummary('acme/widgets', '0', 'p', 'r');

      expect(process.exitCode).toBe(1);
    });

    it('commits locally but skips pushing when no GITHUB_TOKEN/GH_TOKEN is set', async () => {
      const work = newWorkDir('work-save-no-token');
      process.chdir(work);
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      await saveSummary('acme/widgets', '11', 'p', 'r');

      expect(process.exitCode).toBe(0);
      const branches = sh('git ls-remote --heads .', remoteDir);
      expect(branches).not.toContain('summaries/');
      const localBranch = sh('git branch --list summaries/acme-widgets/11', work);
      expect(localBranch).toContain('summaries/acme-widgets/11');
    });

    it('retries and succeeds when a concurrent job already pushed the branch first (regression for #49)', async () => {
      // Simulate two concurrent jobs (e.g. a fetch-then-save race) that both start
      // from a checkout with no local knowledge of the summaries branch, and both
      // call saveSummary for the same issue. The second one's initial orphan-branch
      // push must be rejected as non-fast-forward, then succeed after retrying.
      const workA = newWorkDir('work-race-a');
      const workB = newWorkDir('work-race-b');

      process.chdir(workA);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      await saveSummary('acme/widgets', '42', 'prompt A', 'result A');
      expect(process.exitCode).toBe(0);

      process.chdir(workB);
      await saveSummary('acme/widgets', '42', 'prompt B', 'result B');
      expect(process.exitCode).toBe(0);

      // The remote branch must contain both summaries, not just the second writer's,
      // proving the retry rebuilt on top of A's commit instead of clobbering it.
      const files = sh('git ls-tree -r --name-only summaries/acme-widgets/42', remoteDir);
      const mdFiles = files.split('\n').filter(f => f.endsWith('.md'));
      expect(mdFiles).toHaveLength(2);

      const log = sh('git log --oneline summaries/acme-widgets/42', remoteDir);
      expect(log.split('\n')).toHaveLength(2);

      const fetcher = newWorkDir('work-race-fetch');
      process.chdir(fetcher);
      const latest = await fetchSummary('acme/widgets', '42');
      expect(latest).toContain('result B');
    });

    it('surfaces a genuine push failure (not non-fast-forward) instead of retrying forever', async () => {
      const work = newWorkDir('work-save-bad-remote');
      process.chdir(work);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      // Point origin at a path with no git repo at all so the push fails for a
      // reason unrelated to the retry-worthy non-fast-forward case.
      sh('git remote set-url origin /nonexistent/path/to/nowhere.git', work);

      await saveSummary('acme/widgets', '13', 'p', 'r');

      expect(process.exitCode).toBe(1);
    });
  });

  describe('dual-write / dual-read to the-intern-data', () => {
    let dataRemoteDir;

    beforeEach(() => {
      dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
      initBareRemote(dataRemoteDir);
      // DATA_REPO_REMOTE_URL bypasses installation-token minting entirely, so
      // these tests exercise the real git dual-write/dual-read paths against a
      // local bare repo instead of hitting the network.
      process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
    });

    it('mirrors a saved summary onto the shared `summaries` branch on the-intern-data', async () => {
      const work = newWorkDir('work-dual-save');
      process.chdir(work);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';

      await saveSummary('acme/widgets', '20', 'dual prompt', 'dual result', 'codex');
      expect(process.exitCode).toBe(0);

      const branches = sh('git branch --list summaries', dataRemoteDir);
      expect(branches).toContain('summaries');

      const files = sh('git ls-tree -r --name-only summaries', dataRemoteDir);
      const mdFiles = files.split('\n').filter(f => f.startsWith('summaries/acme-widgets/20/') && f.endsWith('.md'));
      expect(mdFiles).toHaveLength(1);

      const content = sh(`git show summaries:${mdFiles[0]}`, dataRemoteDir);
      expect(content).toContain('dual prompt');
      expect(content).toContain('dual result');
      expect(content).toContain('**Backend**: codex');
    });

    it('accumulates multiple issues as plain files on the same shared branch (no per-issue branches)', async () => {
      const workA = newWorkDir('work-dual-multi-a');
      process.chdir(workA);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      await saveSummary('acme/widgets', '21', 'prompt one', 'result one');

      const workB = newWorkDir('work-dual-multi-b');
      process.chdir(workB);
      await saveSummary('acme/other', '5', 'prompt two', 'result two');

      const branches = sh('git branch --list summaries', dataRemoteDir);
      expect(branches.split('\n').filter(Boolean)).toHaveLength(1);

      const files = sh('git ls-tree -r --name-only summaries', dataRemoteDir);
      expect(files).toContain('summaries/acme-widgets/21/');
      expect(files).toContain('summaries/acme-other/5/');
    });

    it('fetchLatestSummary prefers the newer of the two sources when the-intern-data has the latest save', async () => {
      const older = newWorkDir('work-dual-older');
      process.chdir(older);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      delete process.env.DATA_REPO_REMOTE_URL; // this save only reaches origin
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await saveSummary('acme/widgets', '22', 'origin-only prompt', 'origin-only result');
      } finally {
        now.mockRestore();
      }
      expect(process.exitCode).toBe(0);

      process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
      const newer = newWorkDir('work-dual-newer');
      process.chdir(newer);
      const later = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
      try {
        await saveSummary('acme/widgets', '22', 'dual-write prompt', 'dual-write result');
      } finally {
        later.mockRestore();
      }
      expect(process.exitCode).toBe(0);

      const fetcher = newWorkDir('work-dual-fetch');
      process.chdir(fetcher);
      const { content } = await fetchLatestSummary('acme/widgets', '22');

      expect(content).toContain('dual-write result');
      expect(content).not.toContain('origin-only result');
    });

    it('fetchLatestSummary falls back to origin when the-intern-data has an older or missing entry', async () => {
      process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
      const dualWriter = newWorkDir('work-dual-fallback-old');
      process.chdir(dualWriter);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';
      const early = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await saveSummary('acme/widgets', '23', 'first (mirrored) prompt', 'first (mirrored) result');
      } finally {
        early.mockRestore();
      }

      // Second save only reaches origin (data repo unreachable this time), so
      // origin is now strictly newer than the mirrored copy.
      delete process.env.DATA_REPO_REMOTE_URL;
      const later = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
      try {
        await saveSummary('acme/widgets', '23', 'second (origin-only) prompt', 'second (origin-only) result');
      } finally {
        later.mockRestore();
      }
      expect(process.exitCode).toBe(0);

      const fetcher = newWorkDir('work-dual-fallback-fetch');
      process.chdir(fetcher);
      process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
      const { content } = await fetchLatestSummary('acme/widgets', '23');

      expect(content).toContain('second (origin-only) result');
    });

    it('does not touch the origin save/fetch outcome when the-intern-data is unreachable', async () => {
      process.env.DATA_REPO_REMOTE_URL = '/nonexistent/path/to/the-intern-data.git';

      const work = newWorkDir('work-dual-unreachable');
      process.chdir(work);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';

      await saveSummary('acme/widgets', '24', 'prompt', 'result');
      expect(process.exitCode).toBe(0);

      const fetcher = newWorkDir('work-dual-unreachable-fetch');
      process.chdir(fetcher);
      const result = await fetchSummary('acme/widgets', '24');

      expect(result).toContain('result');
    });

    it('skips the dual-write/dual-read entirely (without error) when no token material or override is configured', async () => {
      delete process.env.DATA_REPO_REMOTE_URL;
      delete process.env.APP_ID;
      delete process.env.APP_PRIVATE_KEY;

      const work = newWorkDir('work-dual-no-config');
      process.chdir(work);
      process.env.GITHUB_TOKEN = 'fake-token-for-push';

      await saveSummary('acme/widgets', '25', 'prompt', 'result');
      expect(process.exitCode).toBe(0);

      const branches = sh('git branch --list summaries', dataRemoteDir);
      expect(branches).toBe('');
    });
  });
});
