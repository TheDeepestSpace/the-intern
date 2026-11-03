import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseTrigger } from '../parse-trigger.js';

const ENV_KEYS = [
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_OUTPUT',
  'INPUT_TARGET_REPO',
  'INPUT_PR_NUMBER',
  'INPUT_COMMENT_BODY',
  'INPUT_INSTALLATION_ID',
  'CLEAN_PROMPT_FILE',
];

function writeEventPayload(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-trigger-'));
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

describe('parse-trigger', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('repository_dispatch: issue_comment shape', () => {
    it('extracts repo, issue number, and comment body', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        action: 'issue_comment',
        client_payload: {
          raw: {
            installation: { id: 4242 },
            repository: { full_name: 'acme/widgets' },
            issue: { number: 7, user: { login: 'bob' } },
            comment: { user: { login: 'alice' }, body: '@the-intern-bot please help' },
          },
        },
      });

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/widgets');
      expect(result.issue_number).toBe('7');
      expect(result.comment_body).toBe('@the-intern-bot please help');
      expect(result.installation_id).toBe('4242');
      expect(result.event_type).toBe('issue_comment');
      expect(result.author).toBe('alice');
      expect(result.thread_author).toBe('bob');
      expect(result.on).toBe('issue');
      expect(result.synthesized).toBe(false);
    });
  });

  describe('repository_dispatch: pull_request_review shape', () => {
    it('extracts repo, PR number, and review body', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        client_payload: {
          repository: { full_name: 'acme/widgets' },
          pull_request: { number: 12 },
          review: { body: '@the-intern-bot codex fix the lint errors' },
        },
      });

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/widgets');
      expect(result.issue_number).toBe('12');
      expect(result.comment_body).toBe('@the-intern-bot codex fix the lint errors');
      expect(result.on).toBe('pr');
    });
  });

  describe('repository_dispatch: pull_request_review_comment shape', () => {
    it('extracts repo, PR number, comment body, comment id, and event type', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        action: 'pull_request_review_comment',
        client_payload: {
          raw: {
            action: 'pull_request_review_comment',
            repository: { full_name: 'acme/widgets' },
            pull_request: { number: 3 },
            comment: { id: 555666777, body: '@the-intern-bot agy address this' },
          },
        },
      });

      const result = parseTrigger();

      expect(result.issue_number).toBe('3');
      expect(result.comment_body).toBe('@the-intern-bot agy address this');
      expect(result.comment_id).toBe('555666777');
      expect(result.event_type).toBe('pull_request_review_comment');
      expect(result.on).toBe('review_thread');
    });
  });

  describe('repository_dispatch: check_suite (ci_failure) shape', () => {
    it('synthesizes a comment body from the check_suite conclusion, URL, and head sha, with a staleness-check instruction', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        action: 'ci_failure',
        client_payload: {
          raw: {
            installation: { id: 4242 },
            repository: { full_name: 'acme/widgets' },
            pull_request: { number: 9 },
            check_suite: {
              conclusion: 'failure',
              html_url: 'https://github.com/acme/widgets/pull/9/checks',
              head_sha: 'deadbeef1234',
            },
          },
        },
      });

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/widgets');
      expect(result.issue_number).toBe('9');
      expect(result.installation_id).toBe('4242');
      expect(result.event_type).toBe('ci_failure');
      expect(result.comment_body).toBe(
        "CI is failing on this PR (conclusion: failure). Check suite: https://github.com/acme/widgets/pull/9/checks. This check suite ran against commit `deadbeef1234`. Before investigating, compare that commit to the PR's current head (e.g. `gh pr view 9 --json headRefOid`). If the PR's head has already moved past `deadbeef1234`, this failure is stale - a newer commit supersedes it, so stop immediately without commenting or pushing anything. Otherwise, investigate the failing checks and push a fix."
      );
      expect(result.synthesized).toBe(true);
    });

    it('falls back to a stop-without-acting instruction when check_suite.head_sha is absent', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        action: 'ci_failure',
        client_payload: {
          raw: {
            installation: { id: 4242 },
            repository: { full_name: 'acme/widgets' },
            pull_request: { number: 9 },
            check_suite: {
              conclusion: 'failure',
              html_url: 'https://github.com/acme/widgets/pull/9/checks',
            },
          },
        },
      });

      const result = parseTrigger();

      expect(result.comment_body).toBe(
        "CI is failing on this PR (conclusion: failure). Check suite: https://github.com/acme/widgets/pull/9/checks. This check suite's failing commit could not be determined, so staleness can't be safely verified - stop immediately without investigating, commenting, or pushing anything."
      );
      expect(result.comment_body).not.toContain('``');
    });
  });

  describe('repository_dispatch: coderabbit_review shape', () => {
    it('synthesizes a comment body from the review URL, without reading the review body', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        action: 'coderabbit_review',
        client_payload: {
          raw: {
            installation: { id: 4242 },
            repository: { full_name: 'acme/widgets' },
            pull_request: { number: 9 },
            coderabbit_review: {
              html_url: 'https://github.com/acme/widgets/pull/9#pullrequestreview-1',
            },
          },
        },
      });

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/widgets');
      expect(result.issue_number).toBe('9');
      expect(result.installation_id).toBe('4242');
      expect(result.event_type).toBe('coderabbit_review');
      expect(result.comment_body).toBe(
        'CodeRabbit posted a review on PR #9 (https://github.com/acme/widgets/pull/9#pullrequestreview-1). Read it and address any actionable feedback.'
      );
      expect(result.synthesized).toBe(true);
    });
  });

  describe('repository_dispatch: merge_conflict shape', () => {
    it('synthesizes a comment body from the mergeable_state and base ref', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        action: 'merge_conflict',
        client_payload: {
          raw: {
            installation: { id: 4242 },
            repository: { full_name: 'acme/widgets' },
            pull_request: { number: 9 },
            merge_conflict: { mergeable_state: 'dirty', base_ref: 'main' },
          },
        },
      });

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/widgets');
      expect(result.issue_number).toBe('9');
      expect(result.installation_id).toBe('4242');
      expect(result.event_type).toBe('merge_conflict');
      expect(result.comment_body).toBe(
        "A push to main left this PR unmergeable (mergeable_state: dirty). Merge or rebase the latest default branch into this PR's branch, resolve the conflicts, and push the fix."
      );
      expect(result.synthesized).toBe(true);
    });
  });

  describe('repository_dispatch: fallback extraction', () => {
    it('falls back to INPUT_* env vars when payload has no recognizable shape', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.INPUT_TARGET_REPO = 'acme/fallback-repo';
      process.env.INPUT_PR_NUMBER = '99';
      process.env.INPUT_COMMENT_BODY = 'fallback prompt text';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({ client_payload: {} });

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/fallback-repo');
      expect(result.issue_number).toBe('99');
      expect(result.comment_body).toBe('fallback prompt text');
    });

    it('falls back when GITHUB_EVENT_PATH is absent entirely', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.INPUT_TARGET_REPO = 'acme/no-payload';
      process.env.INPUT_PR_NUMBER = '1';
      process.env.INPUT_COMMENT_BODY = 'hello';

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/no-payload');
      expect(result.issue_number).toBe('1');
      expect(result.comment_body).toBe('hello');
    });
  });

  describe('workflow_dispatch', () => {
    it('reads target repo, PR number, comment body, and installation id from INPUT_* vars', () => {
      process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
      process.env.INPUT_TARGET_REPO = 'acme/manual-run';
      process.env.INPUT_PR_NUMBER = '55';
      process.env.INPUT_COMMENT_BODY = 'manual dispatch body';
      process.env.INPUT_INSTALLATION_ID = '777';

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/manual-run');
      expect(result.issue_number).toBe('55');
      expect(result.comment_body).toBe('manual dispatch body');
      expect(result.installation_id).toBe('777');
      expect(result.event_type).toBe('');
    });
  });

  describe('unrecognized event name', () => {
    it('returns all-empty defaults', () => {
      process.env.GITHUB_EVENT_NAME = 'push';

      const result = parseTrigger();

      expect(result.target_repo).toBe('');
      expect(result.issue_number).toBe('');
      expect(result.comment_body).toBe('');
      expect(result.synthesized).toBe(false);
    });
  });
});
