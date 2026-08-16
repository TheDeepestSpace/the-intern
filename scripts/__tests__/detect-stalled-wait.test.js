import { describe, it, expect } from 'vitest';
import { detectStalledWait } from '../detect-stalled-wait.js';

describe('detectStalledWait', () => {
  it('returns null for ordinary text', () => {
    expect(detectStalledWait('Fixed the bug, pushed a commit, and opened PR #12.')).toBeNull();
  });

  it('returns null for empty/undefined input', () => {
    expect(detectStalledWait('')).toBeNull();
    expect(detectStalledWait(undefined)).toBeNull();
  });

  it('matches the literal svsch#144 phrasing ("Waiting on the Playwright run ... to finish generating baselines")', () => {
    const result = detectStalledWait('Waiting on the Playwright run for the new gate-curved-edge visual test to finish generating baselines');
    expect(result).not.toBeNull();
    expect(result.matchedText.toLowerCase()).toContain('waiting on');
  });

  it('matches "waiting for"', () => {
    expect(detectStalledWait('Waiting for CI to finish before merging.')).not.toBeNull();
  });

  it('matches "will check back"', () => {
    expect(detectStalledWait("I'll check back once the build finishes.")).not.toBeNull();
  });

  it('matches "will resume"', () => {
    expect(detectStalledWait('Will resume this once the tests are green.')).not.toBeNull();
  });

  it('matches "will follow up once/after/when"', () => {
    expect(detectStalledWait('Will follow up once the review lands.')).not.toBeNull();
  });

  it('matches "once X finishes/completes/is done"', () => {
    expect(detectStalledWait('Once the deploy finishes I will verify.')).not.toBeNull();
    expect(detectStalledWait('Once the migration is done, the schema will match.')).not.toBeNull();
  });
});
