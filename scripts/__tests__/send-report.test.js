import { describe, it, expect, vi } from 'vitest';
import { postReportComment, ISSUE_TITLE } from '../send-report.js';

const report = { subject: 'subj', text: 'body text' };
const ok = (data) => ({ ok: true, status: 200, json: async () => data });

describe('postReportComment', () => {
  it('comments on the existing open static issue, mentioning the owner', async () => {
    const fetchImpl = vi.fn(async (url) => (url.includes('/comments')
      ? ok({ html_url: 'https://gh/c/1' })
      : ok([{ number: 3, title: 'other' }, { number: 4, title: ISSUE_TITLE, pull_request: {} }, { number: 5, title: ISSUE_TITLE }])));
    const env = { REPORT_TOKEN: 't', REPORT_REPO: 'org/repo', REPORT_MENTION: 'owner' };
    expect(await postReportComment(report, env, fetchImpl)).toEqual({ url: 'https://gh/c/1' });
    const [url, opts] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://api.github.com/repos/org/repo/issues/5/comments');
    expect(opts.headers.Authorization).toBe('Bearer t');
    const body = JSON.parse(opts.body).body;
    expect(body.startsWith('@owner ')).toBe(true);
    expect(body).toContain('body text');
  });

  it('creates the issue when none is open, defaulting repo and mention', async () => {
    const fetchImpl = vi.fn(async (url, opts) => {
      if (url.endsWith('/comments')) return ok({});
      if (opts?.method === 'POST') return ok({ number: 9 });
      return ok([]);
    });
    await postReportComment(report, { REPORT_TOKEN: 't' }, fetchImpl);
    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls[1]).toBe('https://api.github.com/repos/TheDeepestSpace/the-intern/issues');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).title).toBe(ISSUE_TITLE);
    expect(urls[2]).toBe('https://api.github.com/repos/TheDeepestSpace/the-intern/issues/9/comments');
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).body).toMatch(/^@TheDeepestSpace /);
  });

  it('throws without a token or on API failure', async () => {
    await expect(postReportComment(report, {}, vi.fn())).rejects.toThrow(/REPORT_TOKEN/);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no issues scope' }));
    await expect(postReportComment(report, { REPORT_TOKEN: 't' }, fetchImpl)).rejects.toThrow(/403.*no issues scope/);
  });
});
