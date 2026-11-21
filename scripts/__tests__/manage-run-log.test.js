import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getLogPath, saveRunLog, pruneRunLogs, redactSecrets, buildHeader, isExpiredDir, BRANCH_NAME, MAX_LOG_BYTES,
} from '../manage-run-log.js';

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
  const NOW = new Date('2026-11-21T12:00:00Z');
  const info = (extra = {}) => ({ runId: '999', attempt: '2', target: 'acme/widgets', issue: '5', status: 'failure', ...extra });

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
    process.chdir(dir);
    return dir;
  }

  const readFromRemote = relPath => sh(`git show ${BRANCH_NAME}:${relPath}`, dataRemoteDir);
  const writeLog = (name, text) => {
    const f = path.join(tmpRoot, name);
    fs.writeFileSync(f, text);
    return f;
  };

  describe('getLogPath', () => {
    it('builds action-logs/<date>/<run>-<attempt>-<slug>-<issue>.log', () => {
      expect(getLogPath({ date: NOW, runId: '12345', attempt: '2', target: 'acme/weird.repo!', issue: '7' })).toBe(
        'action-logs/2026-11-21/12345-2-acme-weird-repo--7.log'
      );
    });

    it('omits the issue segment when absent', () => {
      expect(getLogPath({ date: NOW, runId: '42', attempt: '1', target: 'telegram-session' })).toBe(
        'action-logs/2026-11-21/42-1-telegram-session.log'
      );
    });
  });

  describe('redactSecrets', () => {
    it('masks known token shapes and URL credentials', () => {
      const ghp = 'ghp_' + 'a'.repeat(36);
      const pat = 'github_pat_' + 'B'.repeat(40);
      const out = redactSecrets(
        `tok ${ghp} ${pat} sk-ant-api03-abcdefghijklmnop https://x-access-token:s3cr3tvalue@github.com/a/b.git Authorization: Bearer abcdefghijklmnopqrstuv`,
        {}
      );
      expect(out).not.toMatch(/ghp_a|github_pat_B|sk-ant|s3cr3tvalue|abcdefghijklmnopqrstuv/);
      expect(out).toContain('github.com/a/b.git');
    });

    it('masks private key blocks', () => {
      const out = redactSecrets('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\ny', {});
      expect(out).toBe('x\n***\ny');
    });

    it('masks values of secret-looking env vars but not others', () => {
      const out = redactSecrets('pw=hunter2hunter2 name=public short=abc', {
        MY_SECRET: 'hunter2hunter2',
        PUBLIC_NAME: 'public',
        SOME_TOKEN: 'abc',
      });
      expect(out).toBe('pw=*** name=public short=***');
    });
  });

  describe('add-mask lines', () => {
    it('never leaves the masked value in the log', () => {
      const auth = JSON.stringify({ refresh_token: 'rt_plainvalue123' });
      const b64 = Buffer.from(auth).toString('base64');
      const out = redactSecrets(`a\n::add-mask::${b64}\n::add-mask::rt_plainvalue123\nb`, {});
      expect(out).not.toContain(b64);
      expect(out).not.toContain('rt_plainvalue123');
    });
  });

  describe('isExpiredDir', () => {
    it('expires only valid date dirs older than 7 days', () => {
      expect(isExpiredDir('2026-11-13', NOW)).toBe(true);
      expect(isExpiredDir('2026-11-14', NOW)).toBe(false);
      expect(isExpiredDir('2026-11-21', NOW)).toBe(false);
      expect(isExpiredDir('notes', NOW)).toBe(false);
    });
  });

  describe('buildHeader', () => {
    it('includes run url, trigger, backend/model, target, timestamps, status', () => {
      const h = buildHeader({ runUrl: 'https://github.com/o/r/actions/runs/1', trigger: 'issue_comment', backend: 'claude', model: 'm', target: 'a/b', issue: '3', startedAt: 's', finishedAt: 'f', status: 'cancelled' });
      for (const l of ['# run: https://github.com/o/r/actions/runs/1', '# trigger: issue_comment', '# backend: claude', '# model: m', '# target: a/b#3', '# started: s', '# finished: f', '# status: cancelled']) {
        expect(h).toContain(l);
      }
    });
  });

  describe('saveRunLog', () => {
    it('pushes header + redacted log to the dated path, whatever the status', async () => {
      newWorkDir('save-basic');
      const logFile = writeLog('run.log', 'boom ghp_' + 'z'.repeat(36) + '\n');
      await saveRunLog({ logFile, info: info({ status: 'success' }), env: {}, now: NOW });

      const pushed = readFromRemote('action-logs/2026-11-21/999-2-acme-widgets-5.log');
      expect(pushed).toContain('# status: success');
      expect(pushed).toContain('boom ***');
      expect(pushed).not.toContain('ghp_z');
    });

    it('leaves the caller checkout untouched', async () => {
      const work = newWorkDir('save-isolated');
      const before = sh('git rev-parse --abbrev-ref HEAD', work);
      await saveRunLog({ logFile: writeLog('run.log', 'boom\n'), info: info(), env: {}, now: NOW });
      expect(sh('git rev-parse --abbrev-ref HEAD', work)).toBe(before);
      expect(fs.existsSync(path.join(work, 'action-logs'))).toBe(false);
    });

    it('accumulates logs from multiple runs and keeps appended-step order', async () => {
      newWorkDir('save-multi');
      const a = path.join(tmpRoot, 'a.log');
      fs.appendFileSync(a, 'step one\n');
      fs.appendFileSync(a, 'step two\n');
      await saveRunLog({ logFile: a, info: info({ runId: '1' }), env: {}, now: NOW });
      await saveRunLog({ logFile: writeLog('b.log', 'other\n'), info: info({ runId: '2' }), env: {}, now: NOW });

      expect(readFromRemote('action-logs/2026-11-21/1-2-acme-widgets-5.log')).toMatch(/step one\nstep two$/);
      expect(readFromRemote('action-logs/2026-11-21/2-2-acme-widgets-5.log')).toMatch(/other$/);
    });

    it('does nothing without a runId, a log file, or with an empty log', async () => {
      newWorkDir('save-noop');
      await saveRunLog({ logFile: writeLog('r.log', 'x\n'), info: info({ runId: '' }), env: {}, now: NOW });
      await saveRunLog({ logFile: path.join(tmpRoot, 'missing.log'), info: info(), env: {}, now: NOW });
      await saveRunLog({ logFile: writeLog('e.log', '  \n'), info: info(), env: {}, now: NOW });
      expect(sh(`git ls-remote ${dataRemoteDir} ${BRANCH_NAME}`, tmpRoot)).toBe('');
    });

    it('truncates oversized content to a UTF-8-safe boundary', async () => {
      newWorkDir('save-oversized');
      const logFile = writeLog('big.log', 'a'.repeat(100) + '中' + 'b'.repeat(MAX_LOG_BYTES - 2));
      await saveRunLog({ logFile, info: info(), env: {}, now: NOW });

      const pushed = readFromRemote('action-logs/2026-11-21/999-2-acme-widgets-5.log');
      expect(pushed).not.toMatch(/\uFFFD/);
      expect(pushed.endsWith('b'.repeat(100))).toBe(true);
      expect(Buffer.byteLength(pushed, 'utf8')).toBeLessThanOrEqual(MAX_LOG_BYTES + 1024);
    });

    it('does not throw when the remote is not configured', async () => {
      newWorkDir('save-no-remote');
      delete process.env.DATA_REPO_REMOTE_URL;
      await expect(saveRunLog({ logFile: writeLog('r.log', 'c\n'), info: info(), env: {}, now: NOW })).resolves.toBeUndefined();
    });

    it('does not throw when the push fails', async () => {
      newWorkDir('save-bad-remote');
      process.env.DATA_REPO_REMOTE_URL = path.join(tmpRoot, 'nonexistent.git');
      await expect(saveRunLog({ logFile: writeLog('r.log', 'c\n'), info: info(), env: {}, now: NOW })).resolves.toBeUndefined();
    });
  });

  describe('pruneRunLogs', () => {
    it('deletes day dirs older than 7 days and squashes history to one commit', async () => {
      newWorkDir('prune');
      const old = new Date('2026-11-10T00:00:00Z');
      const fresh = new Date('2026-11-20T00:00:00Z');
      await saveRunLog({ logFile: writeLog('o.log', 'old\n'), info: info({ runId: '1' }), env: {}, now: old });
      await saveRunLog({ logFile: writeLog('f.log', 'fresh\n'), info: info({ runId: '2' }), env: {}, now: fresh });

      const res = await pruneRunLogs({ now: NOW });
      expect(res.deleted).toEqual(['2026-11-10']);
      const files = sh(`git ls-tree -r --name-only ${BRANCH_NAME}`, dataRemoteDir).split('\n');
      expect(files).toEqual(['action-logs/2026-11-20/2-2-acme-widgets-5.log']);
      expect(sh(`git rev-list --count ${BRANCH_NAME}`, dataRemoteDir)).toBe('1');
    });

    it('is a no-op when nothing has expired or the branch is missing', async () => {
      newWorkDir('prune-noop');
      expect((await pruneRunLogs({ now: NOW })).deleted).toEqual([]);
      await saveRunLog({ logFile: writeLog('f.log', 'fresh\n'), info: info(), env: {}, now: NOW });
      const before = sh(`git rev-parse ${BRANCH_NAME}`, dataRemoteDir);
      expect((await pruneRunLogs({ now: NOW })).deleted).toEqual([]);
      expect(sh(`git rev-parse ${BRANCH_NAME}`, dataRemoteDir)).toBe(before);
    });
  });
});
