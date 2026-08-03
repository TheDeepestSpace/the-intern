import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseTelegramTrigger } from '../parse-telegram-trigger.js';

const ENV_KEYS = ['GITHUB_EVENT_PATH', 'GITHUB_OUTPUT'];

function writeEventPayload(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-telegram-trigger-'));
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

describe('parse-telegram-trigger', () => {
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

  it('extracts backend= and strips it from the message text', () => {
    process.env.GITHUB_EVENT_PATH = writeEventPayload({
      client_payload: { text: 'backend=codex fix the parser bug' },
    });

    const result = parseTelegramTrigger();

    expect(result.backend).toBe('codex');
    expect(result.clean_text).toBe('fix the parser bug');
  });

  it('defaults to claude when backend= is not present', () => {
    process.env.GITHUB_EVENT_PATH = writeEventPayload({
      client_payload: { text: 'just say hi' },
    });

    const result = parseTelegramTrigger();

    expect(result.backend).toBe('claude');
    expect(result.clean_text).toBe('just say hi');
  });

  it('handles missing/empty text gracefully', () => {
    process.env.GITHUB_EVENT_PATH = writeEventPayload({ client_payload: {} });

    const result = parseTelegramTrigger();

    expect(result.backend).toBe('claude');
    expect(result.clean_text).toBe('');
  });

  it('handles a missing event path gracefully', () => {
    const result = parseTelegramTrigger();

    expect(result.backend).toBe('claude');
    expect(result.clean_text).toBe('');
  });

  it('writes backend and clean_text to GITHUB_OUTPUT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-output-'));
    const outputFile = path.join(dir, 'output');
    fs.writeFileSync(outputFile, '');
    process.env.GITHUB_OUTPUT = outputFile;
    process.env.GITHUB_EVENT_PATH = writeEventPayload({
      client_payload: { text: 'backend=codex what is the plan?' },
    });

    parseTelegramTrigger();

    const contents = fs.readFileSync(outputFile, 'utf8');
    expect(contents).toContain('backend=codex');
    expect(contents).toContain('clean_text=what is the plan?');
  });
});
