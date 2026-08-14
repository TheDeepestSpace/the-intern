import { describe, it, expect } from 'vitest';
import { SUSPICIOUS_PATTERNS, MAX_BLOCKS, decideStopAction, buildReason } from '../check-stop-hook.js';

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

describe('check-stop-hook decideStopAction', () => {
  const okMessage = 'Fixed the bug and pushed a commit.';
  const stallMessage = 'I am waiting on the test suite to finish.';

  it('never blocks once work has landed, even with a suspicious message', () => {
    const result = decideStopAction({
      message: stallMessage,
      statusLines: ['M some/file.js'],
      landedWork: true,
      blockCount: 0,
    });
    expect(result.block).toBe(false);
    expect(result.nextBlockCount).toBe(0);
  });

  it('blocks on a suspicious message alone, with nothing landed and a clean tree', () => {
    const result = decideStopAction({
      message: stallMessage,
      statusLines: [],
      landedWork: false,
      blockCount: 0,
    });
    expect(result.block).toBe(true);
    expect(result.nextBlockCount).toBe(1);
  });

  it('blocks a silent bail with ordinary phrasing when tracked files are dirty and nothing landed', () => {
    const result = decideStopAction({
      message: okMessage,
      statusLines: [' M scripts/foo.js'],
      landedWork: false,
      blockCount: 0,
    });
    expect(result.block).toBe(true);
  });

  it('does not block on untracked-only files with ordinary phrasing (weak signal alone)', () => {
    const result = decideStopAction({
      message: okMessage,
      statusLines: ['?? scratch/debug.log'],
      landedWork: false,
      blockCount: 0,
    });
    expect(result.block).toBe(false);
  });

  it('mentions leftover untracked files in the reason when a block is already triggered', () => {
    const result = decideStopAction({
      message: okMessage,
      statusLines: [' M scripts/foo.js', '?? scratch/debug.log'],
      landedWork: false,
      blockCount: 0,
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/untracked files/i);
    expect(result.reason).toMatch(/do not sweep|rather than sweeping/i); // nudges toward explicit handling, not bulk-staging
  });

  it('stops forcing retries once the block count reaches MAX_BLOCKS', () => {
    const result = decideStopAction({
      message: stallMessage,
      statusLines: [],
      landedWork: false,
      blockCount: MAX_BLOCKS,
    });
    expect(result.block).toBe(false);
    expect(result.nextBlockCount).toBe(0);
  });

  it('keeps blocking across repeated attempts up to MAX_BLOCKS, incrementing each time', () => {
    let blockCount = 0;
    for (let i = 0; i < MAX_BLOCKS; i++) {
      const result = decideStopAction({ message: stallMessage, statusLines: [], landedWork: false, blockCount });
      expect(result.block).toBe(true);
      blockCount = result.nextBlockCount;
    }
    const finalResult = decideStopAction({ message: stallMessage, statusLines: [], landedWork: false, blockCount });
    expect(finalResult.block).toBe(false);
  });
});

describe('check-stop-hook buildReason', () => {
  it('produces a non-empty, readable reason for every trigger combination', () => {
    for (const isSuspicious of [true, false]) {
      for (const hasTrackedChanges of [true, false]) {
        for (const hasUntracked of [true, false]) {
          if (!isSuspicious && !hasTrackedChanges) continue; // not a real trigger combination
          const reason = buildReason({ isSuspicious, hasTrackedChanges, hasUntracked });
          expect(typeof reason).toBe('string');
          expect(reason.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
