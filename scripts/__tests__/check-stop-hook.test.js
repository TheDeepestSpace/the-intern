import { describe, it, expect } from 'vitest';
import { SUSPICIOUS_PATTERNS } from '../check-stop-hook.js';

function isSuspicious(message) {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(message));
}

describe('check-stop-hook SUSPICIOUS_PATTERNS', () => {
  it('flags the live final-message text from run 31217994339 (svsch#100) that evaded the prior pattern list', () => {
    expect(
      isSuspicious('I\'ll pause here and resume automatically once the Monitor reports the BDD suite has completed.')
    ).toBe(true);
  });

  it('flags "I\'ll stop polling now and wait for the Monitor/background task notification to arrive."', () => {
    expect(
      isSuspicious('I\'ll stop polling now and wait for the Monitor/background task notification to arrive.')
    ).toBe(true);
  });

  it('still flags the previously-covered phrasings', () => {
    expect(isSuspicious('I am waiting on the test suite to finish.')).toBe(true);
    expect(isSuspicious('I\'ll monitor this and follow up.')).toBe(true);
    expect(isSuspicious('This is still running in the background.')).toBe(true);
  });

  it('does not flag ordinary completion text', () => {
    expect(isSuspicious('Fixed the bug and pushed a commit.')).toBe(false);
    expect(isSuspicious('Opened PR #42 with the requested changes.')).toBe(false);
  });
});
