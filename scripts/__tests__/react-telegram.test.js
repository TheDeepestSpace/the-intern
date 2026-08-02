import { describe, it, expect } from 'vitest';
import { runScript } from './helpers/run-script.js';

describe('react-telegram', () => {
  it('sends a reaction and exits 0', () => {
    const { status, stdout } = runScript('react-telegram.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555', MESSAGE_ID: '99' },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'POST',
          path: '/botTESTTOKEN/setMessageReaction',
          statusCode: 200,
          body: { ok: true },
        },
      ],
    });

    expect(status).toBe(0);
    expect(stdout).toContain('Telegram reaction sent successfully.');
  });

  it('defaults the emoji to 👀 and falls back to REPLY_TO_MESSAGE_ID for the message id', () => {
    const { status, stdout } = runScript('react-telegram.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555', REPLY_TO_MESSAGE_ID: '77', CAPTURE_REQUEST_BODY: '1' },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'POST',
          path: '/botTESTTOKEN/setMessageReaction',
          statusCode: 200,
          body: { ok: true },
        },
      ],
    });

    expect(status).toBe(0);
    const marker = 'CAPTURED_REQUEST_BODY:';
    const body = JSON.parse(stdout.split('\n').find(l => l.startsWith(marker)).slice(marker.length));
    expect(body.message_id).toBe(77);
    expect(body.reaction).toEqual([{ type: 'emoji', emoji: '👀' }]);
  });

  it('honors a custom REACTION_EMOJI', () => {
    const { stdout } = runScript('react-telegram.js', {
      env: {
        TG_BOT_TOKEN: 'TESTTOKEN',
        CHAT_ID: '555',
        MESSAGE_ID: '99',
        REACTION_EMOJI: '🔥',
        CAPTURE_REQUEST_BODY: '1',
      },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'POST',
          path: '/botTESTTOKEN/setMessageReaction',
          statusCode: 200,
          body: { ok: true },
        },
      ],
    });

    const marker = 'CAPTURED_REQUEST_BODY:';
    const body = JSON.parse(stdout.split('\n').find(l => l.startsWith(marker)).slice(marker.length));
    expect(body.reaction).toEqual([{ type: 'emoji', emoji: '🔥' }]);
  });

  describe('fail-soft behavior', () => {
    it('exits 0 (not 1) when required env vars are missing', () => {
      const { status, stderr } = runScript('react-telegram.js', {
        env: { TG_BOT_TOKEN: '', CHAT_ID: '', MESSAGE_ID: '' },
      });

      expect(status).toBe(0);
      expect(stderr).toContain('Skipping reaction');
    });

    it('exits 0 (not 1) when the Telegram API call fails', () => {
      const { status, stderr } = runScript('react-telegram.js', {
        env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555', MESSAGE_ID: '99' },
        mockHttp: [
          {
            origin: 'https://api.telegram.org',
            method: 'POST',
            path: '/botTESTTOKEN/setMessageReaction',
            statusCode: 400,
            body: { ok: false, description: 'Bad Request' },
          },
        ],
      });

      expect(status).toBe(0);
      expect(stderr).toContain('Telegram reaction failed (400)');
    });

    it('exits 0 (not 1) when fetch itself throws (network error)', () => {
      // No matching mockHttp intercept + disableNetConnect() means the fetch
      // call rejects instead of resolving with a response.
      const { status, stderr } = runScript('react-telegram.js', {
        env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555', MESSAGE_ID: '99' },
        mockHttp: [],
      });

      expect(status).toBe(0);
      expect(stderr).toContain('Telegram reaction failed:');
    });
  });
});
