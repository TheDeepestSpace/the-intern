import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { readResultText } from '../handle-agent-outcome.js';

describe('readResultText', () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });

  function write(content) {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'result-')), 'result.json');
    fs.writeFileSync(tmpFile, content);
    return tmpFile;
  }

  it('treats a missing file as an error with empty text', () => {
    expect(readResultText(path.join(os.tmpdir(), 'does-not-exist.json'))).toEqual({ isError: true, text: '' });
  });

  it('treats an empty file as an error with empty text', () => {
    expect(readResultText(write('   '))).toEqual({ isError: true, text: '' });
  });

  it('extracts the result field on success', () => {
    const file = write(JSON.stringify({ is_error: false, result: 'Opened PR #12' }));
    expect(readResultText(file)).toEqual({ isError: false, text: 'Opened PR #12' });
  });

  it('extracts the result field on failure', () => {
    const file = write(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached' }));
    expect(readResultText(file)).toEqual({ isError: true, text: 'Claude AI usage limit reached' });
  });

  it('falls back to output when result is absent', () => {
    const file = write(JSON.stringify({ is_error: false, output: 'from codex' }));
    expect(readResultText(file)).toEqual({ isError: false, text: 'from codex' });
  });

  it('treats unparseable JSON as an error, using the raw text', () => {
    const file = write('not json at all');
    expect(readResultText(file)).toEqual({ isError: true, text: 'not json at all' });
  });
});
