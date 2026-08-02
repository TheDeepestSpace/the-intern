import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { runScript } from './helpers/run-script.js';

describe('download-telegram-photo', () => {
  let outputPath;

  afterEach(() => {
    if (outputPath && fs.existsSync(outputPath)) fs.rmSync(outputPath);
  });

  it('resolves the file_id to a file_path via getFile, then downloads it to OUTPUT_PATH', () => {
    outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-photo-')), 'photo.jpg');

    const { status, stdout } = runScript('download-telegram-photo.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', PHOTO_FILE_ID: 'FILE123', OUTPUT_PATH: outputPath },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/botTESTTOKEN/getFile?file_id=FILE123',
          statusCode: 200,
          body: { ok: true, result: { file_path: 'photos/file_1.jpg' } },
        },
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/file/botTESTTOKEN/photos/file_1.jpg',
          statusCode: 200,
          body: 'fake-jpeg-bytes',
        },
      ],
    });

    expect(status).toBe(0);
    expect(stdout).toContain(`Telegram photo downloaded to ${outputPath}`);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('fake-jpeg-bytes');
  });

  it('URL-encodes the file_id in the getFile request', () => {
    outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-photo-')), 'photo.jpg');

    const { status } = runScript('download-telegram-photo.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', PHOTO_FILE_ID: 'FILE/WITH SPACE', OUTPUT_PATH: outputPath },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/botTESTTOKEN/getFile?file_id=FILE%2FWITH%20SPACE',
          statusCode: 200,
          body: { ok: true, result: { file_path: 'photos/file_2.jpg' } },
        },
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/file/botTESTTOKEN/photos/file_2.jpg',
          statusCode: 200,
          body: 'bytes',
        },
      ],
    });

    expect(status).toBe(0);
  });

  it('exits 1 without TG_BOT_TOKEN/PHOTO_FILE_ID', () => {
    const { status, stderr } = runScript('download-telegram-photo.js', {
      env: { TG_BOT_TOKEN: '', PHOTO_FILE_ID: '', OUTPUT_PATH: '/tmp/whatever.jpg' },
    });

    expect(status).toBe(1);
    expect(stderr).toContain('TG_BOT_TOKEN and PHOTO_FILE_ID environment variables are required');
  });

  it('exits 1 without an OUTPUT_PATH', () => {
    const { status, stderr } = runScript('download-telegram-photo.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', PHOTO_FILE_ID: 'FILE123' },
    });

    expect(status).toBe(1);
    expect(stderr).toContain('No output path provided');
  });

  it('exits 1 and logs the response body when getFile fails', () => {
    const { status, stderr } = runScript('download-telegram-photo.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', PHOTO_FILE_ID: 'FILE123', OUTPUT_PATH: '/tmp/whatever.jpg' },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/botTESTTOKEN/getFile?file_id=FILE123',
          statusCode: 404,
          body: { ok: false, description: 'file not found' },
        },
      ],
    });

    expect(status).toBe(1);
    expect(stderr).toContain('Telegram getFile failed (404)');
    expect(stderr).toContain('file not found');
  });

  it('exits 1 when getFile response is missing file_path', () => {
    const { status, stderr } = runScript('download-telegram-photo.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', PHOTO_FILE_ID: 'FILE123', OUTPUT_PATH: '/tmp/whatever.jpg' },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/botTESTTOKEN/getFile?file_id=FILE123',
          statusCode: 200,
          body: { ok: true, result: {} },
        },
      ],
    });

    expect(status).toBe(1);
    expect(stderr).toContain('missing file_path');
  });

  it('exits 1 when the file download request fails', () => {
    const { status, stderr } = runScript('download-telegram-photo.js', {
      env: { TG_BOT_TOKEN: 'TESTTOKEN', PHOTO_FILE_ID: 'FILE123', OUTPUT_PATH: '/tmp/whatever.jpg' },
      mockHttp: [
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/botTESTTOKEN/getFile?file_id=FILE123',
          statusCode: 200,
          body: { ok: true, result: { file_path: 'photos/file_3.jpg' } },
        },
        {
          origin: 'https://api.telegram.org',
          method: 'GET',
          path: '/file/botTESTTOKEN/photos/file_3.jpg',
          statusCode: 500,
          body: 'server error',
        },
      ],
    });

    expect(status).toBe(1);
    expect(stderr).toContain('Telegram file download failed (500)');
  });
});
