import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getBranchName,
  collectWorkspaceState,
  collectTranscriptFiles,
  saveBackup,
  fetchBackup,
  clearBackup,
  runBackupStep,
  runRestoreStep,
} from '../manage-workspace-backup.js';

// Same real-git-against-scratch-repos approach as manage-summaries.test.js and
// manage-pending-retries.test.js — the failure modes this module cares about
// (non-fast-forward races, am/apply conflicts, branch-not-created-yet) only
// show up against a real git binary. the-intern-data is simulated by a local
// bare repo pointed to via DATA_REPO_REMOTE_URL, the same test/manual escape
// hatch the module itself uses to bypass DATA_REPO_TOKEN-based auth.

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

// No user.name/user.email configured on the repo itself — mirrors the target
// checkout the dispatcher's restore step runs against in production, which
// hasn't had `git config user.name`/`user.email` applied yet (that happens
// later, inside "Run agent"). The seed commit still needs an identity, so
// that one is passed inline via -c rather than persisted to repo config.
function initWorkRepoNoIdentity(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -b main .', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# scratch repo\n');
  sh('git -c user.name=seed -c user.email=seed@example.com add README.md', dir);
  sh('git -c user.name=seed -c user.email=seed@example.com commit -m "initial commit"', dir);
}

describe('manage-workspace-backup', () => {
  let originalHome;
  let originalCwd;
  let tmpRoot;
  let fakeHome;
  let dataRemoteDir;

  beforeAll(() => {
    originalHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-home-'));
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    // Ambient GITHUB_OUTPUT (set when this suite runs inside GitHub Actions
    // itself) must not leak into tests that don't opt in via
    // withOutputFile() — otherwise runRestoreStep would append to the real
    // step output file.
    delete process.env.GITHUB_OUTPUT;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-'));
    dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(dataRemoteDir);
    process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.DATA_REPO_TOKEN;
    delete process.env.GITHUB_OUTPUT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function newWorkDir(name) {
    const dir = path.join(tmpRoot, name);
    initWorkRepo(dir);
    return dir;
  }

  function withOutputFile() {
    const outputFile = path.join(tmpRoot, `gh-output-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(outputFile, '');
    process.env.GITHUB_OUTPUT = outputFile;
    return outputFile;
  }

  describe('getBranchName', () => {
    it('sanitizes non-alphanumeric characters in the repo name', () => {
      expect(getBranchName('acme/weird.repo!name', '3')).toBe('workspace/acme-weird-repo-name/3');
    });
  });

  describe('runRestoreStep', () => {
    it('does nothing and reports restored=false when no backup branch exists', async () => {
      const work = newWorkDir('restore-empty');
      process.chdir(work);
      const outputFile = withOutputFile();

      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '7' });

      expect(fs.readFileSync(outputFile, 'utf8')).toContain('restored=false\n');
    });

    it('no-ops without touching git when targetRepo or issueNumber is missing', async () => {
      const work = newWorkDir('restore-missing-key');
      process.chdir(work);
      const outputFile = withOutputFile();

      await runRestoreStep({ TARGET_REPO: '', ISSUE_NUMBER: '7' });
      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '' });

      expect(fs.readFileSync(outputFile, 'utf8').match(/restored=false/g)).toHaveLength(2);
    });
  });

  describe('backup + restore round trip', () => {
    it('backs up an uncommitted diff and restores it onto a fresh checkout', async () => {
      const work = newWorkDir('uncommitted-save');
      process.chdir(work);
      fs.writeFileSync(path.join(work, 'new-file.txt'), 'hello from the crashed run\n');
      fs.appendFileSync(path.join(work, 'README.md'), 'edited\n');

      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '1' });
      expect(process.exitCode).toBe(0);

      // Simulate the next dispatch: a fresh checkout with none of the above.
      const fresh = newWorkDir('uncommitted-restore');
      process.chdir(fresh);
      const outputFile = withOutputFile();

      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '1' });

      expect(fs.readFileSync(outputFile, 'utf8')).toContain('restored=true\n');
      expect(fs.readFileSync(path.join(fresh, 'new-file.txt'), 'utf8')).toBe('hello from the crashed run\n');
      expect(fs.readFileSync(path.join(fresh, 'README.md'), 'utf8')).toContain('edited');
      // Uncommitted diff is applied but left unstaged/uncommitted for the agent to review.
      expect(sh('git status --porcelain', fresh)).toContain('new-file.txt');

      // Backup branch is cleared immediately after a successful restore.
      const after = await fetchBackup('acme/widgets', '1');
      expect(after.found).toBe(false);
    });

    it('backs up a committed-but-unpushed commit and replays it as a real commit on restore', async () => {
      const work = newWorkDir('unpushed-commit-save');
      const baselineFile = path.join(tmpRoot, 'baseline-sha.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      fs.writeFileSync(path.join(work, 'committed-but-unpushed.txt'), 'agent committed this then the runner died\n');
      sh('git add committed-but-unpushed.txt', work);
      sh('git commit -m "agent work that never got pushed"', work);

      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '2', BASELINE_SHA_FILE: baselineFile });
      expect(process.exitCode).toBe(0);

      // A clean working tree at backup time must not mean "nothing to back up".
      const backup = await fetchBackup('acme/widgets', '2');
      expect(backup.commitsPatch).toContain('agent work that never got pushed');
      expect(backup.diffPatch).toBe('');

      const fresh = newWorkDir('unpushed-commit-restore');
      process.chdir(fresh);

      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '2' });

      expect(fs.readFileSync(path.join(fresh, 'committed-but-unpushed.txt'), 'utf8')).toBe(
        'agent committed this then the runner died\n'
      );
      const log = sh('git log --oneline -1', fresh);
      expect(log).toContain('agent work that never got pushed');
      // Replayed as a real commit, not left sitting in the working tree.
      expect(sh('git status --porcelain', fresh)).toBe('');
    });

    it('replays unpushed commits before applying the remaining uncommitted diff on top', async () => {
      const work = newWorkDir('combined-save');
      const baselineFile = path.join(tmpRoot, 'baseline-sha-combined.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      fs.writeFileSync(path.join(work, 'committed.txt'), 'committed but unpushed\n');
      sh('git add committed.txt', work);
      sh('git commit -m "unpushed commit"', work);
      fs.writeFileSync(path.join(work, 'uncommitted.txt'), 'never even committed\n');

      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '3', BASELINE_SHA_FILE: baselineFile });
      expect(process.exitCode).toBe(0);

      const fresh = newWorkDir('combined-restore');
      process.chdir(fresh);
      const outputFile = withOutputFile();

      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '3' });

      expect(fs.readFileSync(outputFile, 'utf8')).toContain('restored=true\n');
      expect(fs.readFileSync(path.join(fresh, 'committed.txt'), 'utf8')).toBe('committed but unpushed\n');
      expect(fs.readFileSync(path.join(fresh, 'uncommitted.txt'), 'utf8')).toBe('never even committed\n');
      expect(sh('git log --oneline -1', fresh)).toContain('unpushed commit');
      expect(sh('git status --porcelain', fresh)).toContain('uncommitted.txt');
    });

    it('replays unpushed commits via git am even when the destination checkout has no committer identity configured', async () => {
      const work = newWorkDir('no-identity-save');
      const baselineFile = path.join(tmpRoot, 'baseline-sha-no-identity.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      fs.writeFileSync(path.join(work, 'committed-but-unpushed.txt'), 'agent committed this then the runner died\n');
      sh('git add committed-but-unpushed.txt', work);
      sh('git commit -m "agent work that never got pushed"', work);

      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '10', BASELINE_SHA_FILE: baselineFile });
      expect(process.exitCode).toBe(0);

      const fresh = path.join(tmpRoot, 'no-identity-restore');
      initWorkRepoNoIdentity(fresh);
      process.chdir(fresh);

      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '10' });

      expect(fs.readFileSync(path.join(fresh, 'committed-but-unpushed.txt'), 'utf8')).toBe(
        'agent committed this then the runner died\n'
      );
      expect(sh('git log --oneline -1', fresh)).toContain('agent work that never got pushed');
    });

    it('leaves the backup branch in place when the restore fails to apply cleanly', async () => {
      const work = newWorkDir('conflict-save');
      process.chdir(work);
      fs.appendFileSync(path.join(work, 'README.md'), 'agent edit from the crashed run\n');

      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '11' });
      expect(process.exitCode).toBe(0);

      // A newer, conflicting change lands in the same file before restore runs.
      const fresh = newWorkDir('conflict-restore');
      process.chdir(fresh);
      fs.writeFileSync(path.join(fresh, 'README.md'), 'a completely different rewrite of this file\n');
      sh('git commit -am "conflicting newer commit"', fresh);
      const outputFile = withOutputFile();

      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '11' });

      expect(fs.readFileSync(outputFile, 'utf8')).toContain('restored=false\n');

      // The backup must survive a failed apply so a human can recover it manually.
      const after = await fetchBackup('acme/widgets', '11');
      expect(after.found).toBe(true);
      expect(after.diffPatch).toContain('agent edit from the crashed run');
    });

    it('leaves the checkout clean and the backup intact when git am fails to replay a conflicting commit', async () => {
      const work = newWorkDir('am-conflict-save');
      const baselineFile = path.join(tmpRoot, 'baseline-sha-am-conflict.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      fs.writeFileSync(path.join(work, 'README.md'), 'agent changed line 1\n');
      sh('git commit -am "agent commit that will conflict on restore"', work);

      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '12', BASELINE_SHA_FILE: baselineFile });
      expect(process.exitCode).toBe(0);

      // A newer, conflicting commit to the same file lands before restore runs.
      const fresh = newWorkDir('am-conflict-restore');
      process.chdir(fresh);
      fs.writeFileSync(path.join(fresh, 'README.md'), 'someone else changed line 1\n');
      sh('git commit -am "conflicting newer commit"', fresh);
      const outputFile = withOutputFile();

      await runRestoreStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '12' });

      expect(fs.readFileSync(outputFile, 'utf8')).toContain('restored=false\n');

      // The backup must survive a failed am so a human can recover it manually.
      const after = await fetchBackup('acme/widgets', '12');
      expect(after.found).toBe(true);
      expect(after.commitsPatch).toContain('agent commit that will conflict on restore');

      // `am --abort` must leave the checkout usable, not mid-am.
      expect(fs.existsSync(path.join(fresh, '.git', 'rebase-apply'))).toBe(false);
      expect(sh('git status --porcelain', fresh)).toBe('');
    });
  });

  describe('collectWorkspaceState with large binary output', () => {
    // Regression test for issue #149: `git diff --cached --binary` and
    // `git format-patch --binary --stdout` used to be captured through
    // execSync's default stdout pipe, which can crash with ENOBUFS on Linux
    // once the child produces output faster than Node's synchronous pipe
    // reader can drain it. A large binary file's base64-encoded patch is
    // enough to exercise that path; this asserts it's captured intact via
    // the file-redirect approach instead of silently truncating or crashing.
    it('captures a large uncommitted binary diff without crashing', () => {
      const work = newWorkDir('large-binary-diff');
      process.chdir(work);
      const bytes = require('crypto').randomBytes(8 * 1024 * 1024);
      fs.writeFileSync(path.join(work, 'large.bin'), bytes);

      const { diffPatch, commitsPatch } = collectWorkspaceState({});

      expect(commitsPatch).toBe('');
      expect(diffPatch).toContain('large.bin');
      expect(diffPatch.length).toBeGreaterThan(bytes.length);
    });

    it('captures a large unpushed commit diff without crashing', () => {
      const work = newWorkDir('large-binary-commit');
      const baselineFile = path.join(tmpRoot, 'baseline-sha-large.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      const bytes = require('crypto').randomBytes(8 * 1024 * 1024);
      fs.writeFileSync(path.join(work, 'large.bin'), bytes);
      sh('git add large.bin', work);
      sh('git commit -m "add large binary file"', work);

      const { diffPatch, commitsPatch } = collectWorkspaceState({ baselineShaFile: baselineFile });

      expect(diffPatch).toBe('');
      expect(commitsPatch).toContain('add large binary file');
      expect(commitsPatch.length).toBeGreaterThan(bytes.length);
    });

    // Regression test for issue #167: an implausible ahead-base (e.g. `@{u}`
    // resolving somewhere unrelated) can produce a commits.patch far larger
    // than the real session, which GitHub then rejects (GH001, >100MB) and
    // pages the maintainer for a run that already succeeded. Rather than
    // push a patch that size, collectWorkspaceState should skip it.
    it('skips the commits backup when the patch exceeds the size sanity threshold', () => {
      const work = newWorkDir('implausible-base-commit');
      const baselineFile = path.join(tmpRoot, 'baseline-sha-implausible.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      fs.writeFileSync(path.join(work, 'small.txt'), 'a real, tiny unpushed commit\n');
      sh('git add small.txt', work);
      sh('git commit -m "small unpushed commit"', work);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { diffPatch, commitsPatch } = collectWorkspaceState({
          baselineShaFile: baselineFile,
          maxCommitsPatchBytes: 1,
        });

        expect(diffPatch).toBe('');
        expect(commitsPatch).toBe('');
        expect(warnSpy.mock.calls.some(([msg]) => /commits\.patch would be/.test(msg))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    // Regression test for the CodeRabbit follow-up on #167/#168:
    // resolveAheadBase() must resolve @{u} to the immutable commit sha, not
    // the symbolic `origin/main`-style ref name — rev-list and format-patch
    // are two separate git invocations, and resolving the symbolic ref twice
    // could let a concurrent fetch make them disagree about what "ahead"
    // means. Asserting the logged ahead-base is a bare 40-char sha (not
    // "origin/main") exercises the real @{u} upstream path end to end.
    it('resolves the upstream base to an immutable commit sha, not a symbolic ref', () => {
      const upstreamRemote = path.join(tmpRoot, 'upstream.git');
      initBareRemote(upstreamRemote);

      const work = newWorkDir('upstream-sha-base');
      sh(`git remote add origin ${upstreamRemote}`, work);
      sh('git push -u origin main', work);

      process.chdir(work);
      fs.writeFileSync(path.join(work, 'unpushed.txt'), 'ahead of the pushed upstream\n');
      sh('git add unpushed.txt', work);
      sh('git commit -m "commit ahead of upstream"', work);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { commitsPatch } = collectWorkspaceState({});

        expect(commitsPatch).toContain('commit ahead of upstream');
        const aheadBaseLine = logSpy.mock.calls.map(([msg]) => msg).find((msg) => /ahead-base=/.test(msg));
        expect(aheadBaseLine).toMatch(/ahead-base=[0-9a-f]{40}\s/);
      } finally {
        logSpy.mockRestore();
      }
    });

    // Debugging aid requested alongside issue #167: when there's an ahead
    // base and/or untracked files, collectWorkspaceState should return which
    // files (per commit, and untracked) are contributing to the backup, with
    // sizes — not the file contents themselves — so a bad ahead-base is
    // diagnosable from file-listing.txt on the-intern-data without fetching
    // commits.patch at all. Routed there instead of the job log (issue
    // #168 follow-up) so the listing isn't capped by job-log noise concerns.
    it('collects per-commit and untracked file listings with sizes, not file contents', () => {
      const work = newWorkDir('file-listing-debug');
      const baselineFile = path.join(tmpRoot, 'baseline-sha-listing.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      fs.writeFileSync(path.join(work, 'committed.txt'), 'twelve bytes\n');
      sh('git add committed.txt', work);
      sh('git commit -m "unpushed commit with a file"', work);
      fs.writeFileSync(path.join(work, 'untracked.txt'), 'nine chars\n');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { fileListing } = collectWorkspaceState({ baselineShaFile: baselineFile });

        expect(fileListing).toMatch(/committed\.txt \(\d+ bytes\)/);
        expect(fileListing).toMatch(/\[untracked\] untracked\.txt \(\d+ bytes\)/);
        expect(fileListing).not.toContain('twelve bytes');
        expect(fileListing).not.toContain('nine chars');

        const messages = logSpy.mock.calls.map(([msg]) => msg).join('\n');
        expect(messages).not.toMatch(/committed\.txt \(\d+ bytes\)/);
        expect(messages).not.toMatch(/\[untracked\] untracked\.txt \(\d+ bytes\)/);
      } finally {
        logSpy.mockRestore();
      }
    });

    // Regression test for the CodeRabbit follow-up on #168: the per-commit
    // file listing used to build a shell command string with the filename
    // interpolated inside double quotes (`cat-file -s "sha:file"` via
    // execSync), which does not stop `$(...)` command substitution. A commit
    // containing a file whose name is a shell command-substitution payload
    // must not execute that payload.
    it('does not execute shell metacharacters in a committed filename', () => {
      const work = newWorkDir('shell-metachar-filename');
      const baselineFile = path.join(tmpRoot, 'baseline-sha-metachar.txt');
      fs.writeFileSync(baselineFile, sh('git rev-parse HEAD', work) + '\n');

      process.chdir(work);
      const markerFile = path.join(work, 'pwned.txt');
      const maliciousName = '$(touch pwned.txt)';
      fs.writeFileSync(path.join(work, maliciousName), 'payload\n');
      // execFileSync (not the shell-backed `sh` helper): the point of this
      // fixture is a filename the shell would expand, so staging it must not
      // itself go through a shell either.
      execFileSync('git', ['add', '--', maliciousName], { cwd: work });
      sh('git commit -m "commit with shell metacharacter filename"', work);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { fileListing } = collectWorkspaceState({ baselineShaFile: baselineFile });
        expect(fs.existsSync(markerFile)).toBe(false);
        expect(fileListing).toContain(maliciousName);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('saveBackup file-listing.txt', () => {
    // The file listing moved from job-log console.log calls to a pushed file
    // (issue #168 follow-up) so it's retrievable from the-intern-data instead
    // of an ephemeral Actions log; assert it actually lands on the branch.
    it('pushes fileListing as file-listing.txt on the backup branch', async () => {
      const work = newWorkDir('file-listing-persisted');
      process.chdir(work);
      await saveBackup('acme/widgets', '9', {
        diffPatch: '',
        commitsPatch: '',
        fileListing: 'untracked files:\n[untracked] secret-plan.txt (42 bytes)',
      });

      const branchName = getBranchName('acme/widgets', '9');
      const content = sh(`git show ${branchName}:file-listing.txt`, dataRemoteDir);
      expect(content).toContain('[untracked] secret-plan.txt (42 bytes)');
    });

    it('does not clear the backup when only fileListing is present', async () => {
      const work = newWorkDir('file-listing-only-not-cleared');
      process.chdir(work);
      await saveBackup('acme/widgets', '10', {
        diffPatch: '',
        commitsPatch: '',
        fileListing: 'ahead commits (base=abc, commits-ahead=1):\nabc1234 big.bin (999 bytes)',
      });

      const branches = sh('git ls-remote --heads .', dataRemoteDir);
      expect(branches).toContain(getBranchName('acme/widgets', '10'));
    });
  });

  describe('runBackupStep clearing behavior', () => {
    it('clears a stale backup branch when the tree is clean and there is nothing unpushed', async () => {
      const dirty = newWorkDir('clear-dirty');
      process.chdir(dirty);
      await saveBackup('acme/widgets', '4', { diffPatch: 'stale diff from a previous crashed run\n', commitsPatch: '' });

      const clean = newWorkDir('clear-clean');
      process.chdir(clean);
      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '4' });

      const after = await fetchBackup('acme/widgets', '4');
      expect(after.found).toBe(false);
    });

    it('does nothing when targetRepo or issueNumber is missing', async () => {
      const work = newWorkDir('backup-missing-key');
      process.chdir(work);
      fs.writeFileSync(path.join(work, 'file.txt'), 'x\n');

      await runBackupStep({ TARGET_REPO: '', ISSUE_NUMBER: '5' });
      await runBackupStep({ TARGET_REPO: 'acme/widgets', ISSUE_NUMBER: '' });

      const branches = sh('git ls-remote --heads .', dataRemoteDir);
      expect(branches).not.toContain('workspace/');
    });
  });

  describe('clearBackup', () => {
    it('is a no-op when the branch was never created', async () => {
      const work = newWorkDir('clear-never-created');
      process.chdir(work);

      await clearBackup('acme/widgets', '6');

      expect(process.exitCode).toBe(0);
    });
  });

  describe('collectTranscriptFiles', () => {
    it('picks up the newest Claude session transcript and the codex events file', () => {
      const home = fs.mkdtempSync(path.join(tmpRoot, 'agent-home-'));
      const projectDir = path.join(home, '.claude', 'projects', 'some-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'older.jsonl'), '{}\n');
      fs.utimesSync(path.join(projectDir, 'older.jsonl'), new Date(1000), new Date(1000));
      fs.writeFileSync(path.join(projectDir, 'newer.jsonl'), '{"event":"newer"}\n');
      fs.utimesSync(path.join(projectDir, 'newer.jsonl'), new Date(2000), new Date(2000));

      const codexEvents = path.join(tmpRoot, 'codex-events.jsonl');
      fs.writeFileSync(codexEvents, '{"event":"codex"}\n');

      const files = collectTranscriptFiles({ homeDir: home, codexEventsFile: codexEvents });

      expect(files).toContainEqual({ name: 'codex-events.jsonl', path: codexEvents });
      const claudeEntry = files.find(f => f.name === 'claude-session.jsonl');
      expect(claudeEntry.path).toBe(path.join(projectDir, 'newer.jsonl'));
    });

    it('returns no Claude transcript when the projects directory does not exist', () => {
      const home = path.join(tmpRoot, 'no-such-home');
      const files = collectTranscriptFiles({ homeDir: home, codexEventsFile: '/nonexistent/codex-events.jsonl' });
      expect(files).toEqual([]);
    });
  });
});
