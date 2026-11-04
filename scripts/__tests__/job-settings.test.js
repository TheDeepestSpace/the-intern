import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jobSettings } = require('../lib/job-settings');

describe('jobSettings', () => {
  it('reads the settings of the agent running a job from agentic.yaml', () => {
    expect(jobSettings('poll-pending-retries')).toEqual({ retry_lock_minutes: 25 });
    expect(jobSettings('nightly-crawl')).toMatchObject({ max_reviews: 20, mergeable_poll_attempts: 4, mergeable_poll_delay_ms: 1500 });
  });

  it('is empty for a job without settings and throws on a missing file (fail closed)', () => {
    expect(jobSettings('update-model-list')).toEqual({});
    expect(() => jobSettings('nightly-crawl', { file: '/nonexistent/agentic.yaml' })).toThrow(/missing or unreadable/);
  });
});
