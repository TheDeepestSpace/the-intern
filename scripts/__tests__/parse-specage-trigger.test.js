import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSpecageTrigger } from '../parse-specage-trigger.js';

const ENV_KEYS = ['GITHUB_EVENT_PATH', 'GITHUB_OUTPUT', 'CLEAN_PROMPT_FILE'];

function writeEvent(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-specage-trigger-'));
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

describe('parse-specage-trigger', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reads repo, installation and text from client_payload with no issue number', () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      client_payload: { target_repo: 'acme/app', installation_id: '7', text: 'backend=codex model=sol Run it.' },
    });
    const out = path.join(os.tmpdir(), `specage-prompt-${process.pid}.txt`);
    process.env.CLEAN_PROMPT_FILE = out;
    const result = parseSpecageTrigger();
    expect(result).toEqual({
      target_repo: 'acme/app',
      installation_id: '7',
      backend: 'codex',
      model: 'sol',
      clean_prompt: 'Run it.',
    });
    expect(fs.readFileSync(out, 'utf8')).toBe('Run it.');
    fs.rmSync(out);
  });

  it('defaults backend to claude', () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({ client_payload: { target_repo: 'a/b', installation_id: 1, text: 'go' } });
    expect(parseSpecageTrigger()).toMatchObject({ backend: 'claude', model: 'default', installation_id: '1' });
  });
});
