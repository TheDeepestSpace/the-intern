import { describe, it, expect } from 'vitest';
import { buildModelFlag, buildCodexModelFlag } from '../build-model-flag.js';

describe('buildModelFlag', () => {
  it('builds a --model flag referencing a shell variable, never the raw value', () => {
    const result = buildModelFlag('claude-haiku-4-5');

    expect(result.valid).toBe(true);
    expect(result.flag).toBe('--model "$MODEL"');
    expect(result.flag).not.toContain('claude-haiku-4-5');
    expect(result.warning).toBeNull();
  });

  it('omits the flag when model is unset', () => {
    const result = buildModelFlag(undefined);

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toBeNull();
  });

  it('omits the flag when model is empty string', () => {
    const result = buildModelFlag('');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toBeNull();
  });

  it('omits the flag for the parser\'s "default" sentinel, without a warning', () => {
    const result = buildModelFlag('default');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toBeNull();
  });

  it('accepts model IDs shaped like the real catalog (dots, hyphens, digits)', () => {
    for (const model of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-mythos-5']) {
      const result = buildModelFlag(model);
      expect(result.valid).toBe(true);
      expect(result.flag).toBe('--model "$MODEL"');
    }
  });

  it('rejects a value containing a backtick command substitution and logs a warning', () => {
    const result = buildModelFlag('`whoami`');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toContain('::warning::');
    expect(result.warning).toContain('`whoami`');
  });

  it('rejects a value with a shell command separator and logs a warning', () => {
    const result = buildModelFlag('foo;rm -rf /');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toContain('::warning::');
  });

  it('rejects a value with a slash (not a real model ID shape)', () => {
    const result = buildModelFlag('anthropic/claude-opus-5');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toContain('::warning::');
  });
});

describe('buildCodexModelFlag', () => {
  it('builds a -c model= flag referencing a shell variable, never the raw value', () => {
    const result = buildCodexModelFlag('astra');

    expect(result.valid).toBe(true);
    expect(result.flag).toBe('-c model=\\"$MODEL\\"');
    expect(result.flag).not.toContain('astra');
    expect(result.warning).toBeNull();
  });

  it('omits the flag when model is unset', () => {
    const result = buildCodexModelFlag(undefined);

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toBeNull();
  });

  it('omits the flag when model is empty string', () => {
    const result = buildCodexModelFlag('');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toBeNull();
  });

  it('omits the flag for the parser\'s "default" sentinel, without a warning', () => {
    const result = buildCodexModelFlag('default');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toBeNull();
  });

  it('accepts model IDs shaped like the real catalog (dots, hyphens, digits)', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-astra', 'o3-mini']) {
      const result = buildCodexModelFlag(model);
      expect(result.valid).toBe(true);
      expect(result.flag).toBe('-c model=\\"$MODEL\\"');
    }
  });

  it('rejects a value containing a backtick command substitution and logs a warning', () => {
    const result = buildCodexModelFlag('`whoami`');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toContain('::warning::');
    expect(result.warning).toContain('`whoami`');
  });

  it('rejects a value with a shell command separator and logs a warning', () => {
    const result = buildCodexModelFlag('foo;rm -rf /');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toContain('::warning::');
  });

  it('rejects a value with a slash (not a real model ID shape)', () => {
    const result = buildCodexModelFlag('anthropic/claude-opus-5');

    expect(result.valid).toBe(false);
    expect(result.flag).toBe('');
    expect(result.warning).toContain('::warning::');
  });
});
