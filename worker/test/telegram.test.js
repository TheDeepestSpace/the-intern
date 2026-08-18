import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import {
  baseTelegramEnv,
  mockGithubDispatchFlow,
  mockInstallationLookupAndDispatchFlow,
  telegramRequest,
} from './fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function baseMessage(overrides = {}) {
  return {
    message_id: 101,
    from: { id: 555 },
    chat: { id: 777 },
    text: 'hello there',
    ...overrides,
  };
}

function dispatchedRequestBody(fetchSpy) {
  const dispatchCall = fetchSpy.mock.calls.find(([input]) =>
    new URL(typeof input === 'string' ? input : input.url).pathname.endsWith('/dispatches')
  );
  expect(dispatchCall).toBeTruthy();
  const [, init] = dispatchCall;
  return JSON.parse(init.body);
}

async function dispatchedClientPayload(fetchSpy) {
  return dispatchedRequestBody(fetchSpy).client_payload;
}

describe('handleTelegram gating', () => {
  it('returns ok without dispatching when there is no message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      telegramRequest({ update: { update_id: 1 } }),
      baseTelegramEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok without dispatching when the message has no text or photo', async () => {
    const res = await worker.fetch(
      telegramRequest({ update: { message: { message_id: 1, from: { id: 1 }, chat: { id: 1 } } } }),
      baseTelegramEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('returns ok without dispatching for a non-image document with no text or caption', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const message = baseMessage({
      text: undefined,
      document: { file_id: 'doc-1', mime_type: 'application/pdf' },
    });
    const res = await worker.fetch(telegramRequest({ update: { message } }), baseTelegramEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects requests with a bad secret token when TG_WEBHOOK_SECRET is configured', async () => {
    const res = await worker.fetch(
      telegramRequest({
        update: { message: baseMessage() },
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
      }),
      baseTelegramEnv({ TG_WEBHOOK_SECRET: 'right' })
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('bad secret');
  });

  it('ignores senders not matching ALLOWED_TG_USER_ID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      telegramRequest({ update: { message: baseMessage({ from: { id: 111 } }) } }),
      baseTelegramEnv({ ALLOWED_TG_USER_ID: '555' })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: unauthorized sender');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows the matching ALLOWED_TG_USER_ID through', async () => {
    mockGithubDispatchFlow();
    const res = await worker.fetch(
      telegramRequest({ update: { message: baseMessage({ from: { id: 555 } }) } }),
      baseTelegramEnv({ ALLOWED_TG_USER_ID: '555' })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('ignores chats not matching ALLOWED_TG_CHAT_ID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      telegramRequest({ update: { message: baseMessage({ chat: { id: 1 } }) } }),
      baseTelegramEnv({ ALLOWED_TG_CHAT_ID: '777' })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored: unauthorized chat_id');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when no installation id can be resolved', async () => {
    const res = await worker.fetch(
      telegramRequest({ update: { message: baseMessage() } }),
      baseTelegramEnv({ AGENT_INFRA_INSTALLATION_ID: undefined, APP_ID: undefined, APP_PRIVATE_KEY: undefined })
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('missing installation id for agent-infra');
  });
});

describe('handleTelegram client_payload construction', () => {
  it('uses message.text as text, with chat/sender/message ids', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const res = await worker.fetch(
      telegramRequest({ update: { message: baseMessage() } }),
      baseTelegramEnv()
    );
    expect(res.status).toBe(200);

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload).toEqual({
      text: 'hello there',
      chat_id: 777,
      sender_id: 555,
      message_id: 101,
    });
  });

  it('falls back to message.caption when text is absent', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const message = baseMessage({ text: undefined, caption: 'a photo caption', photo: [{ file_id: 'small' }] });
    await worker.fetch(telegramRequest({ update: { message } }), baseTelegramEnv());

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload.text).toBe('a photo caption');
  });

  it('adds photo_file_id from the largest photo size when a photo is present', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const message = baseMessage({
      photo: [{ file_id: 'thumb' }, { file_id: 'medium' }, { file_id: 'largest' }],
    });
    await worker.fetch(telegramRequest({ update: { message } }), baseTelegramEnv());

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload.photo_file_id).toBe('largest');
  });

  it('omits photo_file_id when there is no photo', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    await worker.fetch(telegramRequest({ update: { message: baseMessage() } }), baseTelegramEnv());

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload).not.toHaveProperty('photo_file_id');
  });

  it('sets photo_file_id from an image document sent without compression', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const message = baseMessage({
      text: undefined,
      caption: 'uncompressed image',
      document: { file_id: 'doc-image', mime_type: 'image/jpeg' },
    });
    const res = await worker.fetch(telegramRequest({ update: { message } }), baseTelegramEnv());
    expect(res.status).toBe(200);

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload.photo_file_id).toBe('doc-image');
    expect(payload.text).toBe('uncompressed image');
  });

  it('includes reply_to_message fields, preferring reply text over reply caption', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const message = baseMessage({
      reply_to_message: { message_id: 42, text: 'original message' },
    });
    await worker.fetch(telegramRequest({ update: { message } }), baseTelegramEnv());

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload.reply_to_message_id).toBe(42);
    expect(payload.reply_to_text).toBe('original message');
    expect(payload).not.toHaveProperty('reply_to_photo_file_id');
  });

  it('falls back to reply caption and includes reply_to_photo_file_id for photo replies', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const message = baseMessage({
      reply_to_message: {
        message_id: 42,
        caption: 'reply caption',
        photo: [{ file_id: 'r-thumb' }, { file_id: 'r-largest' }],
      },
    });
    await worker.fetch(telegramRequest({ update: { message } }), baseTelegramEnv());

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload.reply_to_text).toBe('reply caption');
    expect(payload.reply_to_photo_file_id).toBe('r-largest');
  });

  it('sets reply_to_photo_file_id from an image document reply', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const message = baseMessage({
      reply_to_message: {
        message_id: 42,
        caption: 'reply caption',
        document: { file_id: 'r-doc-image', mime_type: 'image/png' },
      },
    });
    await worker.fetch(telegramRequest({ update: { message } }), baseTelegramEnv());

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload.reply_to_photo_file_id).toBe('r-doc-image');
  });

  it('omits reply_to_* fields when there is no reply_to_message', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    await worker.fetch(telegramRequest({ update: { message: baseMessage() } }), baseTelegramEnv());

    const payload = await dispatchedClientPayload(fetchSpy);
    expect(payload).not.toHaveProperty('reply_to_message_id');
    expect(payload).not.toHaveProperty('reply_to_text');
  });

  it('sets event_type to telegram_message on the dispatch body', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    await worker.fetch(telegramRequest({ update: { message: baseMessage() } }), baseTelegramEnv());

    expect(dispatchedRequestBody(fetchSpy).event_type).toBe('telegram_message');
  });
});

describe('handleTelegram installation id resolution', () => {
  it('looks up the installation id via the GitHub App JWT when AGENT_INFRA_INSTALLATION_ID is unset', async () => {
    const fetchSpy = mockInstallationLookupAndDispatchFlow({ installationId: 4321 });
    const res = await worker.fetch(
      telegramRequest({ update: { message: baseMessage() } }),
      baseTelegramEnv({ AGENT_INFRA_INSTALLATION_ID: undefined })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    const lookupCall = fetchSpy.mock.calls.find(([input]) =>
      new URL(typeof input === 'string' ? input : input.url).pathname.endsWith('/installation')
    );
    expect(lookupCall).toBeTruthy();
  });

  it('decodes a base64-encoded private key that has no PEM header', async () => {
    const fetchSpy = mockGithubDispatchFlow();
    const env = baseTelegramEnv();
    const base64Key = Buffer.from(env.APP_PRIVATE_KEY, 'utf8').toString('base64');

    const res = await worker.fetch(
      telegramRequest({ update: { message: baseMessage() } }),
      { ...env, APP_PRIVATE_KEY: base64Key }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(fetchSpy).toHaveBeenCalled();
  });
});
