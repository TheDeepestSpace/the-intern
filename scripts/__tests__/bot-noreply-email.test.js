import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

// GitHub only links bot commits via `<id>+<slug>[bot]@users.noreply.github.com`.
const BAD = /(?<![\w+-])[\w-]+\[bot\]@users\.noreply\.github\.com/;

describe('bot noreply emails', () => {
  it('has no id-less [bot]@users.noreply emails', () => {
    const out = execFileSync('git', ['grep', '-n', '-I', '-E', '\\[bot\\]@users\\.noreply', '--', '.', ':!scripts/__tests__/bot-noreply-email.test.js'], { encoding: 'utf8' });
    const bad = out.split('\n').filter((l) => BAD.test(l));
    expect(bad).toEqual([]);
  });
});
