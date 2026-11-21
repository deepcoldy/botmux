import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // uploadFile hands the SDK a file stream (a Buffer part has no filename and
  // Feishu rejects it past ~26MiB) and removes any temp file once the call
  // returns, so drain the stream while the request is in flight.
  sent: [] as Buffer[],
  file: vi.fn(async (request: { data: { file_type: string; file_name: string; file: AsyncIterable<Buffer> } }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request.data.file) chunks.push(chunk);
    mocks.sent.push(Buffer.concat(chunks));
    return { file_key: 'file_reply' };
  }),
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
  const answer = '甲\0'.repeat(2_000_000);
  const bytes = Buffer.from(answer);
  expect(await uploadFile('app', { name: 'reply.md', bytes })).toBe('file_reply');
  expect(mocks.file).toHaveBeenCalledTimes(1);
  const { file, ...metadata } = mocks.file.mock.calls[0]![0].data;
  expect(metadata).toEqual({ file_type: 'stream', file_name: 'reply.md' });
  expect(file).toHaveProperty('path', expect.stringMatching(/reply\.md$/));
  expect(mocks.sent[0]!.equals(Buffer.from(answer))).toBe(true);
});
