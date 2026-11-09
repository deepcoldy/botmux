/**
 * 真 CLI 进程：管家会话里跑 `botmux board attach <编号> 说明.html 录屏.webm 截图.png`，经真的 daemon IPC
 * （先逐个上传到暂存区，再一次 attach）落到看板上。两种通道都走一遍：沙箱里只读得到本会话轮换凭证的，
 * 和读得到宿主密钥的。另外：超限的文件不上传；老 daemon 不认识上传接口时截图照旧能附、说明页停在 attach 之前。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDecisionBoardService, setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { DecisionBoardService } from '../src/core/decision-board/service.js';
import { BOARD_VIDEO_MAX_BYTES } from '../src/core/decision-board/files.js';
import { managedOriginCapabilityPath, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';
import { decisionBoardStagingDir } from '../src/services/decision-board-staging.js';
import * as workerPool from '../src/core/worker-pool.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const APP = 'cli_steward';
const SID = 'sess-steward';
const SECRET = 'test-ipc-secret';
const CHANNEL = 'ab'.repeat(32);
const CAP = 'cd'.repeat(32);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(256, 7)]);
const HTML = '<!doctype html><meta charset="utf-8"><h1>改了什么</h1>';

let root: string;
let dataDir: string;
let boardDir: string;
let service: DecisionBoardService;
let ipc: IpcServerHandle;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'board-attach-cli-'));
  dataDir = join(root, 'data');
  boardDir = join(root, 'board');
  mkdirSync(join(root, '.botmux'), { recursive: true });
  writeFileSync(join(root, '.botmux', 'bots.json'), '[]');
  seedPersistedSessionRows(dataDir, APP, {
    [SID]: { sessionId: SID, chatId: 'oc_steward', larkAppId: APP, rootMessageId: 'om_root', status: 'active', title: '管家', createdAt: new Date(0).toISOString() },
  });
  service = new DecisionBoardService({
    dataDir: boardDir,
    larkAppId: () => APP,
    steward: () => ({ enabled: true, chatId: 'oc_steward' }),
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => undefined,
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => 'owner',
    timeZone: () => 'UTC',
    batchAttachmentsDir: id => join(boardDir, 'att', String(id)),
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
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BOTMUX_'))),
    HOME: root, USERPROFILE: root,
    BOTS_CONFIG: join(root, '.botmux', 'bots.json'),
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SESSION_ID: SID, BOTMUX_LARK_APP_ID: APP, BOTMUX_CHAT_ID: 'oc_steward',
    BOTMUX_ORIGIN_CHANNEL_ID: CHANNEL,
    BOTMUX_DAEMON_IPC_PORT: String(ipc.port),
  };
});

afterEach(async () => {
  await ipc.close();
  setDecisionBoardService(null);
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.restoreAllMocks();
  service.close();
  rmSync(root, { recursive: true, force: true });
});

function useTransport(transport: 'capability' | 'host'): void {
  if (transport === 'host') writeFileSync(join(root, '.botmux', '.dashboard-secret'), SECRET, { mode: 0o600 });
  else replaceManagedOriginCapabilityFile(managedOriginCapabilityPath(dataDir, SID, CHANNEL), JSON.stringify({ sessionId: SID, channelId: CHANNEL, capability: CAP }));
}

function file(name: string, data: Buffer | string): string {
  const path = join(root, name);
  writeFileSync(path, data);
  return path;
}

function attach(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ['board', 'attach', ...args], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function addItem(): Promise<number> {
  const res = await service.cli({ action: 'add', title: '改动', noChat: '用例' }, { sessionId: SID }) as { item: { seq: number } };
  return res.item.seq;
}

const staging = () => {
  const dir = decisionBoardStagingDir(boardDir, APP);
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe('botmux board attach（真进程）', () => {
  it.each(['capability', 'host'] as const)('%s 通道：说明页 + 视频 + 截图一次附上，只记一条历史，暂存区清空', async transport => {
    useTransport(transport);
    const seq = await addItem();
    const result = await attach([String(seq), file('说明.html', HTML), file('录屏.webm', WEBM), file('shot.png', PNG), '--note', '改前改后']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`#${seq}`);

    const detail = service.detail(seq, 'owner');
    expect(detail.files.map(f => [f.mime, f.name]).sort()).toEqual([
      ['image/png', 'shot.png'], ['text/html', '说明.html'], ['video/webm', '录屏.webm'],
    ]);
    const events = detail.events.filter(e => e.kind === 'attach');
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('改前改后');
    expect(staging()).toEqual([]);
  }, 60_000);

  it('说明页里有脚本：照样附上，但在 stderr 提醒', async () => {
    useTransport('capability');
    const seq = await addItem();
    const result = await attach([String(seq), file('a.html', `${HTML}<script>alert(1)</script>`)]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/⚠ a\.html/);
    expect(service.detail(seq, 'owner').files).toHaveLength(1);
  }, 60_000);

  it('视频超过上限：本地就拒，不上传、不附', async () => {
    useTransport('capability');
    const seq = await addItem();
    const big = file('big.webm', WEBM);
    truncateSync(big, BOARD_VIDEO_MAX_BYTES + 1);
    const result = await attach([String(seq), big]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${BOARD_VIDEO_MAX_BYTES / 1024 / 1024}MB`);
    expect(service.detail(seq, 'owner').files).toEqual([]);
    expect(staging()).toEqual([]);
  }, 60_000);
});

describe('老 daemon（没有上传接口）', () => {
  let old: Server;
  let calls: string[];

  beforeEach(async () => {
    calls = [];
    old = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      calls.push(`${req.method} ${req.url}`);
      if (req.url!.endsWith('/decision-board')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, seq: 1, files: [{ id: 'f1' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
    await new Promise<void>(resolve => old.listen(0, '127.0.0.1', resolve));
    env.BOTMUX_DAEMON_IPC_PORT = String((old.address() as AddressInfo).port);
    useTransport('capability');
  });

  afterEach(async () => {
    old.closeAllConnections();
    await new Promise<void>(resolve => old.close(() => resolve()));
  });

  it('只附截图：和以前一样只发一次 attach', async () => {
    const result = await attach(['1', file('shot.png', PNG)]);
    expect(result.code, result.stderr).toBe(0);
    expect(calls).toEqual([`POST /api/sessions/${SID}/decision-board`]);
  }, 60_000);

  it('附说明页：上传被拒就停，不发 attach，提示升级 daemon', async () => {
    const result = await attach(['1', file('a.html', HTML), file('shot.png', PNG)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('daemon');
    expect(calls).toEqual([`POST /api/sessions/${SID}/decision-board/upload`]);
  }, 60_000);
});
