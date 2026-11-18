import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  file: vi.fn(async () => ({ file_key: 'file_reply' })),
  create: vi.fn(async () => ({ image_key: 'img_v3_uploaded' })),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { apiOnly: false } }),
  getBotUploadClient: () => ({ im: { v1: { image: { create: mocks.create }, file: { create: mocks.file } } } }),
  getBotClient: vi.fn(), getAllBots: () => [], loadBotConfigs: () => [],
  formatLarkError: (value: unknown) => String(value),
}));

import { uploadFile, uploadImage } from '../src/im/lark/client.js';

describe('uploadImage with inspected bytes', () => {
  it('passes the inspected buffer to the existing image upload API without reopening a path', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    expect(await uploadImage('app', bytes)).toBe('img_v3_uploaded');
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      data: { image_type: 'message', image: bytes },
    });
  });
});

it('uploads the full in-memory Markdown answer with its filename and stream type', async () => {
  const bytes = Buffer.from('甲\0'.repeat(2_000_000));
  expect(await uploadFile('app', { name: 'reply.md', bytes })).toBe('file_reply');
  expect(mocks.file).toHaveBeenCalledExactlyOnceWith({ data: { file_type: 'stream', file_name: 'reply.md', file: bytes } });
});
