import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { run, resolveContainerEnv, appendToGithubEnv } from '../run-devcontainer-containerenv.js';

describe('run-devcontainer-containerenv', () => {
  let tmpDir;
  let githubEnvPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcontainer-containerenv-'));
    githubEnvPath = path.join(tmpDir, 'github_env');
    fs.writeFileSync(githubEnvPath, '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeDevcontainer(content) {
    const dir = path.join(tmpDir, '.devcontainer');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'devcontainer.json'), content);
  }

  it('writes resolved containerEnv vars to GITHUB_ENV in KEY<<EOF form', () => {
    writeDevcontainer(JSON.stringify({ containerEnv: { SVSCH_LOCAL_NO_VIDEO: '1' } }));

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn: () => {} });

    expect(result).toEqual({ loaded: true, ok: true, keys: ['SVSCH_LOCAL_NO_VIDEO'] });
    const written = fs.readFileSync(githubEnvPath, 'utf8');
    expect(written).toMatch(/^SVSCH_LOCAL_NO_VIDEO<<GHENV_\w+\n1\nGHENV_\w+\n$/);
  });

  it('substitutes ${containerWorkspaceFolder} in containerEnv values', () => {
    writeDevcontainer(JSON.stringify({ containerEnv: { WORKSPACE: '${containerWorkspaceFolder}/dist' } }));

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn: () => {} });

    expect(result).toEqual({ loaded: true, ok: true, keys: ['WORKSPACE'] });
    const written = fs.readFileSync(githubEnvPath, 'utf8');
    expect(written).toContain(`${tmpDir}/dist`);
  });

  it('no-ops silently when there is no devcontainer.json', () => {
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn });

    expect(result).toEqual({ loaded: false, reason: 'missing-file' });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('no-ops silently when devcontainer.json has no containerEnv field', () => {
    writeDevcontainer(JSON.stringify({ name: 'test-devcontainer', image: 'node:20' }));
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn });

    expect(result).toEqual({ loaded: false, reason: 'no-container-env' });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and skips (non-fatally) on malformed JSON', () => {
    writeDevcontainer('{ "containerEnv": { "FOO": "bar" } ');
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn });

    expect(result).toEqual({ loaded: false, reason: 'parse-error' });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('::warning::');
  });

  it('warns and skips on an unsupported containerEnv shape (array form)', () => {
    writeDevcontainer(JSON.stringify({ containerEnv: ['FOO=bar'] }));
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn });

    expect(result).toEqual({ loaded: false, reason: 'unsupported-shape' });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe('');
    expect(warn.mock.calls[0][0]).toContain('::warning::');
  });

  it('warns and skips a value referencing an unsupported host-side variable instead of exporting it literally', () => {
    writeDevcontainer(JSON.stringify({ containerEnv: { FOO: '${localEnv:HOME}' } }));
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn });

    expect(result).toEqual({ loaded: true, ok: false, keys: [] });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe('');
    expect(warn.mock.calls[0][0]).toContain('::warning::');
    expect(warn.mock.calls[0][0]).toContain('${localEnv:HOME}');
  });

  it('warns and skips a non-string value instead of coercing it', () => {
    writeDevcontainer(JSON.stringify({ containerEnv: { FOO: 1 } }));
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn });

    expect(result).toEqual({ loaded: true, ok: false, keys: [] });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe('');
    expect(warn.mock.calls[0][0]).toContain('::warning::');
  });

  it('exports the supported vars and warns about the unsupported ones when mixed', () => {
    writeDevcontainer(
      JSON.stringify({ containerEnv: { GOOD: 'value', BAD: '${localEnv:HOME}' } })
    );
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn });

    expect(result).toEqual({ loaded: true, ok: false, keys: ['GOOD'] });
    const written = fs.readFileSync(githubEnvPath, 'utf8');
    expect(written).toContain('GOOD<<');
    expect(written).not.toContain('BAD<<');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns when GITHUB_ENV is not available and there are vars to export', () => {
    writeDevcontainer(JSON.stringify({ containerEnv: { FOO: 'bar' } }));
    const warn = vi.fn();
    const originalGithubEnv = process.env.GITHUB_ENV;
    delete process.env.GITHUB_ENV;

    try {
      const result = run({ targetDir: tmpDir, log: () => {}, warn });
      expect(result).toEqual({ loaded: true, ok: false, keys: [] });
      expect(warn.mock.calls[0][0]).toContain('::warning::');
      expect(warn.mock.calls[0][0]).toContain('GITHUB_ENV');
    } finally {
      if (originalGithubEnv === undefined) delete process.env.GITHUB_ENV;
      else process.env.GITHUB_ENV = originalGithubEnv;
    }
  });

  it('is JSONC-tolerant: strips // and /* */ comments and trailing commas before parsing', () => {
    const jsonc = [
      '{',
      '  // line comment',
      '  "name": "test", /* block comment */',
      '  "containerEnv": { "FOO": "bar", },',
      '}',
    ].join('\n');
    writeDevcontainer(jsonc);

    const result = run({ targetDir: tmpDir, githubEnvPath, log: () => {}, warn: () => {} });

    expect(result).toEqual({ loaded: true, ok: true, keys: ['FOO'] });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toContain('FOO<<');
  });
});

describe('resolveContainerEnv', () => {
  it('substitutes containerWorkspaceFolder and passes plain values through', () => {
    const { resolved, skipped } = resolveContainerEnv(
      { A: 'plain', B: '${containerWorkspaceFolder}/x' },
      '/work/target'
    );
    expect(resolved).toEqual({ A: 'plain', B: '/work/target/x' });
    expect(skipped).toEqual([]);
  });

  it('flags an unsupported host-side variable without including it in resolved', () => {
    const { resolved, skipped } = resolveContainerEnv({ A: 'echo ${localWorkspaceFolder}' }, '/work/target');
    expect(resolved).toEqual({});
    expect(skipped).toEqual([{ key: 'A', reason: 'unsupported-variable', unsupported: ['${localWorkspaceFolder}'] }]);
  });

  it('flags a non-string value without including it in resolved', () => {
    const { resolved, skipped } = resolveContainerEnv({ A: 42 }, '/work/target');
    expect(resolved).toEqual({});
    expect(skipped).toEqual([{ key: 'A', reason: 'non-string-value' }]);
  });
});

describe('appendToGithubEnv', () => {
  it('appends each key using a unique KEY<<DELIMITER/value/DELIMITER block', () => {
    const appendFn = vi.fn();

    appendToGithubEnv({ A: 'one', B: 'two' }, '/tmp/fake-github-env', appendFn);

    expect(appendFn).toHaveBeenCalledTimes(2);
    const [path1, block1] = appendFn.mock.calls[0];
    const [path2, block2] = appendFn.mock.calls[1];
    expect(path1).toBe('/tmp/fake-github-env');
    expect(path2).toBe('/tmp/fake-github-env');
    expect(block1).toMatch(/^A<<GHENV_\w+\none\nGHENV_\w+\n$/);
    expect(block2).toMatch(/^B<<GHENV_\w+\ntwo\nGHENV_\w+\n$/);
  });
});
