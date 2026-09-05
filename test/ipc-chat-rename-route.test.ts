import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as sessionStore from '../src/services/session-store.js';
import * as botRegistry from '../src/bot-registry.js';
import { cliAuthBind, signCliAuth } from '../src/dashboard/auth.js';
import { logger } from '../src/utils/logger.js';

const CAP = 'ab12cd34'.repeat(8);
const TEST_IPC_SECRET = 'test-ipc-secret-deadbeef';
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function postRename(name: string): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-chat-rename/chat-rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, proactive: true, originCapability: CAP }),
  });
}

const RENAME_PATH = '/api/sessions/s-chat-rename/chat-rename';

async function postRenameBody(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}${RENAME_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** 真实 HMAC 签名 → 请求被标记为 trusted-host（sessionCliIpcAuth 放行，
 *  但不绑定任何 turn origin）。 */
function trustedHostHeaders(): Record<string, string> {
  const auth = signCliAuth(TEST_IPC_SECRET, cliAuthBind('POST', RENAME_PATH, handle!.port));
  return {
    'X-Botmux-Cli-Ts': auth.ts,
    'X-Botmux-Cli-Nonce': auth.nonce,
    'X-Botmux-Cli-Auth': auth.sig,
  };
}

/** renameChat mock：同名幂等；不同名时先过 beforeUpdate 防抖闸。 */
function mockRenameChatWithGate(current: { name: string }): ReturnType<typeof vi.fn> {
  return vi.spyOn(groupsStore, 'renameChat').mockImplementation(async (_appId, _chatId, newName, opts) => {
    if (current.name === newName) return { ok: true, oldName: current.name, newName, changed: false };
    const gate = opts?.beforeUpdate?.();
    if (gate && !gate.ok) return { ...gate, oldName: current.name, newName };
    const oldName = current.name;
    current.name = newName;
    return { ok: true, oldName, newName, changed: true };
  }) as unknown as ReturnType<typeof vi.fn>;
}

describe('POST /api/sessions/:sessionId/chat-rename', () => {
  it('returns an idempotent success for a proactive same-name retry before applying cooldown', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-chat-rename', chatDisplayName: 'old' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-chat-rename-route-test',
      chatId: 'oc-chat-rename-route-test',
      chatType: 'group',
    } as any);
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(new Map());
    vi.spyOn(botRegistry, 'getBotOpenId').mockReturnValue('ou_test_bot');

    let currentName = 'old';
    const beforeUpdateCalls: string[] = [];
    vi.spyOn(groupsStore, 'renameChat').mockImplementation(async (_appId, _chatId, newName, opts) => {
      if (currentName === newName) {
        return { ok: true, oldName: currentName, newName, changed: false };
      }
      beforeUpdateCalls.push(newName);
      const gate = opts?.beforeUpdate?.();
      if (gate && !gate.ok) return { ...gate, oldName: currentName, newName };
      const oldName = currentName;
      currentName = newName;
      return { ok: true, oldName, newName, changed: true };
    });

    const first = await postRename('new');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new' });

    const sameNameRetry = await postRename('new');
    expect(sameNameRetry.status).toBe(200);
    expect(await sameNameRetry.json()).toMatchObject({ ok: true, changed: false, oldName: 'new', newName: 'new' });

    const differentNameRetry = await postRename('different');
    expect(differentNameRetry.status).toBe(429);
    expect(await differentNameRetry.json()).toMatchObject({
      ok: false,
      error: 'rate_limited',
      oldName: 'new',
      newName: 'different',
    });
    expect(beforeUpdateCalls).toEqual(['new', 'different']);
  });

  it('keeps the rename a success (200) when local cache refresh throws (FR-7)', async () => {
    const activeSession = { sessionId: 's-chat-rename', chatDisplayName: 'old' };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: activeSession,
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-fr7',
      chatId: 'oc-fr7',
      chatType: 'group',
    } as any);
    // One active session in the same chat, so the cache-sync loop runs and hits
    // the throwing store write below.
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(
      new Map([['s-chat-rename', { chatId: 'oc-fr7', session: activeSession } as any]]),
    );
    vi.spyOn(botRegistry, 'getBotOpenId').mockReturnValue('ou_test_bot');
    // Lark write succeeds…
    vi.spyOn(groupsStore, 'renameChat').mockResolvedValue({
      ok: true, oldName: 'old', newName: 'new', changed: true,
    });
    // …but persisting the refreshed cache blows up (ENOSPC/EACCES surrogate).
    const updateSpy = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const res = await postRename('new');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new' });
    // The failing write was actually attempted (proving the catch, not a skip).
    expect(updateSpy).toHaveBeenCalledOnce();
    // FR-7 requires a cache-refresh warning be recorded on failure.
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('cache_refresh_failed'))).toBe(true);
  });

  it('honors user_explicit (no cooldown) only with a valid current-turn origin credential', async () => {
    // read-isolated CLI 路径：携带与 managedTurnOrigin 匹配的 capability →
    // user_explicit 成立，两次不同名改名都不应被防抖拦截。
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-chat-rename', chatDisplayName: 'old' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-chat-rename-turn',
      chatId: 'oc-chat-rename-turn',
      chatType: 'group',
    } as any);
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(new Map());
    vi.spyOn(botRegistry, 'getBotOpenId').mockReturnValue('ou_test_bot');
    const current = { name: 'old' };
    mockRenameChatWithGate(current);

    const first = await postRenameBody({ name: 'new-a', originCapability: CAP });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new-a' });

    // 无防抖：窗口内第二次不同名改名同样成功（user_explicit 不 record cooldown）。
    const second = await postRenameBody({ name: 'new-b', originCapability: CAP });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, changed: true, oldName: 'new-a', newName: 'new-b' });
    expect(current.name).toBe('new-b');
  });

  it('forces proactive cooldown on a user_explicit claim without a turn-origin credential (trusted-host has no turn binding)', async () => {
    // trusted-host（HMAC 签名的本机请求）只证明「本机进程」，不绑定用户 turn：
    // sessionCliIpcAuth 放行，但 proveCurrentTurnOrigin 不放行 → 强制
    // ai_proactive 走防抖。堵住 agent 漏传 --proactive 绕过防抖的口子。
    setIpcAuthSecret(TEST_IPC_SECRET);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-chat-rename', chatDisplayName: 'old' },
      larkAppId: 'app-chat-rename-noturn',
      chatId: 'oc-chat-rename-noturn',
      chatType: 'group',
    } as any);
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(new Map());
    vi.spyOn(botRegistry, 'getBotOpenId').mockReturnValue('ou_test_bot');
    const current = { name: 'old' };
    mockRenameChatWithGate(current);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    // 先起服务拿 port（trustedHostHeaders 签名需要绑定 port）。authRequired
    // 才会走 HMAC 中间件把请求标记为 trusted-host。
    if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const first = await postRenameBody({ name: 'new-a' }, trustedHostHeaders());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new-a' });

    // 被强制按 ai_proactive 记录了防抖 → 窗口内第二次不同名改名 429。
    const second = await postRenameBody({ name: 'new-b' }, trustedHostHeaders());
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ ok: false, error: 'rate_limited', newName: 'new-b' });
    expect(current.name).toBe('new-a');
    // 审计日志如实记录 trigger=ai_proactive（而非自报的 user_explicit）。
    expect(infoSpy.mock.calls.some(([msg]) =>
      String(msg).includes('[chat-rename:audit] result=success') && String(msg).includes('trigger=ai_proactive'))).toBe(true);
  });
});
