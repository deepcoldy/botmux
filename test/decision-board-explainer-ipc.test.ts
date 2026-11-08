/**
 * daemon IPC 上的图文说明：
 *   - POST /api/sessions/:id/decision-board/upload：会话 capability 放在请求头里鉴权（沙箱 CLI 姿势），
 *     鉴权和声明长度在读正文前就拦，流式超限 413；
 *   - GET /api/decision-board/files/:id：HTML 带 CSP sandbox，视频按 Range 回 206 / 416，截图响应不变。
 */
import { request } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, truncateSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  routeHasNarrowUntrustedAuth,
  setDecisionBoardService,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { DecisionBoardService } from '../src/core/decision-board/service.js';
import { decisionBoardFilesDir } from '../src/services/decision-board-store.js';
import { BOARD_HTML_CSP, BOARD_HTML_MAX_BYTES, BOARD_UPLOAD_HEADERS as H, BOARD_VIDEO_MAX_BYTES, BOARD_VIDEO_RANGE_CHUNK } from '../src/core/decision-board/files.js';
import * as workerPool from '../src/core/worker-pool.js';

const APP = 'cli_steward';
const CAP = 'cafebabe'.repeat(8);
const SECRET = 'test-board-explainer-secret';
const SID = 'sess-steward-1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const HTML = Buffer.from('<!doctype html><meta charset="utf-8"><h1>说明</h1>');
/** 大于一个 Range 分块的「视频」：EBML 头 + 按位置可辨认的字节。 */
const VIDEO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251))]);

let dir: string;
let service: DecisionBoardService;
let handle: IpcServerHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-explainer-ipc-'));
  service = new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => ({ enabled: true, chatId: 'oc_steward' }),
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => undefined,
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => 'owner',
    timeZone: () => 'UTC',
    batchAttachmentsDir: id => join(dir, 'att', String(id)),
    banner: () => 'b',
    deliver: async () => ({ sessionId: 'x' }),
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: chatId }),
  });
  setLarkAppId(APP);
  setDecisionBoardService(service);
  setIpcAuthSecret(SECRET);
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => (id === SID
    ? { session: { sessionId: SID }, managedTurnOrigin: { capability: CAP }, larkAppId: APP } as any
    : undefined));
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await handle.close();
  setDecisionBoardService(null);
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.restoreAllMocks();
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addItem(): Promise<number> {
  const res = await service.cli({ action: 'add', title: '改动', noChat: '用例' }, { sessionId: SID }) as { item: { seq: number } };
  return res.item.seq;
}

const base = () => `http://127.0.0.1:${handle.port}`;
const uploadPath = `/api/sessions/${SID}/decision-board/upload`;

function upload(seq: number, name: string, mime: string, data: Buffer, opts: { capability?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': mime, [H.name]: encodeURIComponent(name), [H.ref]: encodeURIComponent(String(seq)) };
  if (opts.capability !== null) headers[H.capability] = opts.capability ?? CAP;
  return fetch(`${base()}${uploadPath}`, { method: 'POST', headers, body: new Uint8Array(data) });
}

function getFile(id: string, headers: Record<string, string> = {}) {
  const path = `/api/decision-board/files/${id}`;
  return fetch(`${base()}${path}`, { headers: daemonIpcAuthHeaders({ secret: SECRET, port: handle.port, method: 'GET', path, headers }) });
}

/** 用 node:http 发：可以声明任意 content-length，或者用 chunked 一点点写。 */
function rawUpload(headers: Record<string, string>, write: (req: ReturnType<typeof request>) => Promise<void>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: handle.port, path: uploadPath, method: 'POST', headers: { [H.capability]: CAP, ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); });
    });
    req.on('error', err => { if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET' && (err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err); });
    void write(req).catch(() => {});
  });
}

async function attachExplainer(seq: number, name: string, mime: string, data: Buffer): Promise<string> {
  const up = await upload(seq, name, mime, data);
  const staged = (await up.json() as { id: string }).id;
  const res = await service.cli({ action: 'attach', ref: String(seq), staged: [staged] }, { sessionId: SID }) as { files: Array<{ id: string }> };
  return res.files[0]!.id;
}

describe('POST /api/sessions/:id/decision-board/upload', () => {
  it('沙箱 CLI 姿势：capability 放请求头上传，再用 JSON attach 引用暂存 id', async () => {
    expect(routeHasNarrowUntrustedAuth('POST', uploadPath)).toBe(true);
    expect(routeHasNarrowUntrustedAuth('GET', uploadPath)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', `${uploadPath}/x`)).toBe(false);

    const seq = await addItem();
    const up = await upload(seq, '改前改后.html', 'text/html', HTML);
    const staged = await up.json() as any;
    expect(up.status).toBe(200);
    expect(staged).toMatchObject({ ok: true, seq, name: '改前改后.html', mime: 'text/html', bytes: HTML.length, warnings: [] });

    const attach = await fetch(`${base()}/api/sessions/${SID}/decision-board`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'attach', ref: String(seq), staged: [staged.id], originCapability: CAP }),
    });
    expect(attach.status).toBe(200);
    expect((await attach.json() as any).files).toEqual([{ id: expect.any(String), name: '改前改后.html', bytes: HTML.length, mime: 'text/html' }]);
  });

  it('没有 capability 或 capability 不对：403，不写暂存', async () => {
    const seq = await addItem();
    for (const capability of [null, 'deadbeef'.repeat(8)]) {
      const res = await upload(seq, 'a.html', 'text/html', HTML, { capability });
      expect(res.status).toBe(403);
    }
    const other = await fetch(`${base()}/api/sessions/someone-else/decision-board/upload`, {
      method: 'POST', headers: { 'content-type': 'text/html', [H.capability]: CAP, [H.ref]: String(seq) }, body: HTML,
    });
    expect(other.status).toBe(403);
  });

  it('不支持的类型 400；事项不存在 404；文件头对不上 400', async () => {
    const seq = await addItem();
    expect((await upload(seq, 'a.svg', 'image/svg+xml', Buffer.from('<svg/>'))).status).toBe(400);
    expect((await upload(seq, 'a.png', 'image/png', PNG)).status).toBe(400);
    expect((await upload(999, 'a.html', 'text/html', HTML)).status).toBe(404);
    const fake = await upload(seq, 'fake.mp4', 'video/mp4', PNG);
    expect(fake.status).toBe(400);
    expect(await fake.json()).toMatchObject({ error: 'invalid_file' });
  });

  it('声明长度超过上限：不读正文直接 413，提示里写明上限', async () => {
    const seq = await addItem();
    const res = await rawUpload({
      'content-type': 'video/mp4', 'content-length': String(BOARD_VIDEO_MAX_BYTES + 1), [H.name]: 'big.mp4', [H.ref]: String(seq),
    }, async req => { req.write(Buffer.alloc(16)); });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: 'file_too_large', message: expect.stringContaining(`${BOARD_VIDEO_MAX_BYTES / 1024 / 1024}MB`) });
  });

  it('没声明长度、边传边超限（chunked）：一样 413，调用方能收到报错', async () => {
    const seq = await addItem();
    const res = await rawUpload({ 'content-type': 'text/html', 'transfer-encoding': 'chunked', [H.name]: 'big.html', [H.ref]: String(seq) }, async req => {
      const block = Buffer.alloc(1024 * 1024, 0x20);
      req.write('<html>');
      for (let i = 0; i <= BOARD_HTML_MAX_BYTES / block.length; i++) {
        if (!req.write(block)) await new Promise(r => req.once('drain', r));
      }
      req.end();
    });
    expect(res.status).toBe(413);
    expect(res.body.message).toContain(`${BOARD_HTML_MAX_BYTES / 1024 / 1024}MB`);
  });
});

describe('GET /api/decision-board/files/:id', () => {
  it('说明页：CSP sandbox（不给 allow-same-origin / allow-scripts）、nosniff、no-referrer、UTF-8', async () => {
    const seq = await addItem();
    const id = await attachExplainer(seq, 'a.html', 'text/html', HTML);
    const res = await getFile(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(BOARD_HTML_CSP);
    expect(res.headers.get('content-security-policy')).toMatch(/(^|;)\s*sandbox\s*(;|$)/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(Buffer.from(await res.arrayBuffer()).equals(HTML)).toBe(true);
  });

  it('视频：Range 回 206 和 Content-Range，后缀范围、越界 416；不带或不认的 Range 也只回第一块', async () => {
    const seq = await addItem();
    const id = await attachExplainer(seq, 'demo.webm', 'video/webm', VIDEO);
    const size = VIDEO.length;

    const first = await getFile(id, { range: 'bytes=0-99' });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 0-99/${size}`);
    expect(first.headers.get('content-length')).toBe('100');
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    expect(first.headers.get('content-type')).toBe('video/webm');
    expect(Buffer.from(await first.arrayBuffer()).equals(VIDEO.subarray(0, 100))).toBe(true);

    const mid = await getFile(id, { range: 'bytes=1000000-1000009' });
    expect(Buffer.from(await mid.arrayBuffer()).equals(VIDEO.subarray(1_000_000, 1_000_010))).toBe(true);

    const tail = await getFile(id, { range: 'bytes=-10' });
    expect(tail.headers.get('content-range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    expect(Buffer.from(await tail.arrayBuffer()).equals(VIDEO.subarray(size - 10))).toBe(true);

    // 拖到任意位置的 open-ended 请求一次最多回一个分块。
    const open = await getFile(id, { range: 'bytes=100-' });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe(`bytes 100-${100 + BOARD_VIDEO_RANGE_CHUNK - 1}/${size}`);
    expect((await open.arrayBuffer()).byteLength).toBe(BOARD_VIDEO_RANGE_CHUNK);

    const past = await getFile(id, { range: `bytes=${size}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${size}`);

    // daemon 从不回整份：Dashboard 收响应没有背压，整份由它按块拼。
    for (const headers of [{}, { range: 'bytes=0-1,5-9' }, { range: 'items=0-5' }, { range: 'bytes=9-1' }]) {
      const head = await getFile(id, headers);
      expect(head.status).toBe(206);
      expect(head.headers.get('accept-ranges')).toBe('bytes');
      expect(head.headers.get('content-range')).toBe(`bytes 0-${BOARD_VIDEO_RANGE_CHUNK - 1}/${size}`);
      expect(Buffer.from(await head.arrayBuffer()).equals(VIDEO.subarray(0, BOARD_VIDEO_RANGE_CHUNK))).toBe(true);
    }
  });

  it('文件变成 0 字节或不见了：回 404，不挂住请求', async () => {
    const seq = await addItem();
    const videoId = await attachExplainer(seq, 'demo.webm', 'video/webm', VIDEO);
    const htmlId = await attachExplainer(seq, 'a.html', 'text/html', HTML);
    const files = decisionBoardFilesDir(dir, APP);
    const [video] = readdirSync(files).filter(f => f.endsWith('.webm'));
    const [page] = readdirSync(files).filter(f => f.endsWith('.html'));
    truncateSync(join(files, video!), 0);
    unlinkSync(join(files, page!));

    for (const headers of [{}, { range: 'bytes=0-' }, { range: 'bytes=-10' }]) {
      const res = await getFile(videoId, headers);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false });
    }
    const gone = await getFile(htmlId);
    expect(gone.status).toBe(404);
  });

  // 读 /proc/self/fd 数 daemon 手上还开着几个这份视频的描述符；只有 Linux 有（CI 和 daemon 都跑在 Linux）。
  it.skipIf(!existsSync('/proc/self/fd'))('播放器中途取消视频请求：daemon 关掉文件，不留打开的描述符', async () => {
    const seq = await addItem();
    const id = await attachExplainer(seq, 'demo.webm', 'video/webm', VIDEO);
    const files = decisionBoardFilesDir(dir, APP);
    const stored = realpathSync(join(files, readdirSync(files).find(f => f.endsWith('.webm'))!));
    const openFds = () => readdirSync('/proc/self/fd').filter(fd => {
      try { return readlinkSync(`/proc/self/fd/${fd}`) === stored; } catch { return false; }
    }).length;
    const path = `/api/decision-board/files/${id}`;
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => {
        const headers = Object.fromEntries(daemonIpcAuthHeaders({ secret: SECRET, port: handle.port, method: 'GET', path, headers: { range: `bytes=${i}-` } }));
        const req = request({ host: '127.0.0.1', port: handle.port, path, headers }, res => {
          statuses.push(res.statusCode ?? 0);
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => resolve());
        req.end();
      });
    }
    expect(statuses).toEqual(Array(10).fill(206));
    for (const deadline = Date.now() + 2_000; openFds() > 0 && Date.now() < deadline;) await new Promise(r => setTimeout(r, 20));
    expect(openFds()).toBe(0);
  });

  it('截图的响应和以前一样：不带 CSP、不认 Range', async () => {
    const seq = await addItem();
    const res = await service.cli({ action: 'attach', ref: String(seq), files: [{ name: 'a.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') }] }, { sessionId: SID }) as any;
    const img = await getFile(res.files[0].id, { range: 'bytes=0-1' });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-security-policy')).toBeNull();
    expect(img.headers.get('accept-ranges')).toBeNull();
    expect(img.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('不带 host 签名读不到文件', async () => {
    const seq = await addItem();
    const id = await attachExplainer(seq, 'a.html', 'text/html', HTML);
    expect((await fetch(`${base()}/api/decision-board/files/${id}`)).status).toBe(401);
  });
});
