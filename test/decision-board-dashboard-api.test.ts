/**
 * Dashboard 侧决策看板接口：谁能进、草稿归属与提交人怎么补、只转给已知 bot；以及 H5 免登
 * 只额外放开看板这一组路径、免登回跳认 /board/<app>/<seq>。
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { decisionBoardEntryRedirect, handleDecisionBoardApi, type DecisionBoardApiDeps } from '../src/dashboard/decision-board-api.js';
import { workbenchH5Capability } from '../src/dashboard/auth.js';
import { safeDashboardH5ReturnTo } from '../src/dashboard/h5-auth.js';
import type { DashboardRequestIdentity } from '../src/dashboard/request-identity.js';

interface Captured { status?: number; headers?: Record<string, string>; body?: string }

function fakeRes(): { res: ServerResponse; out: Captured } {
  const out: Captured = {};
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; return this; },
    end(body?: string | Buffer) { out.body = body === undefined ? '' : String(body); },
  } as unknown as ServerResponse;
  return { res, out };
}

function fakeReq(method: string, body?: unknown, contentType = 'application/json'): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).headers = { 'content-type': contentType };
  return stream;
}

const H5: DashboardRequestIdentity = {
  kind: 'feishu-h5', userId: 'h5:ou_x', authSessionId: 'h5s', previewCapability: 'readonly', canManageHost: false,
  principalUnionId: 'on_owner',
} as DashboardRequestIdentity;

function deps(over: Partial<DecisionBoardApiDeps> = {}): { deps: DecisionBoardApiDeps; calls: Array<{ app: string; path: string; init: RequestInit }> } {
  const calls: Array<{ app: string; path: string; init: RequestInit }> = [];
  return {
    calls,
    deps: {
      identity: null,
      canManageHost: true,
      proxyToDaemon: async (app, path, init) => {
        calls.push({ app, path, init });
        if (path.endsWith('/meta')) return new Response(JSON.stringify({ ok: true, counts: { decide: 2, active: 1, all: 5 } }), { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      },
      bots: () => [
        { larkAppId: 'cli_s', botName: '管家', steward: { enabled: true, chatId: 'oc_s' }, online: true },
        { larkAppId: 'cli_off', botName: '普通', online: true },
      ],
      readJsonBody: async (req: IncomingMessage) => {
        const chunks: Buffer[] = [];
        for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c);
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      },
      ...over,
    },
  };
}

async function call(method: string, path: string, d: DecisionBoardApiDeps, body?: unknown, contentType?: string) {
  const { res, out } = fakeRes();
  const handled = await handleDecisionBoardApi(fakeReq(method, body, contentType), res, new URL(`http://x${path}`), d);
  return { handled, out, json: out.body ? JSON.parse(out.body) : undefined };
}

describe('handleDecisionBoardApi', () => {
  it('不是看板路径不接手', async () => {
    expect((await call('GET', '/api/sessions', deps().deps)).handled).toBe(false);
  });

  it('既不是管理身份也不是 H5 免登身份：401，不转发', async () => {
    const d = deps({ canManageHost: false, identity: null });
    const r = await call('GET', '/api/decision-board/cli_s/items', d.deps);
    expect(r.out.status).toBe(401);
    expect(d.calls).toEqual([]);
  });

  it('H5 免登身份可以读看板', async () => {
    const d = deps({ canManageHost: false, identity: H5 });
    const r = await call('GET', '/api/decision-board/cli_s/items?view=active&q=pr', d.deps);
    expect(r.out.status).toBe(200);
    expect(d.calls[0]).toMatchObject({ app: 'cli_s', path: '/api/decision-board?author=owner&view=active&q=pr' });
  });

  it('boards 只列开了管家的 bot，并带上 daemon 给的计数', async () => {
    const d = deps();
    const r = await call('GET', '/api/decision-board/boards', d.deps);
    expect(r.json.boards).toEqual([{ larkAppId: 'cli_s', botName: '管家', online: true, steward: { enabled: true, ready: true, chatId: 'oc_s' }, counts: { decide: 2, active: 1, all: 5 } }]);
  });

  it('草稿统一记在 owner 名下，提交人按请求身份记（平台/H5 用 union_id，本机为 local）', async () => {
    const d = deps({ canManageHost: false, identity: H5 });
    await call('PUT', '/api/decision-board/cli_s/items/3/draft', d.deps, { choice: 'A', text: 't', fileIds: [], baseRev: 2, author: 'forged' });
    expect(JSON.parse(String(d.calls[0].init.body))).toEqual({ author: 'owner', choice: 'A', text: 't', fileIds: [], baseRev: 2 });
    await call('POST', '/api/decision-board/cli_s/submit', d.deps, { nonce: 'n', items: [{ seq: 3, draftUpdatedAt: 1 }], submitter: 'forged' });
    expect(JSON.parse(String(d.calls[1].init.body))).toEqual({ author: 'owner', submitter: 'u:on_owner', nonce: 'n', items: [{ seq: 3, draftUpdatedAt: 1 }] });

    const local = deps();
    await call('POST', '/api/decision-board/cli_s/submit', local.deps, { nonce: 'n', items: [] });
    expect(JSON.parse(String(local.calls[0].init.body)).submitter).toBe('local');
  });

  it('写入要求 JSON 请求体；未知 bot 404', async () => {
    const d = deps();
    expect((await call('POST', '/api/decision-board/cli_s/submit', d.deps, { nonce: 'n' }, 'text/plain')).out.status).toBe(400);
    expect((await call('GET', '/api/decision-board/cli_nope/items', d.deps)).out.status).toBe(404);
    expect(d.calls).toEqual([]);
  });

  it('图片原样回传，带 nosniff', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const d = deps({ proxyToDaemon: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) });
    const { res, out } = fakeRes();
    let raw: Buffer | undefined;
    (res as any).end = (b: Buffer) => { raw = b; };
    await handleDecisionBoardApi(fakeReq('GET'), res, new URL('http://x/api/decision-board/cli_s/files/abcdef1234567890'), d.deps);
    expect(out.status).toBe(200);
    expect(out.headers?.['content-type']).toBe('image/png');
    expect(out.headers?.['x-content-type-options']).toBe('nosniff');
    expect(raw?.equals(png)).toBe(true);
  });
});

describe('H5 免登对看板的放行', () => {
  it('只放开看板这一组路径，guide 只读、submit 只能 POST', () => {
    expect(workbenchH5Capability('GET', '/api/decision-board/boards')).toBe('board.view');
    expect(workbenchH5Capability('GET', '/api/decision-board/cli_s/items')).toBe('board.view');
    expect(workbenchH5Capability('GET', '/api/decision-board/cli_s/items/3')).toBe('board.view');
    expect(workbenchH5Capability('GET', '/api/decision-board/cli_s/files/abc')).toBe('board.view');
    expect(workbenchH5Capability('PUT', '/api/decision-board/cli_s/items/3/draft')).toBe('board.decide');
    expect(workbenchH5Capability('POST', '/api/decision-board/cli_s/submit')).toBe('board.decide');
    expect(workbenchH5Capability('GET', '/api/decision-board/cli_s/submit')).toBeNull();
    expect(workbenchH5Capability('POST', '/api/decision-board/cli_s/guide')).toBeNull();
    // 看板之外的管理接口不受影响
    expect(workbenchH5Capability('PUT', '/api/bots/cli_s/steward')).toBeNull();
    expect(workbenchH5Capability('GET', '/api/settings')).toBeNull();
  });

  it('免登后可回到事项链接', () => {
    expect(safeDashboardH5ReturnTo('/board/cli_abc/12')).toBe('/board/cli_abc/12');
    expect(safeDashboardH5ReturnTo('/board/cli_abc/12/x')).toBe('/');
    expect(safeDashboardH5ReturnTo('/board/../settings/1')).toBe('/');
  });
});

describe('事项链接入口 /board/<app>/<seq>', () => {
  const h5 = { enabled: true, entryPath: '/auth/feishu' };
  it('已登录进无边框壳的详情页；未登录且有 H5 免登先免登再回来；没配 H5 交给 SPA 登录层', () => {
    expect(decisionBoardEntryRedirect('/board/cli_x/12', { signedIn: true, h5 }))
      .toBe('/#/board/cli_x/12?botmuxWorkbenchShell=immersive');
    expect(decisionBoardEntryRedirect('/board/cli_x/12', { signedIn: false, h5 }))
      .toBe('/auth/feishu?returnTo=%2Fboard%2Fcli_x%2F12');
    expect(decisionBoardEntryRedirect('/board/cli_x/12', { signedIn: false, h5: { ...h5, enabled: false } }))
      .toBe('/#/board/cli_x/12?botmuxWorkbenchShell=immersive');
  });

  it('只认 /board/<app>/<seq> 这一种形状', () => {
    expect(decisionBoardEntryRedirect('/board/cli_x', { signedIn: true, h5 })).toBeNull();
    expect(decisionBoardEntryRedirect('/board/cli_x/12/extra', { signedIn: true, h5 })).toBeNull();
    expect(decisionBoardEntryRedirect('/board/a%2Fb/1', { signedIn: true, h5 })).toBeNull();
    expect(decisionBoardEntryRedirect('/settings', { signedIn: true, h5 })).toBeNull();
  });
});
