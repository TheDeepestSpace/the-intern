import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLogPath, saveRunLog, BRANCH_NAME, MAX_LOG_BYTES } from '../manage-run-log.js';

// Same real-git-against-a-scratch-bare-repo approach as
// manage-codex-log.test.js/manage-workspace-backup.test.js: the-intern-data
// is simulated by a local bare repo pointed to via DATA_REPO_REMOTE_URL.

// maxBuffer raised past Node's 1MB default: the oversized-content regression
// test below reads back a multi-megabyte blob via `git show`.
function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024 }).trim();
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

describe('manage-run-log', () => {
  let originalCwd;
  let tmpRoot;
  let dataRemoteDir;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
    dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(dataRemoteDir);
    process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.DATA_REPO_TOKEN;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function newWorkDir(name) {
    const dir = path.join(tmpRoot, name);
    initWorkRepo(dir);
    return dir;
  }

  function readFromRemote(relPath) {
    return sh(`git show ${BRANCH_NAME}:${relPath}`, dataRemoteDir);
  }

  describe('getLogPath', () => {
    it('sanitizes non-alphanumeric characters per segment and nests by prefix/run', () => {
      expect(getLogPath('dispatcher/acme/weird.repo!name/7', '12345')).toBe(
        path.join('dispatcher', 'acme', 'weird-repo-name', '7', '12345.log')
      );
    });

    it('supports a prefix with no natural repo/issue scoping', () => {
      expect(getLogPath('telegram-session', '42')).toBe(path.join('telegram-session', '42.log'));
    });
  });

  describe('saveRunLog', () => {
    it('pushes the log content to the-intern-data at the expected path', async () => {
      const work = newWorkDir('save-basic');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'run.log');
      fs.writeFileSync(logFile, 'mint-installation-token failed: boom\n');

      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '999', logFile });

      const relPath = getLogPath('dispatcher/acme/widgets/5', '999');
      expect(readFromRemote(relPath)).toBe('mint-installation-token failed: boom');
    });

    it('leaves the caller checkout untouched (runs in an isolated worktree)', async () => {
      const work = newWorkDir('save-isolated');
      process.chdir(work);
      const branchBefore = sh('git rev-parse --abbrev-ref HEAD', work);
      const logFile = path.join(tmpRoot, 'run.log');
      fs.writeFileSync(logFile, 'boom\n');

      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '1', logFile });

      expect(sh('git rev-parse --abbrev-ref HEAD', work)).toBe(branchBefore);
      expect(fs.existsSync(path.join(work, 'dispatcher'))).toBe(false);
    });

    it('accumulates logs from multiple runs under the same branch, in order', async () => {
      const work = newWorkDir('save-multi');
      process.chdir(work);
      const logFileA = path.join(tmpRoot, 'a.log');
      const logFileB = path.join(tmpRoot, 'b.log');
      fs.writeFileSync(logFileA, 'mint-installation-token\nfetch-summary\n');
      fs.writeFileSync(logFileB, 'chown\nrun-agent\n');

      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '1', logFile: logFileA });
      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '2', logFile: logFileB });

      expect(readFromRemote(getLogPath('dispatcher/acme/widgets/5', '1'))).toBe('mint-installation-token\nfetch-summary');
      expect(readFromRemote(getLogPath('dispatcher/acme/widgets/5', '2'))).toBe('chown\nrun-agent');
    });

    it('preserves the order of multiple steps appended into one run log (what `exec >> "$LOG_FILE" 2>&1` produces per step)', async () => {
      const work = newWorkDir('save-appended-steps');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'run.log');

      // Each workflow step's script starts with `exec >> "$LOG_FILE" 2>&1`, so
      // a real run builds this file by repeated appends, one per step, in the
      // order the steps execute — not by writing it all at once. Simulate
      // that here rather than asserting on a single fs.writeFileSync blob.
      fs.appendFileSync(logFile, 'Mint installation token: minted for acme/widgets\n');
      fs.appendFileSync(logFile, 'Ensure dev user and workspace ownership: chown ok\n');
      fs.appendFileSync(logFile, 'Run agent: session failed with exit 1\n');

      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '1', logFile });

      const pushed = readFromRemote(getLogPath('dispatcher/acme/widgets/5', '1'));
      expect(pushed.split('\n')).toEqual([
        'Mint installation token: minted for acme/widgets',
        'Ensure dev user and workspace ownership: chown ok',
        'Run agent: session failed with exit 1',
      ]);
    });

    it('does nothing when prefix or runId is missing', async () => {
      const work = newWorkDir('save-missing-key');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'run.log');
      fs.writeFileSync(logFile, 'content\n');

      await saveRunLog({ prefix: '', runId: '1', logFile });
      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '', logFile });

      expect(sh(`git ls-remote ${dataRemoteDir} ${BRANCH_NAME}`, work)).toBe('');
    });

    it('does nothing when the log file does not exist', async () => {
      const work = newWorkDir('save-missing-file');
      process.chdir(work);

      await saveRunLog({
        prefix: 'dispatcher/acme/widgets/5',
        runId: '1',
        logFile: path.join(tmpRoot, 'does-not-exist.log'),
      });

      expect(sh(`git ls-remote ${dataRemoteDir} ${BRANCH_NAME}`, work)).toBe('');
    });

    it('does nothing when the log file is empty', async () => {
      const work = newWorkDir('save-empty-file');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'empty.log');
      fs.writeFileSync(logFile, '   \n');

      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '1', logFile });

      expect(sh(`git ls-remote ${dataRemoteDir} ${BRANCH_NAME}`, work)).toBe('');
    });

    it('truncates oversized content to a UTF-8-safe boundary, never exceeding MAX_LOG_BYTES', async () => {
      const work = newWorkDir('save-oversized-multibyte');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'oversized.log');

      // Places a 3-byte multibyte char ('中') straddling the exact byte offset
      // the truncation cut lands on, so the naive `slice(-MAX_LOG_BYTES)` would
      // split it mid-character and produce an invalid UTF-8 tail.
      const pad = 'a'.repeat(100);
      const tail = 'b'.repeat(MAX_LOG_BYTES - 2);
      fs.writeFileSync(logFile, pad + '中' + tail);

      await saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '1', logFile });

      const pushed = readFromRemote(getLogPath('dispatcher/acme/widgets/5', '1'));
      expect(Buffer.byteLength(pushed, 'utf8')).toBeLessThanOrEqual(MAX_LOG_BYTES);
      expect(pushed).not.toMatch(/�/); // no replacement chars from a mid-character split
      expect(pushed.endsWith('b'.repeat(100))).toBe(true);
    });

    it('does not throw when the-intern-data remote is not configured', async () => {
      const work = newWorkDir('save-no-remote');
      process.chdir(work);
      delete process.env.DATA_REPO_REMOTE_URL;
      const logFile = path.join(tmpRoot, 'run.log');
      fs.writeFileSync(logFile, 'content\n');

      await expect(
        saveRunLog({ prefix: 'dispatcher/acme/widgets/5', runId: '1', logFile })
      ).resolves.toBeUndefined();
    });
  });
});
