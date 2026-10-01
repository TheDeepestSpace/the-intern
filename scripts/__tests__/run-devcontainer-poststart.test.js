import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { run, stripJsonComments, parseJsonc, substituteVariables, shellQuote } from '../run-devcontainer-poststart.js';

describe('run-devcontainer-poststart', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcontainer-poststart-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeDevcontainer(content) {
    const dir = path.join(tmpDir, '.devcontainer');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'devcontainer.json'), content);
  }

  it('runs a string-form postStartCommand as the dev user via su', () => {
    writeDevcontainer(JSON.stringify({ postStartCommand: 'npm install' }));
    const execFn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn: () => {} });

    expect(result).toEqual({ ran: true, ok: true });
    expect(execFn).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFn.mock.calls[0];
    expect(file).toBe('su');
    expect(args).toEqual(['dev', '-c', 'npm install']);
    expect(options.cwd).toBe(tmpDir);
  });

  it('runs an array-of-strings postStartCommand, quoting each arg for the shell', () => {
    writeDevcontainer(JSON.stringify({ postStartCommand: ['npx', 'playwright', 'install', '--with-deps', 'chromium'] }));
    const execFn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn: () => {} });

    expect(result).toEqual({ ran: true, ok: true });
    const [, args] = execFn.mock.calls[0];
    expect(args).toEqual(['dev', '-c', "'npx' 'playwright' 'install' '--with-deps' 'chromium'"]);
  });

  it('no-ops silently when there is no devcontainer.json', () => {
    const execFn = vi.fn();
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn });

    expect(result).toEqual({ ran: false, reason: 'missing-file' });
    expect(execFn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('no-ops silently when devcontainer.json has no postStartCommand field', () => {
    writeDevcontainer(JSON.stringify({ name: 'test-devcontainer', image: 'node:20' }));
    const execFn = vi.fn();
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn });

    expect(result).toEqual({ ran: false, reason: 'no-command' });
    expect(execFn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and skips (non-fatally) on malformed JSON', () => {
    writeDevcontainer('{ "postStartCommand": "npm install" ');
    const execFn = vi.fn();
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('parse-error');
    expect(execFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('::warning::');
  });

  it('warns and skips on an unsupported postStartCommand shape (object form)', () => {
    writeDevcontainer(JSON.stringify({ postStartCommand: { server: 'npm run server', worker: 'npm run worker' } }));
    const execFn = vi.fn();
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn });

    expect(result).toEqual({ ran: false, reason: 'unsupported-shape' });
    expect(execFn).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('::warning::');
  });

  it('substitutes ${containerWorkspaceFolder} with the actual target checkout path (svsch\'s real postStartCommand)', () => {
    writeDevcontainer(
      JSON.stringify({
        postStartCommand: "bash -c '.devcontainer/scripts/post-start.sh ${containerWorkspaceFolder}'",
      })
    );
    const execFn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn: () => {} });

    expect(result).toEqual({ ran: true, ok: true });
    const [, args] = execFn.mock.calls[0];
    expect(args).toEqual(['dev', '-c', `bash -c '.devcontainer/scripts/post-start.sh ${tmpDir}'`]);
  });

  it('warns and skips a command referencing an unsupported host-side variable instead of running it literally', () => {
    writeDevcontainer(JSON.stringify({ postStartCommand: 'echo ${localWorkspaceFolder}' }));
    const execFn = vi.fn();
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn });

    expect(result).toEqual({ ran: true, ok: false });
    expect(execFn).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('::warning::');
    expect(warn.mock.calls[0][0]).toContain('${localWorkspaceFolder}');
  });

  it('logs a warning but does not throw when the command exits non-zero', () => {
    writeDevcontainer(JSON.stringify({ postStartCommand: 'exit 1' }));
    const execFn = vi.fn(() => {
      throw Object.assign(new Error('Command failed: su'), { status: 1 });
    });
    const warn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn });

    expect(result).toEqual({ ran: true, ok: false });
    expect(warn.mock.calls[0][0]).toContain('::warning::');
  });

  it('is JSONC-tolerant: strips // and /* */ comments and trailing commas before parsing', () => {
    const jsonc = [
      '{',
      '  // line comment',
      '  "name": "test", /* block comment */',
      '  "postStartCommand": "npm install",',
      '}',
    ].join('\n');
    writeDevcontainer(jsonc);
    const execFn = vi.fn();

    const result = run({ targetDir: tmpDir, execFn, log: () => {}, warn: () => {} });

    expect(result).toEqual({ ran: true, ok: true });
    expect(execFn.mock.calls[0][1]).toEqual(['dev', '-c', 'npm install']);
  });
});

describe('stripJsonComments', () => {
  it('preserves // and /* inside string values', () => {
    const input = '{"url": "https://example.com", "note": "/* not a comment */"}';
    expect(stripJsonComments(input)).toBe(input);
  });

  it('strips a line comment without eating the following line', () => {
    const input = '{\n  "a": 1, // comment\n  "b": 2\n}';
    const stripped = stripJsonComments(input);
    expect(JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'))).toEqual({ a: 1, b: 2 });
  });
});

describe('parseJsonc', () => {
  it('parses plain JSON unchanged', () => {
    expect(parseJsonc('{"postStartCommand": "npm install"}')).toEqual({ postStartCommand: 'npm install' });
  });

  it('throws on genuinely malformed input', () => {
    expect(() => parseJsonc('{ not json')).toThrow();
  });
});

describe('substituteVariables', () => {
  it('substitutes containerWorkspaceFolder', () => {
    const result = substituteVariables('cd ${containerWorkspaceFolder} && npm install', '/work/target');
    expect(result).toEqual({ ok: true, value: 'cd /work/target && npm install' });
  });

  it('flags any other remaining ${...} variable as unsupported', () => {
    const result = substituteVariables('echo ${localEnv:HOME}', '/work/target');
    expect(result.ok).toBe(false);
    expect(result.unsupported).toEqual(['${localEnv:HOME}']);
  });
});

describe('shellQuote', () => {
  it('single-quotes a plain value', () => {
    expect(shellQuote('install')).toBe("'install'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
