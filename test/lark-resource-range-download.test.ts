import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { Client } from '@larksuiteoapi/node-sdk';
import {
  downloadResourceWithRange, isResourceSizeLimitError, type ResourceStream,
} from '../src/im/lark/resource-range-download.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), userToken: vi.fn(), apiOnly: false, brand: 'feishu' }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: mocks.request }), getAllBots: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-only', apiOnly: mocks.apiOnly, brand: mocks.brand } }),
  formatLarkError: String,
  LarkTransportDisabledError: class extends Error {},
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: mocks.userToken }));
import { downloadMessageResource, UserTokenMissingError } from '../src/im/lark/client.js';

const dirs: string[] = [];
async function outputPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-range-')); dirs.push(dir);
  return join(dir, 'attachment.zip');
}
function partial(start: number, end: number, total: number, bytes = Buffer.alloc(end - start + 1, 7)): ResourceStream {
  const response = Readable.from([bytes]) as ResourceStream;
  response.statusCode = 206;
  response.headers = { 'content-range': `bytes ${start}-${end}/${total}` };
  return response;
}
function sizeError(stream = false) {
  return Object.assign(new Error('file size exceeds limit'), {
    response: { status: 400, data: stream ? Readable.from(['{"code":234037}']) : { code: 234037 } },
  });
}
beforeEach(() => { vi.clearAllMocks(); mocks.apiOnly = false; mocks.brand = 'feishu'; mocks.userToken.mockResolvedValue(null); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('resource size error classification', () => {
  it.each([sizeError(), sizeError(true), { response: { data: '{"code":234037}' } },
    { response: { data: Buffer.from('{"code":234037}') } }])('recognizes JSON and SDK streamed errors', async error => {
    expect(await isResourceSizeLimitError(error)).toBe(true);
  });
  it.each([undefined, { status: 403 }, { response: { data: { code: 234002 } } },
    { response: { data: '<html>gateway error</html>' } }])('does not confuse permissions or malformed errors with size', async error => {
    expect(await isResourceSizeLimitError(error)).toBe(false);
  });
  it('bounds the streamed error body and closes it', async () => {
    const stream = Readable.from([Buffer.alloc(33 * 1024)]) as ResourceStream;
    expect(await isResourceSizeLimitError({ response: { data: stream } })).toBe(false);
    expect(stream.destroyed).toBe(true);
  });
});

describe('Range transfer', () => {
  it('downloads exact bytes using 8 MiB ranges with a short final chunk', async () => {
    const output = await outputPath();
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 19);
    const request = vi.fn(async (start: number, end: number) => partial(start, end, bytes.length, bytes.subarray(start, end + 1)));
    await downloadResourceWithRange(request, output);
    expect(await readFile(output)).toEqual(bytes);
    expect(request.mock.calls).toEqual([[0, 0], [0, 8388607], [8388608, 8388624]]);
    expect(await readdir(dirs[dirs.length - 1])).toEqual(['attachment.zip']);
  });
  it('retries transport failure at the same offset', async () => {
    const output = await outputPath();
    const request = vi.fn(async (start: number, end: number) => partial(start, end, 3));
    request.mockImplementationOnce(async () => partial(0, 0, 3));
    request.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    await downloadResourceWithRange(request, output);
    expect(request.mock.calls).toEqual([[0, 0], [0, 2], [0, 2]]);
    expect(await readFile(output)).toEqual(Buffer.alloc(3, 7));
  });
  it('retries interrupted streams without retaining partially written bytes', async () => {
    const output = await outputPath();
    const request = vi.fn(async (start: number, end: number) => partial(start, end, 3));
    request.mockImplementationOnce(async () => partial(0, 0, 3));
    request.mockImplementationOnce(async () => {
      const response = Readable.from((async function* () { yield Buffer.from([99]); throw new Error('reset'); })()) as ResourceStream;
      response.statusCode = 206; response.headers = { 'content-range': 'bytes 0-2/3' }; return response;
    });
    await downloadResourceWithRange(request, output);
    expect(await readFile(output)).toEqual(Buffer.alloc(3, 7));
  });
  it.each(['status', 'offset', 'total', 'short', 'long'])('rejects %s corruption and preserves existing output', async mode => {
    const output = await outputPath();
    await writeFile(output, 'previous-valid-file');
    const request = vi.fn(async () => partial(0, 0, 3));
    request.mockImplementationOnce(async () => partial(0, 0, 3));
    request.mockImplementationOnce(async () => {
      const response = partial(0, 2, 3, Buffer.alloc(mode === 'short' ? 2 : mode === 'long' ? 4 : 3));
      if (mode === 'status') response.statusCode = 200;
      if (mode === 'offset') response.headers = { 'content-range': 'bytes 1-2/3' };
      if (mode === 'total') response.headers = { 'content-range': 'bytes 0-2/4' };
      return response;
    });
    await expect(downloadResourceWithRange(request, output)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readFile(output, 'utf8')).toBe('previous-valid-file');
    expect(await readdir(dirs[dirs.length - 1])).toEqual(['attachment.zip']);
  });
  it('rejects a server ignoring the probe and destroys its stream', async () => {
    const output = await outputPath();
    const response = partial(0, 0, 3); response.statusCode = 200;
    await expect(downloadResourceWithRange(async () => response, output)).rejects.toThrow('invalid partial');
    expect(response.destroyed).toBe(true);
    expect(await readdir(dirs[dirs.length - 1])).toEqual([]);
  });
  it('rejects oversized resources before creating a partial file', async () => {
    const output = await outputPath();
    await expect(downloadResourceWithRange(async () => partial(0, 0, 2 ** 31 + 1), output)).rejects.toThrow('2 GiB');
    expect(await readdir(dirs[dirs.length - 1])).toEqual([]);
  });
  it('does not retry 403 or publish a partial file', async () => {
    const output = await outputPath();
    const request = vi.fn(async () => partial(0, 0, 3));
    request.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(downloadResourceWithRange(request, output)).rejects.toThrow('forbidden');
    expect(request).toHaveBeenCalledTimes(1);
    expect(await readdir(dirs[dirs.length - 1])).toEqual([]);
  });
});

describe('downloadMessageResource wiring', () => {
  it('keeps ordinary small downloads on the existing SDK path', async () => {
    const output = await outputPath(); mocks.request.mockResolvedValue(Readable.from(['small-file']));
    await downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output);
    expect(await readFile(output, 'utf8')).toBe('small-file');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0].headers).toBeUndefined();
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
  it.each([true, false])('uses the same app identity for 234037, allowUserTokenFallback=%s', async allowUserTokenFallback => {
    const output = await outputPath(); mocks.request.mockRejectedValueOnce(sizeError(true));
    mocks.request.mockImplementation(async ({ headers }: any) => {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range)!;
      return partial(Number(start), Number(end), 3);
    });
    await downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output, 'ou_sender', { allowUserTokenFallback });
    expect(await readFile(output)).toEqual(Buffer.alloc(3, 7));
    expect(mocks.request.mock.calls.map(([request]) => request.headers?.Range)).toEqual([undefined, 'bytes=0-0', 'bytes=0-2']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
  it('does not ask for login when a size-limit Range attempt fails', async () => {
    const output = await outputPath(); mocks.request.mockRejectedValueOnce(sizeError());
    const rangeError = Object.assign(new Error('range forbidden'), { status: 403 });
    mocks.request.mockRejectedValue(rangeError);
    await expect(downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output)).rejects.toBe(rangeError);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
  it('preserves genuine permission fallback and sender-scoped token lookup', async () => {
    const output = await outputPath(); mocks.request.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output, 'ou_sender')).rejects.toBeInstanceOf(UserTokenMissingError);
    expect(mocks.userToken).toHaveBeenCalledWith('cli_test', 'test-only', 'feishu', 'ou_sender');
  });
  it('still denies passive history before borrowing user tokens', async () => {
    const output = await outputPath(); const denied = Object.assign(new Error('forbidden'), { status: 403 });
    mocks.request.mockRejectedValue(denied);
    await expect(downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output, undefined, { allowUserTokenFallback: false })).rejects.toBe(denied);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
  it.each(['feishu', 'lark'])('handles user-token size limits with Range on the %s host', async brand => {
    mocks.brand = brand;
    const output = await outputPath(); mocks.request.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    mocks.userToken.mockResolvedValue('test-user-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const range = (init?.headers as Record<string, string>)?.Range;
      if (!range) return new Response('{"code":234037}', { status: 400 });
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      return new Response(Buffer.alloc(Number(end) - Number(start) + 1, 7), {
        status: 206, headers: { 'content-range': `bytes ${start}-${end}/3` },
      });
    });
    await downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output);
    expect(await readFile(output)).toEqual(Buffer.alloc(3, 7));
    expect(fetchMock.mock.calls).toHaveLength(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url).startsWith(brand === 'lark' ? 'https://open.larksuite.com/' : 'https://open.feishu.cn/')).toBe(true);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-user-token');
    }
  });
  it('keeps an expired user token as a genuine login error', async () => {
    const output = await outputPath(); mocks.request.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    mocks.userToken.mockResolvedValue('test-user-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('expired', { status: 401 }));
    await expect(downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output)).rejects.toBeInstanceOf(UserTokenMissingError);
  });
  it('does not retry a user-token 401 during Range transfer', async () => {
    const output = await outputPath(); mocks.request.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    mocks.userToken.mockResolvedValue('test-user-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response('{"code":234037}', { status: 400 }));
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from([7]), { status: 206, headers: { 'content-range': 'bytes 0-0/3' } }));
    fetchMock.mockResolvedValue(new Response('expired', { status: 401 }));
    await expect(downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output)).rejects.toBeInstanceOf(UserTokenMissingError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await readdir(dirs[dirs.length - 1])).toEqual([]);
  });
  it('works through the real SDK stream/error interceptors against a local HTTP fixture', async () => {
    const output = await outputPath();
    const ranges: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      if (req.url?.includes('/auth/')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, tenant_access_token: 'test-only-token', expire: 7200 })); return;
      }
      ranges.push(req.headers.range);
      if (!req.headers.range) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"code":234037,"msg":"Downloaded file size exceeds limit."}'); return;
      }
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range)!;
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/3` });
      res.end(Buffer.alloc(Number(end) - Number(start) + 1, 7));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const noop = () => {};
      const client = new Client({ appId: 'cli_range_sdk_test', appSecret: 'test-only',
        domain: `http://127.0.0.1:${address.port}`,
        logger: { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop },
      });
      mocks.request.mockImplementation(request => client.request(request));
      await downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output);
      expect(await readFile(output)).toEqual(Buffer.alloc(3, 7));
      expect(ranges).toEqual([undefined, 'bytes=0-0', 'bytes=0-2']);
      expect(mocks.userToken).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('keeps apiOnly hard-gated before any network or token lookup', async () => {
    const output = await outputPath(); mocks.apiOnly = true;
    await expect(downloadMessageResource('cli_test', 'om_test', 'file_test', 'file', output)).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.userToken).not.toHaveBeenCalled();
  });
});
