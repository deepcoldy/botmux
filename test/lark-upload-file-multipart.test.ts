/**
 * uploadFile must send the `file` multipart part WITH a filename.
 *
 * Passing a Buffer to the SDK made axios/form-data emit
 * `Content-Disposition: form-data; name="file"` (no filename). Feishu treats
 * such a part as a plain form field and rejects it with 400 code=9499 once it
 * passes ~25–26MiB, well under the documented 30MiB file limit.
 *
 * This drives the REAL SDK + axios + form-data against a local fake Feishu and
 * inspects the bytes on the wire.
 *
 * Run:  bun run vitest run test/lark-upload-file-multipart.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

const S = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: () => { throw new Error('not registered'); },
    getBotUploadClient: () => S.client,
  };
});

import { uploadFile } from '../src/im/lark/client.js';

type Captured = { body: Buffer; contentLength?: string; transferEncoding?: string };
let server: Server;
let uploads: Captured[] = [];
let failNext = 0;
let workDir: string;
const savedProxyEnv: Record<string, string | undefined> = {};
const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];

function fileDisposition(body: Buffer): string | undefined {
  return body.toString('latin1').match(/Content-Disposition: form-data; name="file"[^\r\n]*/)?.[0];
}

beforeAll(async () => {
  for (const k of PROXY_KEYS) { savedProxyEnv[k] = process.env[k]; delete process.env[k]; }
  workDir = mkdtempSync(join(tmpdir(), 'upload-multipart-test-'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.includes('tenant_access_token')) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: 't-test', expire: 7200 }));
        return;
      }
      if (req.url?.startsWith('/open-apis/im/v1/files')) {
        uploads.push({
          body: Buffer.concat(chunks),
          contentLength: req.headers['content-length'],
          transferEncoding: req.headers['transfer-encoding'],
        });
        if (failNext > 0) {
          failNext--;
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 2200, msg: 'Internal Error' }));
          return;
        }
        res.end(JSON.stringify({ code: 0, data: { file_key: 'file_v3_test' } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  // The SDK treats `:segment` in the URL as a path param, so a domain with a
  // port is rejected; point it at a fake host and rewrite on the way out.
  const FAKE = 'http://fake-feishu.test';
  const http = Lark.defaultHttpInstance;
  http.interceptors.request.use((cfg) => {
    if (cfg.url?.startsWith(FAKE)) cfg.url = `http://127.0.0.1:${port}` + cfg.url.slice(FAKE.length);
    return cfg;
  });
  S.client = new Lark.Client({
    appId: 'cli_test', appSecret: 's', domain: FAKE, httpInstance: http,
    loggerLevel: Lark.LoggerLevel.error,
  });
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  rmSync(workDir, { recursive: true, force: true });
  for (const k of PROXY_KEYS) if (savedProxyEnv[k] !== undefined) process.env[k] = savedProxyEnv[k];
});

beforeEach(() => { uploads = []; failNext = 0; });

describe('uploadFile multipart file part', () => {
  it('sends a path source with filename and a matching Content-Length', async () => {
    const p = join(workDir, 'report.xlsx');
    const content = Buffer.alloc(64 * 1024, 7);
    writeFileSync(p, content);
    expect(await uploadFile('cli_test', p)).toBe('file_v3_test');
    expect(uploads).toHaveLength(1);
    expect(fileDisposition(uploads[0].body)).toBe('Content-Disposition: form-data; name="file"; filename="report.xlsx"');
    expect(uploads[0].transferEncoding).toBeUndefined();
    expect(Number(uploads[0].contentLength)).toBe(uploads[0].body.length);
    expect(uploads[0].body.includes(content)).toBe(true);
    expect(uploads[0].body.toString('latin1')).toMatch(/name="file_type"\r\n\r\nxls\r\n/);
  });

  it('sends an in-memory source with its name as filename and removes the temp file', async () => {
    const before = readdirSync(tmpdir()).filter(n => n.startsWith('botmux-upload-')).length;
    const bytes = Buffer.from('# reply\nhello\n');
    expect(await uploadFile('cli_test', { name: 'reply.md', bytes })).toBe('file_v3_test');
    expect(fileDisposition(uploads[0].body)).toBe('Content-Disposition: form-data; name="file"; filename="reply.md"');
    expect(uploads[0].body.includes(bytes)).toBe(true);
    expect(readdirSync(tmpdir()).filter(n => n.startsWith('botmux-upload-')).length).toBe(before);
  });

  it('rebuilds the stream when the gate retries, so the retry carries the full file', async () => {
    const p = join(workDir, 'retry.pdf');
    const content = Buffer.alloc(32 * 1024, 3);
    writeFileSync(p, content);
    failNext = 1;
    expect(await uploadFile('cli_test', p)).toBe('file_v3_test');
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(fileDisposition(u.body)).toContain('filename="retry.pdf"');
      expect(u.body.includes(content)).toBe(true);
    }
  });

  it('cleans up when the SDK rejects before reading the stream', async () => {
    const real = S.client;
    S.client = { im: { v1: { file: { create: async () => { throw new Error('boom'); } } } } };
    try {
      const before = readdirSync(tmpdir()).filter(n => n.startsWith('botmux-upload-')).length;
      await expect(uploadFile('cli_test', { name: 'early.txt', bytes: Buffer.from('x') })).rejects.toThrow('boom');
      // Let a lazily-opening ReadStream surface an unhandled ENOENT if it was left alive.
      await new Promise(r => setTimeout(r, 50));
      expect(readdirSync(tmpdir()).filter(n => n.startsWith('botmux-upload-')).length).toBe(before);
    } finally {
      S.client = real;
    }
  });
});
