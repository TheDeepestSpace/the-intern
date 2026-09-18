import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatTokenCount,
  buildTable,
  buildSection,
  upsertReadme,
  getDefaultBranch,
  main,
} from '../update-model-list.js';

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: process.env }).trim();
}

function initBareRemote(dir, defaultBranch = 'main') {
  fs.mkdirSync(dir, { recursive: true });
  sh(`git init --bare -b ${defaultBranch} .`, dir);
}

// Seeds the bare remote with an initial README (or no README at all) by
// pushing from a scratch work repo, mirroring how manage-summaries.test.js
// and cleanup-data-branches.test.js simulate the-intern-data.
function seedRemote(remoteDir, tmpRoot, name, readmeContent, defaultBranch = 'main') {
  const work = path.join(tmpRoot, name);
  fs.mkdirSync(work, { recursive: true });
  sh(`git init -b ${defaultBranch} .`, work);
  sh('git config user.name "test"', work);
  sh('git config user.email "test@example.com"', work);
  if (readmeContent !== null) {
    fs.writeFileSync(path.join(work, 'README.md'), readmeContent);
    sh('git add README.md', work);
  } else {
    fs.writeFileSync(path.join(work, '.gitkeep'), '');
    sh('git add .gitkeep', work);
  }
  sh('git commit -m "initial commit"', work);
  sh(`git push "${remoteDir}" ${defaultBranch}:${defaultBranch} -q`, work);
}

// Simulates the-intern-data's default branch being protected: a
// pre-receive hook rejects any push that updates refs/heads/<branch>
// directly, but pushes creating a *new* ref (our short-lived branch) go
// through untouched — the same shape a real GitHub branch-protection rule
// produces.
function protectBranch(remoteDir, branch) {
  const hooksDir = path.join(remoteDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-receive');
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh\nwhile read oldrev newrev refname; do\n  if [ "$refname" = "refs/heads/${branch}" ]; then\n    echo "remote: protected branch" >&2\n    exit 1\n  fi\ndone\nexit 0\n`
  );
  fs.chmodSync(hookPath, 0o755);
}

const MODELS = [
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000, max_tokens: 64_000 },
];

function fakeFetchModelsFn(models = MODELS) {
  return vi.fn(async () => models);
}

describe('formatTokenCount', () => {
  it('formats whole millions as M', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
  });

  it('formats whole thousands as K', () => {
    expect(formatTokenCount(200_000)).toBe('200K');
  });

  it('falls back to the raw number when not a round thousand', () => {
    expect(formatTokenCount(1234)).toBe('1234');
  });

  it('returns an em dash for missing/non-numeric values', () => {
    expect(formatTokenCount(undefined)).toBe('—');
    expect(formatTokenCount(null)).toBe('—');
    expect(formatTokenCount(NaN)).toBe('—');
  });
});

describe('buildTable', () => {
  it('renders one row per model with the model= ID backticked', () => {
    const table = buildTable(MODELS);
    expect(table).toContain('| Claude Opus 5 | `claude-opus-5` | 1M | 128K |');
    expect(table).toContain('| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | 64K |');
  });

  it('falls back to the bare id when display_name is missing', () => {
    const table = buildTable([{ id: 'claude-x', max_input_tokens: 1000, max_tokens: 1000 }]);
    expect(table).toContain('| claude-x | `claude-x` | 1K | 1K |');
  });
});

describe('upsertReadme', () => {
  it('appends a new AUTO-GENERATED block when the README has none yet', () => {
    const section = buildSection(MODELS, '2026-08-18T09:00:00.000Z');
    const { content, changed } = upsertReadme('# the-intern-data\n', section);
    expect(changed).toBe(true);
    expect(content).toContain('# the-intern-data');
    expect(content).toContain(section);
  });

  it('replaces only the marker-delimited block, leaving surrounding content untouched', () => {
    const oldSection = buildSection(MODELS, '2026-08-01T00:00:00.000Z');
    const readme = `# the-intern-data\n\nSome human-written intro.\n\n${oldSection}\n\nA trailing human note.\n`;
    const newModels = [...MODELS, { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', max_input_tokens: 1_000_000, max_tokens: 128_000 }];
    const newSection = buildSection(newModels, '2026-08-18T09:00:00.000Z');

    const { content, changed } = upsertReadme(readme, newSection);
    expect(changed).toBe(true);
    expect(content).toContain('Some human-written intro.');
    expect(content).toContain('A trailing human note.');
    expect(content).toContain('claude-sonnet-5');
    expect(content).not.toContain('2026-08-01T00:00:00.000Z');
  });

  it('is idempotent: identical model data produces changed=false regardless of timestamp', () => {
    const readme = `# the-intern-data\n\n${buildSection(MODELS, '2026-08-01T00:00:00.000Z')}\n`;
    const { changed } = upsertReadme(readme, buildSection(MODELS, '2026-08-18T09:00:00.000Z'));
    expect(changed).toBe(false);
  });

  it('reports changed=true when the model table content actually differs', () => {
    const readme = `# the-intern-data\n\n${buildSection(MODELS, '2026-08-01T00:00:00.000Z')}\n`;
    const differentModels = [MODELS[0]];
    const { changed } = upsertReadme(readme, buildSection(differentModels, '2026-08-18T09:00:00.000Z'));
    expect(changed).toBe(true);
  });
});

describe('getDefaultBranch', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'update-model-list-defbranch-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads the symbolic HEAD ref off a bare remote', () => {
    const remoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(remoteDir, 'trunk');
    // HEAD is unborn until something is pushed, so ls-remote --symref
    // reports nothing on a freshly-initialized bare repo — seed one commit.
    seedRemote(remoteDir, tmpRoot, 'seed-defbranch', '# scratch\n', 'trunk');
    expect(getDefaultBranch(remoteDir)).toBe('trunk');
  });
});

describe('main (orchestration)', () => {
  let tmpRoot;
  let dataRemoteDir;

  beforeEach(() => {
    process.exitCode = 0;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'update-model-list-main-'));
    dataRemoteDir = path.join(tmpRoot, 'data-remote.git');
    initBareRemote(dataRemoteDir);
    process.env.DATA_REPO_REMOTE_URL = dataRemoteDir;
  });

  afterEach(() => {
    process.exitCode = 0;
    delete process.env.DATA_REPO_REMOTE_URL;
    delete process.env.DATA_REPO_TOKEN;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('errors out up front when ANTHROPIC_API_KEY is missing', async () => {
    await main({}, {});
    expect(process.exitCode).toBe(1);
  });

  it('errors out up front when the-intern-data remote is not configured', async () => {
    delete process.env.DATA_REPO_REMOTE_URL;
    await main({ ANTHROPIC_API_KEY: 'key' }, {});
    expect(process.exitCode).toBe(1);
  });

  it('fails loudly and never touches the README when the Models API call fails', async () => {
    seedRemote(dataRemoteDir, tmpRoot, 'seed', '# the-intern-data\n');
    const fetchModelsFn = vi.fn(async () => {
      throw new Error('network blip');
    });

    await main({ ANTHROPIC_API_KEY: 'key' }, { fetchModelsFn });

    expect(process.exitCode).toBe(1);
    const check = path.join(tmpRoot, 'check');
    fs.mkdirSync(check, { recursive: true });
    sh(`git clone -q "${dataRemoteDir}" .`, check);
    expect(fs.readFileSync(path.join(check, 'README.md'), 'utf8')).toBe('# the-intern-data\n');
  });

  it('fails loudly on an empty models list instead of writing an empty table', async () => {
    seedRemote(dataRemoteDir, tmpRoot, 'seed', '# the-intern-data\n');
    await main({ ANTHROPIC_API_KEY: 'key' }, { fetchModelsFn: fakeFetchModelsFn([]) });
    expect(process.exitCode).toBe(1);
  });

  it('pushes the update directly to the default branch when it is unprotected', async () => {
    seedRemote(dataRemoteDir, tmpRoot, 'seed', '# the-intern-data\n\nOne line description.\n');

    await main({ ANTHROPIC_API_KEY: 'key' }, { fetchModelsFn: fakeFetchModelsFn() });

    expect(process.exitCode).toBe(0);
    const check = path.join(tmpRoot, 'check');
    fs.mkdirSync(check, { recursive: true });
    sh(`git clone -q "${dataRemoteDir}" .`, check);
    const readme = fs.readFileSync(path.join(check, 'README.md'), 'utf8');
    expect(readme).toContain('One line description.');
    expect(readme).toContain('claude-opus-5');
    expect(readme).toContain('## Current Claude Models');

    // The short-lived staging branch should be cleaned up once the direct
    // push lands, so it doesn't accumulate forever like the branches
    // cleanup-data-branches.yml exists to prune.
    const branches = sh('git ls-remote --heads .', dataRemoteDir);
    expect(branches).not.toMatch(/update-model-list-\d{4}-\d{2}-\d{2}/);
  });

  it('is a true no-op on a second run with no upstream model changes', async () => {
    seedRemote(dataRemoteDir, tmpRoot, 'seed', '# the-intern-data\n');

    await main({ ANTHROPIC_API_KEY: 'key' }, { fetchModelsFn: fakeFetchModelsFn() });
    const shaAfterFirst = sh('git rev-parse main', dataRemoteDir);

    await main({ ANTHROPIC_API_KEY: 'key' }, { fetchModelsFn: fakeFetchModelsFn() });
    const shaAfterSecond = sh('git rev-parse main', dataRemoteDir);

    expect(process.exitCode).toBe(0);
    expect(shaAfterSecond).toBe(shaAfterFirst);
  });

  it('falls back to opening (and merging) a PR when the default branch is protected', async () => {
    seedRemote(dataRemoteDir, tmpRoot, 'seed', '# the-intern-data\n');
    protectBranch(dataRemoteDir, 'main');
    process.env.DATA_REPO_TOKEN = 'tok';

    const createPullRequestFn = vi.fn(async (token, { title, head, base }) => {
      expect(token).toBe('tok');
      expect(head).toMatch(/^update-model-list-\d{4}-\d{2}-\d{2}$/);
      expect(base).toBe('main');
      expect(title).toContain('Update Claude model list');
      return { number: 42 };
    });
    const mergePullRequestFn = vi.fn(async (token, number) => {
      expect(token).toBe('tok');
      expect(number).toBe(42);
      return {};
    });

    await main(
      { ANTHROPIC_API_KEY: 'key', DATA_REPO_TOKEN: 'tok' },
      { fetchModelsFn: fakeFetchModelsFn(), createPullRequestFn, mergePullRequestFn }
    );

    expect(process.exitCode).toBe(0);
    expect(createPullRequestFn).toHaveBeenCalledTimes(1);
    expect(mergePullRequestFn).toHaveBeenCalledTimes(1);

    // The default branch itself must be untouched by the rejected push —
    // only the short-lived branch should exist on the remote (the PR merge
    // itself is mocked, so it never lands here).
    // sh() trims trailing whitespace from command output, so compare
    // against the trimmed form rather than the exact on-disk bytes.
    const readmeOnMain = sh('git show main:README.md', dataRemoteDir);
    expect(readmeOnMain).toBe('# the-intern-data');
    const branches = sh('git ls-remote --heads .', dataRemoteDir);
    expect(branches).toMatch(/update-model-list-\d{4}-\d{2}-\d{2}/);
  });

  it('leaves the PR open without failing the run when auto-merge is rejected', async () => {
    seedRemote(dataRemoteDir, tmpRoot, 'seed', '# the-intern-data\n');
    protectBranch(dataRemoteDir, 'main');
    process.env.DATA_REPO_TOKEN = 'tok';

    const createPullRequestFn = vi.fn(async () => ({ number: 7 }));
    const mergePullRequestFn = vi.fn(async () => {
      throw new Error('merge PR failed (405): at least 1 approving review is required');
    });

    await main(
      { ANTHROPIC_API_KEY: 'key', DATA_REPO_TOKEN: 'tok' },
      { fetchModelsFn: fakeFetchModelsFn(), createPullRequestFn, mergePullRequestFn }
    );

    expect(process.exitCode).toBe(0);
    expect(createPullRequestFn).toHaveBeenCalledTimes(1);
    expect(mergePullRequestFn).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the branch is protected and no DATA_REPO_TOKEN is available for the PR fallback', async () => {
    seedRemote(dataRemoteDir, tmpRoot, 'seed', '# the-intern-data\n');
    protectBranch(dataRemoteDir, 'main');
    delete process.env.DATA_REPO_TOKEN;

    await main({ ANTHROPIC_API_KEY: 'key' }, { fetchModelsFn: fakeFetchModelsFn() });

    expect(process.exitCode).toBe(1);
  });
});
