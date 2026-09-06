import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLogPath, saveCodexLog, BRANCH_NAME, MAX_LOG_BYTES } from '../manage-codex-log.js';

// Same real-git-against-a-scratch-bare-repo approach as
// manage-workspace-backup.test.js: the-intern-data is simulated by a local
// bare repo pointed to via DATA_REPO_REMOTE_URL.

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

describe('manage-codex-log', () => {
  let originalCwd;
  let tmpRoot;
  let dataRemoteDir;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-log-'));
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
    it('sanitizes non-alphanumeric characters and nests by repo/issue/run', () => {
      expect(getLogPath('acme/weird.repo!name', '7', '12345')).toBe(
        path.join('acme-weird-repo-name', '7', '12345.jsonl')
      );
    });
  });

  describe('saveCodexLog', () => {
    it('pushes the log content to the-intern-data at the expected path', async () => {
      const work = newWorkDir('save-basic');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'codex-events.jsonl');
      fs.writeFileSync(logFile, '{"type":"error","message":"boom"}\n');

      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '999', logFile });

      const relPath = getLogPath('acme/widgets', '5', '999');
      expect(readFromRemote(relPath)).toBe('{"type":"error","message":"boom"}');
    });

    it('leaves the caller checkout untouched (runs in an isolated worktree)', async () => {
      const work = newWorkDir('save-isolated');
      process.chdir(work);
      const branchBefore = sh('git rev-parse --abbrev-ref HEAD', work);
      const logFile = path.join(tmpRoot, 'codex-events.jsonl');
      fs.writeFileSync(logFile, '{"type":"error"}\n');

      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '1', logFile });

      expect(sh('git rev-parse --abbrev-ref HEAD', work)).toBe(branchBefore);
      expect(fs.existsSync(path.join(work, 'acme-widgets'))).toBe(false);
    });

    it('accumulates logs from multiple runs under the same branch', async () => {
      const work = newWorkDir('save-multi');
      process.chdir(work);
      const logFileA = path.join(tmpRoot, 'a.jsonl');
      const logFileB = path.join(tmpRoot, 'b.jsonl');
      fs.writeFileSync(logFileA, 'run a\n');
      fs.writeFileSync(logFileB, 'run b\n');

      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '1', logFile: logFileA });
      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '2', logFile: logFileB });

      expect(readFromRemote(getLogPath('acme/widgets', '5', '1'))).toBe('run a');
      expect(readFromRemote(getLogPath('acme/widgets', '5', '2'))).toBe('run b');
    });

    it('does nothing when targetRepo, issueNumber, or runId is missing', async () => {
      const work = newWorkDir('save-missing-key');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'codex-events.jsonl');
      fs.writeFileSync(logFile, 'content\n');

      await saveCodexLog({ targetRepo: '', issueNumber: '5', runId: '1', logFile });
      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '', runId: '1', logFile });
      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '', logFile });

      expect(sh(`git ls-remote ${dataRemoteDir} ${BRANCH_NAME}`, work)).toBe('');
    });

    it('does nothing when the log file does not exist', async () => {
      const work = newWorkDir('save-missing-file');
      process.chdir(work);

      await saveCodexLog({
        targetRepo: 'acme/widgets',
        issueNumber: '5',
        runId: '1',
        logFile: path.join(tmpRoot, 'does-not-exist.jsonl'),
      });

      expect(sh(`git ls-remote ${dataRemoteDir} ${BRANCH_NAME}`, work)).toBe('');
    });

    it('does nothing when the log file is empty', async () => {
      const work = newWorkDir('save-empty-file');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'empty.jsonl');
      fs.writeFileSync(logFile, '   \n');

      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '1', logFile });

      expect(sh(`git ls-remote ${dataRemoteDir} ${BRANCH_NAME}`, work)).toBe('');
    });

    it('truncates oversized content to a UTF-8-safe boundary, never exceeding MAX_LOG_BYTES', async () => {
      const work = newWorkDir('save-oversized-multibyte');
      process.chdir(work);
      const logFile = path.join(tmpRoot, 'oversized.jsonl');

      // Places a 3-byte multibyte char ('中') straddling the exact byte offset
      // the truncation cut lands on, so the naive `slice(-MAX_LOG_BYTES)` would
      // split it mid-character and produce an invalid UTF-8 tail.
      const pad = 'a'.repeat(100);
      const tail = 'b'.repeat(MAX_LOG_BYTES - 2);
      fs.writeFileSync(logFile, pad + '中' + tail);

      await saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '1', logFile });

      const pushed = readFromRemote(getLogPath('acme/widgets', '5', '1'));
      expect(Buffer.byteLength(pushed, 'utf8')).toBeLessThanOrEqual(MAX_LOG_BYTES);
      expect(pushed).not.toMatch(/�/); // no replacement chars from a mid-character split
      expect(pushed.endsWith('b'.repeat(100))).toBe(true);
    });

    it('does not throw when the-intern-data remote is not configured', async () => {
      const work = newWorkDir('save-no-remote');
      process.chdir(work);
      delete process.env.DATA_REPO_REMOTE_URL;
      const logFile = path.join(tmpRoot, 'codex-events.jsonl');
      fs.writeFileSync(logFile, 'content\n');

      await expect(
        saveCodexLog({ targetRepo: 'acme/widgets', issueNumber: '5', runId: '1', logFile })
      ).resolves.toBeUndefined();
    });
  });
});
