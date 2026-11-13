/**
 * `botmux owner-board`：参数解析，以及经真实 daemon IPC 服务（host HMAC 外层闸）读看板、提交决定。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setDecisionBoardService,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { DecisionBoardService, type DecisionBoardServiceDeps } from '../src/core/decision-board/service.js';
import { runOwnerBoardCommand, type OwnerBoardCommandDeps } from '../src/cli/owner-board-command.js';
import type { StewardConfig } from '../src/core/decision-board/model.js';

const APP = 'cli_steward';
const SECRET = 'owner-board-secret';

async function run(argv: string[], deps: OwnerBoardCommandDeps = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runOwnerBoardCommand(argv, {
    write: text => { stdout += text; },
    writeError: text => { stderr += text; },
    ...deps,
  });
  return { code, stdout, stderr, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined };
}

describe('owner-board arguments', () => {
  it.each([
    [['list']],
    [['show', '--bot', APP]],
    [['show', '--bot', APP, 'abc']],
    [['list', '--bot', APP, '--state', 'decide,maybe']],
    [['list', '--bot', APP, '--choice', 'A']],
    [['decide', '--bot', APP, '3', '--request-id', 'req-00000001', '--choice', 'A']],
    [['decide', '--bot', APP, '3', '--ask-key', 'k', '--request-id', 'short', '--choice', 'A']],
    [['decide', '--bot', APP, '3', '--ask-key', 'k', '--request-id', 'req-00000001']],
    [['merge', '--bot', APP]],
    [['boards', '--unknown']],
  ])('rejects %j with exit 2 before touching any daemon', async (argv) => {
    let touched = false;
    const r = await run(argv, { secret: 's', discover: () => { touched = true; return []; } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('botmux owner-board');
    expect(touched).toBe(false);
  });
});

describe('owner-board over daemon IPC', () => {
  let dir: string;
  let steward: StewardConfig | undefined;
  let delivered: Array<Parameters<DecisionBoardServiceDeps['deliver']>[0]>;
  let service: DecisionBoardService;
  let handle: IpcServerHandle;
  let deadPort: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'owner-board-cli-'));
    steward = { enabled: true, chatId: 'oc_steward' };
    delivered = [];
    service = new DecisionBoardService({
      dataDir: dir,
      larkAppId: () => APP,
      steward: () => steward,
      locale: () => 'zh',
      brand: () => 'feishu',
      dashboardOrigin: () => 'https://dash.example',
      ownerOpenId: () => 'ou_owner',
      ownerName: async () => '主人',
      timeZone: () => 'UTC',
      batchAttachmentsDir: id => join(dir, 'att', String(id)),
      banner: () => 'b',
      deliver: async input => { delivered.push(input); return { sessionId: 'sess-steward' }; },
      log: () => {},
      lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: chatId }),
    });
    setLarkAppId(APP);
    setDecisionBoardService(service);
    setIpcAuthSecret(SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const probe = createServer();
    deadPort = await new Promise<number>(resolve => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port)));
    await new Promise<void>(resolve => probe.close(() => resolve()));
  });

  afterEach(async () => {
    await handle.close();
    setDecisionBoardService(null);
    setIpcAuthSecret(null);
    setLarkAppId('');
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const daemons = () => [
    { larkAppId: APP, ipcPort: handle.port, botName: '管家' },
    { larkAppId: 'cli_gone', ipcPort: deadPort },
  ];
  const deps = (over: OwnerBoardCommandDeps = {}): OwnerBoardCommandDeps => ({ secret: SECRET, discover: daemons, fetch: fetchDaemonIpc, timeoutMs: 3_000, env: {}, ...over });

  async function addDecide(): Promise<number> {
    const res = await service.cli({
      action: 'add', title: 'PR #1 合不合', fields: { state: 'decide', question: '合不合？', recommend: 'A' },
      options: ['A=合 → 风险小', 'B=不合'], noChat: '用例',
    }, { sessionId: 'sess-1' }) as { item: { seq: number } };
    return res.item.seq;
  }

  it('boards 只列开着管家、连得上的 daemon', async () => {
    await addDecide();
    const r = await run(['boards'], deps());
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      ok: true,
      boards: [{ larkAppId: APP, botName: '管家', ready: true, chatId: 'oc_steward', counts: { decide: 1, active: 0, all: 1 } }],
    });

    steward = undefined;
    expect((await run(['boards'], deps())).json).toEqual({ ok: true, boards: [] });
  });

  it('list → show → decide：读到的 askKey 原样带回即可提交，决定投进管家会话', async () => {
    const seq = await addDecide();
    const list = await run(['list', '--bot', APP], deps());
    expect(list.code).toBe(0);
    expect(list.json).toMatchObject({ ok: true, larkAppId: APP, states: ['decide', 'accept'], steward: { enabled: true, ready: true } });
    const item = list.json.items[0];
    expect(item).toMatchObject({ seq, title: 'PR #1 合不合', state: 'decide', question: '合不合？', recommend: 'A' });

    const show = await run(['show', '--bot', APP, `#${seq}`], deps());
    expect(show.code).toBe(0);
    expect(show.json.item).toMatchObject({ seq, askKey: item.askKey, events: expect.any(Array) });

    const decide = await run([
      'decide', '--bot', APP, String(seq), '--ask-key', item.askKey, '--choice', 'A', '--text', '合吧\n顺手发版', '--request-id', 'openlark-0001',
    ], deps());
    expect(decide.code).toBe(0);
    expect(decide.json).toEqual({
      ok: true,
      duplicate: false,
      decision: { seq, choice: 'A', text: '合吧\n顺手发版', handled: false },
      batch: { id: 1, delivery: 'delivered' },
      supersedes: [],
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.prompt).toContain('合吧\n顺手发版');

    const stale = await run(['decide', '--bot', APP, String(seq), '--ask-key', 'deadbeef0000', '--choice', 'B', '--request-id', 'openlark-0002'], deps());
    expect(stale.code).toBe(1);
    expect(stale.json).toMatchObject({ ok: false, error: 'ask_changed', status: 409 });
  });

  it('凭证不对时 daemon 拒绝，不读不写；bot 不在线时直接报 daemon_offline', async () => {
    const seq = await addDecide();
    const askKey = service.ownerDetail(seq).item.askKey;
    const denied = await run(['decide', '--bot', APP, String(seq), '--ask-key', askKey, '--choice', 'A', '--request-id', 'openlark-0003'],
      deps({ secret: 'wrong-secret' }));
    expect(denied.code).toBe(1);
    expect(denied.json).toMatchObject({ ok: false, error: 'unauthorized', status: 401 });
    expect((await run(['list', '--bot', APP], deps({ secret: 'wrong-secret' }))).json).toMatchObject({ error: 'unauthorized' });
    expect(service.store().decisionsFor(APP, seq, false)).toEqual([]);
    expect(delivered).toEqual([]);

    const offline = await run(['list', '--bot', 'cli_nowhere'], deps());
    expect(offline.code).toBe(1);
    expect(offline.json).toEqual({ ok: false, error: 'daemon_offline', larkAppId: 'cli_nowhere' });
  });

  it('在 botmux 会话里（继承了 BOTMUX_SESSION_ID）不替 owner 提交决定，读照常', async () => {
    const seq = await addDecide();
    const askKey = service.ownerDetail(seq).item.askKey;
    const env = { BOTMUX_SESSION_ID: 'sess-agent' };
    const r = await run(['decide', '--bot', APP, String(seq), '--ask-key', askKey, '--choice', 'A', '--request-id', 'openlark-0004'], deps({ env }));
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, error: 'inside_botmux_session' });
    expect(service.store().decisionsFor(APP, seq, false)).toEqual([]);
    expect((await run(['list', '--bot', APP], deps({ env }))).code).toBe(0);
  });

  it('不经 host HMAC 的请求在外层闸就被拒', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/decision-board/owner/items`);
    expect(res.status).toBe(401);
  });

  it('没开管家的 bot 报 not_steward', async () => {
    steward = undefined;
    const r = await run(['list', '--bot', APP], deps());
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, error: 'not_steward', status: 409 });
  });
});
