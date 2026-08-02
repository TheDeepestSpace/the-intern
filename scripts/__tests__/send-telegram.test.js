import { describe, it, expect } from 'vitest';
import { runScript } from './helpers/run-script.js';

describe('send-telegram', () => {
  it('sends a plain message and exits 0', () => {
    const { status, stdout } = runScript('send-telegram.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555', MESSAGE_TEXT: 'hello there' },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'POST',
          path: '/botTESTTOKEN/sendMessage',
          statusCode: 200,
          body: { ok: true },
        },
      ],
    });

    expect(status).toBe(0);
    expect(stdout).toContain('Telegram message sent successfully.');
  });

  it('includes reply_parameters with allow_sending_without_reply when REPLY_TO_MESSAGE_ID is set', () => {
    let capturedBody = null;
    // MockAgent's reply() can be a function receiving the request; use it to
    // capture and assert on the actual request body sent by the script.
    const { status } = runScriptWithBodyCapture('hello', '4242', body => {
      capturedBody = body;
    });

    expect(status).toBe(0);
    expect(capturedBody.reply_parameters).toEqual({
      message_id: 4242,
      allow_sending_without_reply: true,
    });
  });

  it('omits reply_parameters when REPLY_TO_MESSAGE_ID is not set', () => {
    let capturedBody = null;
    const { status } = runScriptWithBodyCapture('hello', undefined, body => {
      capturedBody = body;
    });

    expect(status).toBe(0);
    expect(capturedBody.reply_parameters).toBeUndefined();
    expect(capturedBody.chat_id).toBe('555');
    expect(capturedBody.text).toBe('hello');
  });

  it('reads the message from stdin when MESSAGE_TEXT and argv are absent', () => {
    const { status, stdout } = runScript('send-telegram.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555' },
      stdin: 'piped message body\n',
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'POST',
          path: '/botTESTTOKEN/sendMessage',
          statusCode: 200,
          body: { ok: true },
        },
      ],
    });

    expect(status).toBe(0);
    expect(stdout).toContain('Telegram message sent successfully.');
  });

  it('fails soft-guards: exits 1 without TG_BOT_TOKEN/CHAT_ID', () => {
    const { status, stderr } = runScript('send-telegram.js', {
      env: { TG_BOT_TOKEN: '', CHAT_ID: '' },
      args: ['hello'],
    });

    expect(status).toBe(1);
    expect(stderr).toContain('TG_BOT_TOKEN and CHAT_ID environment variables are required');
  });

  it('exits 1 when no message text is available from any source', () => {
    const { status, stderr } = runScript('send-telegram.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555' },
      stdin: '',
    });

    expect(status).toBe(1);
    expect(stderr).toContain('No message text provided');
  });

  it('exits 1 and logs the response body when the Telegram API call fails', () => {
    const { status, stderr } = runScript('send-telegram.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', CHAT_ID: '555', MESSAGE_TEXT: 'hello' },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'POST',
          path: '/botTESTTOKEN/sendMessage',
          statusCode: 401,
          body: { ok: false, description: 'Unauthorized' },
        },
      ],
    });

    expect(status).toBe(1);
    expect(stderr).toContain('Telegram send failed (401)');
    expect(stderr).toContain('Unauthorized');
  });

  // Helper for the two reply_parameters tests above: runs the real script
  // against a preload that echoes the captured request body to stdout as
  // JSON, since MockAgent's declarative mockHttp specs can't introspect the
  // request body themselves.
  function runScriptWithBodyCapture(messageText, replyToMessageId, onBody) {
    const { status, stdout } = runScript('send-telegram.js', {
      env: {
        TG_BOT_TOKEN: 'TESTTOKEN',
        CHAT_ID: '555',
        MESSAGE_TEXT: messageText,
        ...(replyToMessageId ? { REPLY_TO_MESSAGE_ID: String(replyToMessageId) } : {}),
        CAPTURE_REQUEST_BODY: '1',
      },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'POST',
          path: '/botTESTTOKEN/sendMessage',
          statusCode: 200,
          body: { ok: true },
        },
      ],
    });
    const marker = 'CAPTURED_REQUEST_BODY:';
    const line = stdout.split('\n').find(l => l.startsWith(marker));
    onBody(JSON.parse(line.slice(marker.length)));
    return { status };
  }
});
