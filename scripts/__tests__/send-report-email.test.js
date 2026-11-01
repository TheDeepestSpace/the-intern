import { describe, it, expect, vi } from 'vitest';
import { emailConfigured, sendEmail, postReportIssue, RESEND_URL, DEFAULT_FROM } from '../send-report-email.js';

const report = { subject: 'subj', text: 'body text', html: '<pre>body text</pre>' };

describe('emailConfigured', () => {
  it('requires both the API key and a recipient', () => {
    expect(emailConfigured({})).toBe(false);
    expect(emailConfigured({ RESEND_API_KEY: 'k' })).toBe(false);
    expect(emailConfigured({ RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c' })).toBe(true);
  });
});

describe('sendEmail', () => {
  it('POSTs the report to Resend with the configured sender and recipients', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ id: 'em_1' }) };
    });
    const env = { RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c, d@e.f', REPORT_EMAIL_FROM: 'bot <bot@example.com>' };
    expect(await sendEmail(report, env, fetchImpl)).toEqual({ id: 'em_1' });
    expect(calls[0].url).toBe(RESEND_URL);
    expect(calls[0].opts.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      from: 'bot <bot@example.com>',
      to: ['a@b.c', 'd@e.f'],
      subject: 'subj',
      text: 'body text',
      html: '<pre>body text</pre>',
    });
  });

  it('falls back to the default sender', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await sendEmail(report, { RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c' }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).from).toBe(DEFAULT_FROM);
  });

  it('throws when unconfigured or when Resend rejects', async () => {
    await expect(sendEmail(report, {}, vi.fn())).rejects.toThrow(/not configured/);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, text: async () => 'bad from' }));
    await expect(sendEmail(report, { RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.c' }, fetchImpl)).rejects.toThrow(/422.*bad from/);
  });
});

describe('postReportIssue', () => {
  it('opens an issue on the data repo that mentions the owner', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ html_url: 'https://gh/issue/1' }) }));
    const env = { DATA_REPO_TOKEN: 't', DATA_REPO: 'org/data', REPORT_MENTION: 'owner' };
    expect(await postReportIssue(report, env, fetchImpl)).toEqual({ url: 'https://gh/issue/1' });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/org/data/issues');
    expect(opts.headers.Authorization).toBe('Bearer t');
    const body = JSON.parse(opts.body);
    expect(body.title).toBe('subj');
    expect(body.body.startsWith('@owner\n')).toBe(true);
    expect(body.body).toContain('body text');
  });

  it('defaults to the-intern-data and TheDeepestSpace', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }));
    await postReportIssue(report, { DATA_REPO_TOKEN: 't' }, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/TheDeepestSpace/the-intern-data/issues');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).body).toMatch(/^@TheDeepestSpace/);
  });

  it('throws without a token or on API failure', async () => {
    await expect(postReportIssue(report, {}, vi.fn())).rejects.toThrow(/DATA_REPO_TOKEN/);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no issues scope' }));
    await expect(postReportIssue(report, { DATA_REPO_TOKEN: 't' }, fetchImpl)).rejects.toThrow(/403.*no issues scope/);
  });
});
