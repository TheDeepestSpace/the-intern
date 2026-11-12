import { describe, it, expect, vi } from 'vitest';
import { postReportComment, reportToMarkdown, ISSUE_TITLE } from '../send-report.js';

const report = { subject: 'subj', text: 'subj\n\nbody text' };
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
    expect(body).toContain('### body text');
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

describe('reportToMarkdown', () => {
  const text = [
    'subj line', '',
    '🕑 Confirmed safe (1)',
    '- org/repo#5: pkg 1 → 2 [regular] — Hi @victim <b>x</b> `c` *y*',
    '  https://github.com/org/repo/pull/5', '',
    '⏳ Waiting (1)',
    '- org/repo#6: pkg — failing checks: test',
    'Run: https://github.com/org/repo/actions/runs/1', '',
  ].join('\n');

  it('renders headings, linked bullets, and a Run link; drops the subject line', () => {
    const md = reportToMarkdown(text);
    expect(md).not.toContain('subj line');
    expect(md).not.toContain('```');
    expect(md).toContain('### 🕑 Confirmed safe \\(1\\)');
    expect(md).toContain('- [org/repo\\#5](https://github.com/org/repo/pull/5): pkg');
    expect(md).toContain('- [org/repo\\#6](https://github.com/org/repo/pull/6): pkg');
    expect(md).toContain('Run: [https://github.com/org/repo/actions/runs/1](https://github.com/org/repo/actions/runs/1)');
    expect(md).not.toMatch(/^\s+https:/m);
  });

  it('neutralizes mentions, HTML and formatting in derived text', () => {
    const md = reportToMarkdown(text);
    expect(md).not.toMatch(/@victim/);
    expect(md).toContain('@\u200bvictim');
    expect(md).toContain('\\<b\\>x\\</b\\>');
    expect(md).toContain('\\`c\\`');
    expect(md).toContain('\\*y\\*');
  });

  it('posts markdown (no code fence) with escaped subject', async () => {
    const fetchImpl = vi.fn(async (url) => (url.includes('/comments') ? ok({}) : ok([{ number: 1, title: ISSUE_TITLE }])));
    await postReportComment({ subject: 'a @b', text }, { REPORT_TOKEN: 't', REPORT_MENTION: 'o' }, fetchImpl);
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body).body;
    expect(body.startsWith('@o **a @\u200bb**\n\n### ')).toBe(true);
    expect(body).not.toContain('```');
  });
});
