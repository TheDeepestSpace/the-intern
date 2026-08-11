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
            issue: { number: 7 },
            comment: { body: '@the-intern-bot please help' },
          },
        },
      });

      const result = parseTrigger();

      expect(result.target_repo).toBe('acme/widgets');
      expect(result.issue_number).toBe('7');
      expect(result.comment_body).toBe('@the-intern-bot please help');
      expect(result.installation_id).toBe('4242');
      expect(result.event_type).toBe('issue_comment');
      expect(result.clean_prompt).toBe('please help');
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
      expect(result.clean_prompt).toBe('fix the lint errors');
    });
  });

  describe('repository_dispatch: pull_request_review_comment shape', () => {
    it('extracts repo, PR number, and comment body', () => {
      process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
      process.env.GITHUB_EVENT_PATH = writeEventPayload({
        client_payload: {
          repository: { full_name: 'acme/widgets' },
          pull_request: { number: 3 },
          comment: { body: '@the-intern-bot agy address this' },
        },
      });

      const result = parseTrigger();

      expect(result.issue_number).toBe('3');
      expect(result.comment_body).toBe('@the-intern-bot agy address this');
    });
  });

  describe('repository_dispatch: check_suite (ci_failure) shape', () => {
    it('synthesizes a comment body from the check_suite conclusion and URL', () => {
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

      expect(result.target_repo).toBe('acme/widgets');
      expect(result.issue_number).toBe('9');
      expect(result.installation_id).toBe('4242');
      expect(result.event_type).toBe('ci_failure');
      expect(result.comment_body).toBe(
        'CI is failing on this PR (conclusion: failure). Check suite: https://github.com/acme/widgets/pull/9/checks. Investigate the failing checks and push a fix.'
      );
      expect(result.clean_prompt).toBe(result.comment_body);
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
      expect(result.clean_prompt).toBe(result.comment_body);
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
      expect(result.clean_prompt).toBe(result.comment_body);
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
      expect(result.clean_prompt).toBe('Please inspect the context and assist with this issue or pull request.');
    });
  });

  describe('backend/model/effort keyword extraction', () => {
    beforeEach(() => {
      process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
      process.env.INPUT_TARGET_REPO = 'acme/widgets';
      process.env.INPUT_PR_NUMBER = '1';
    });

    it('extracts backend=, model=, and effort= and strips them from the prompt', () => {
      process.env.INPUT_COMMENT_BODY =
        '@the-intern-bot backend=codex model=gpt-5 effort=high please refactor the parser';

      const result = parseTrigger();

      expect(result.backend).toBe('codex');
      expect(result.backend_explicit).toBe(true);
      expect(result.model).toBe('gpt-5');
      expect(result.effort).toBe('high');
      expect(result.clean_prompt).toBe('please refactor the parser');
    });

    it('defaults backend/model/effort when not present', () => {
      process.env.INPUT_COMMENT_BODY = '@the-intern-bot just look at this';

      const result = parseTrigger();

      expect(result.backend).toBe('claude');
      expect(result.backend_explicit).toBe(false);
      expect(result.model).toBe('default');
      expect(result.effort).toBe('default');
      expect(result.clean_prompt).toBe('just look at this');
    });

    it('strips a recognized backend keyword directly after the mention', () => {
      process.env.INPUT_COMMENT_BODY = '@the-intern-bot codex fix this please';

      const result = parseTrigger();

      // Only backend= key=value form sets `backend`; the bare mention keyword
      // is stripped from the comment but does not itself set backend.
      expect(result.backend).toBe('claude');
      expect(result.clean_prompt).toBe('fix this please');
    });

    it('falls back to the default prompt when the comment is empty after stripping', () => {
      process.env.INPUT_COMMENT_BODY = '@the-intern-bot claude';

      const result = parseTrigger();

      expect(result.clean_prompt).toBe('Please inspect the context and assist with this issue or pull request.');
    });

    it('does not strip key=value text that appears later in the prompt, only leading control tokens', () => {
      process.env.INPUT_COMMENT_BODY =
        '@the-intern-bot add `-c model="sol" -c model_reasoning_effort="xhigh"` to the codex exec invocation';

      const result = parseTrigger();

      expect(result.model).toBe('default');
      expect(result.clean_prompt).toBe(
        'add `-c model="sol" -c model_reasoning_effort="xhigh"` to the codex exec invocation'
      );
    });

    it('extracts leading control tokens regardless of order and leaves the rest of the prompt intact', () => {
      process.env.INPUT_COMMENT_BODY =
        '@the-intern-bot effort=high backend=codex model=sol fix backend=legacy references in the docs';

      const result = parseTrigger();

      expect(result.backend).toBe('codex');
      expect(result.model).toBe('sol');
      expect(result.effort).toBe('high');
      expect(result.clean_prompt).toBe('fix backend=legacy references in the docs');
    });
  });

  describe('GITHUB_OUTPUT writing', () => {
    it('writes key=value pairs for single-line values', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-output-'));
      const outputFile = path.join(dir, 'output');
      fs.writeFileSync(outputFile, '');
      process.env.GITHUB_OUTPUT = outputFile;
      process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
      process.env.INPUT_TARGET_REPO = 'acme/widgets';
      process.env.INPUT_PR_NUMBER = '1';
      process.env.INPUT_COMMENT_BODY = 'do the thing';

      parseTrigger();

      const contents = fs.readFileSync(outputFile, 'utf8');
      expect(contents).toContain('target_repo=acme/widgets');
      expect(contents).toContain('issue_number=1');
      expect(contents).toContain('backend=claude');
    });

    it('uses a heredoc-style delimiter for multi-line values', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-output-'));
      const outputFile = path.join(dir, 'output');
      fs.writeFileSync(outputFile, '');
      process.env.GITHUB_OUTPUT = outputFile;
      process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
      process.env.INPUT_TARGET_REPO = 'acme/widgets';
      process.env.INPUT_PR_NUMBER = '1';
      process.env.INPUT_COMMENT_BODY = 'line one\nline two';

      parseTrigger();

      const contents = fs.readFileSync(outputFile, 'utf8');
      expect(contents).toMatch(/comment_body<<EOF_\w+\nline one\nline two\nEOF_\w+\n/);
    });
  });
});
