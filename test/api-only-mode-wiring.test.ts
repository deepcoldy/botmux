import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as botRegistry from '../src/bot-registry.js';
import { LarkTransportDisabledError } from '../src/bot-registry.js';
import { shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import {
  __testOnly_resetCoreOnlyReadiness,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { triggerSessionTurn } from '../src/core/trigger-session.js';
import * as workerPool from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { downloadMessageResource } from '../src/im/lark/client.js';
import { __testOnly_driveApiCall } from '../src/im/lark/doc-comment.js';
import * as groupsStore from '../src/services/groups-store.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import * as userToken from '../src/utils/user-token.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

/**
 * API-only (core-only / headless) bot mode and no-Feishu-transport sessions.
 *
 * Behavioural tests drive the real entry points (HTTP IPC routes, the trigger
 * path, Lark primitives, the CLI, the core-only entrypoint). The remaining
 * source-structure guards cover security wiring that lives inside the daemon /
 * worker closures with no injectable seam; each one says why it reads source.
 */

const read = (file: string) => readFileSync(resolve(file), 'utf8');

/** Drop whole-line `//` comments so a commented-out copy of the correct code
 *  cannot satisfy a guard while the live statement is broken. */
function stripLineComments(source: string): string {
  return source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
}

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Brace-balanced block opening at the first `{` at/after `marker`. */
function braceBlock(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unbalanced block after ${marker}`);
}

/** Top-level argument lists of every call to `callee` (definitions skipped). */
function callArgs(source: string, callee: string): string[][] {
  const calls: string[][] = [];
  for (const m of source.matchAll(new RegExp(`(?<![\\w.])${callee}\\(`, 'g'))) {
    if (/function\s+$/.test(source.slice(Math.max(0, m.index! - 16), m.index))) continue;
    const args: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = m.index! + callee.length; i < source.length; i++) {
      const ch = source[i];
      if ('([{'.includes(ch) && depth++ === 0) continue;
      if (')]}'.includes(ch) && --depth === 0) { args.push(cur.trim()); break; }
      if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    calls.push(args.filter(a => a !== ''));
  }
  return calls;
}

const daemonSource = stripLineComments(read('src/daemon.ts'));
const workerSource = stripLineComments(read('src/worker.ts'));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function apiOnlyBot(larkAppId = 'local_riff') {
  return {
    config: { larkAppId, larkAppSecret: 'secret-on-disk', apiOnly: true, cliId: 'codex-app', brand: 'feishu' },
    botName: 'Riff',
    botOpenId: `bot_${larkAppId}`,
    resolvedAllowedUsers: [],
  } as any;
}

describe('no-transport sessions on the daemon IPC surface', () => {
  let handle: IpcServerHandle | null = null;
  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    __testOnly_resetCoreOnlyReadiness();
    setIpcAuthSecret(null);
    setLarkAppId('');
  });

  const CAP = 'cd34ab12'.repeat(8);
  function activeSession(chatId: string, larkAppId: string) {
    return {
      session: { sessionId: 's-nt', chatId, larkAppId, scope: 'chat', status: 'active', chatDisplayName: 'old' },
      managedTurnOrigin: { capability: CAP },
      larkAppId,
      chatId,
      chatType: 'group',
      scope: 'chat',
    } as any;
  }

  it('session-write and history routes refuse to touch Feishu for an apiOnly bot or an HTTP virtual chat', async () => {
    const renameChat = vi.spyOn(groupsStore, 'renameChat').mockResolvedValue({ ok: true, oldName: 'old', newName: 'new', changed: true } as any);
    vi.spyOn(botRegistry, 'getBot').mockImplementation((id: string) => (
      id === 'local_riff' ? apiOnlyBot() : { config: { larkAppId: id, larkAppSecret: 's' } } as any));
    const find = vi.spyOn(workerPool, 'findActiveBySessionId');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${handle.port}/api/sessions/s-nt`;

    for (const [label, chatId, appId] of [
      ['HTTP virtual chat on a normal bot', 'http_async_nt', 'app_normal'],
      ['apiOnly bot in a real-looking chat', 'oc_real_nt', 'local_riff'],
    ] as const) {
      find.mockReturnValue(activeSession(chatId, appId));
      const rename = await fetch(`${base}/chat-rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'new', proactive: true, originCapability: CAP }),
      });
      expect(await rename.json(), label).toMatchObject({ ok: false, error: 'no_feishu_transport' });
      const history = await fetch(`${base}/history`);
      expect(history.status, label).toBe(200);
      expect(await history.json(), label).toMatchObject({ ok: true, messages: [], hint: 'no_feishu_transport' });
    }
    expect(renameChat).not.toHaveBeenCalled();
  });

  it('host-facts (unauthenticated in core-only) answers only for this daemon\'s apiOnly HTTP virtual sessions', async () => {
    setIpcAuthSecret('core-only-host-facts-secret');
    setLarkAppId('local_riff');
    let apiOnly = true;
    vi.spyOn(botRegistry, 'getBot').mockImplementation(() => (apiOnly ? apiOnlyBot() : { config: { larkAppId: 'local_riff' } } as any));
    const find = vi.spyOn(workerPool, 'findActiveBySessionId');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
    const hostFacts = async (chatId: string, larkAppId = 'local_riff') => {
      find.mockReturnValue({ session: { sessionId: 's-hf', chatId, larkAppId, status: 'active' }, larkAppId, chatId } as any);
      return fetch(`http://127.0.0.1:${handle!.port}/api/sessions/s-hf/host-facts`);
    };

    const owned = await hostFacts('http_async_hf');
    expect(owned.status).toBe(200);
    expect((await owned.json()).facts).toMatchObject({ sessionId: 's-hf' });

    expect((await hostFacts('oc_real_chat')).status).toBe(404);
    expect((await hostFacts('http_async_hf', 'local_other')).status).toBe(404);
    apiOnly = false;
    expect((await hostFacts('http_async_hf')).status).toBe(404);
  });
});

describe('apiOnly trigger request shape', () => {
  it('may only resume its own HTTP virtual session, never a real-chat session', async () => {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue(apiOnlyBot());
    const request = (sessionId: string): TriggerRequest => ({
      source: { type: 'ui', requestId: 'r-resume' },
      target: { kind: 'turn', botId: 'local_riff', sessionId },
      envelope: { format: 'botmux.ui.v1', sourceName: 'riff', trusted: false, payload: {} },
      options: { asyncReturnSessionId: true, dryRun: true },
    });
    const activeSessions = new Map<string, DaemonSession>([
      ['real', { session: { sessionId: 's-real' }, chatId: 'oc_real_chat', larkAppId: 'local_riff' } as any],
      ['virtual', { session: { sessionId: 's-virtual' }, chatId: 'http_async_v', larkAppId: 'local_riff' } as any],
    ]);

    const real = await triggerSessionTurn(request('s-real'), { larkAppId: 'local_riff', activeSessions });
    expect(real).toMatchObject({ ok: false, errorCode: 'bad_request' });
    const virtual = await triggerSessionTurn(request('s-virtual'), { larkAppId: 'local_riff', activeSessions });
    expect(virtual).toMatchObject({ ok: true, action: 'dry_run' });
  });
});

describe('apiOnly paths that would otherwise fall back to a user token', () => {
  function armUserTokenFallback() {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue(apiOnlyBot());
    const tokenSpy = vi.spyOn(userToken, 'resolveUserToken').mockResolvedValue('u-token-live' as any);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    return { tokenSpy, fetchSpy };
  }

  it('downloadMessageResource refuses before the app-token attempt can fall through to a user token', async () => {
    const { tokenSpy, fetchSpy } = armUserTokenFallback();
    const dir = mkdtempSync(join(tmpdir(), 'api-only-download-'));
    try {
      await expect(downloadMessageResource('local_riff', 'om_x', 'file_x', 'file', join(dir, 'out.bin'), 'ou_sender'))
        .rejects.toBeInstanceOf(LarkTransportDisabledError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(tokenSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('doc-comment drive calls refuse an apiOnly bot even when an acting user token exists', async () => {
    const { tokenSpy, fetchSpy } = armUserTokenFallback();
    await expect(__testOnly_driveApiCall('local_riff', {
      method: 'GET', path: '/open-apis/drive/v1/files/doc_x/comments', userOpenId: 'ou_actor',
    } as any)).rejects.toBeInstanceOf(LarkTransportDisabledError);
    expect(tokenSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CLI transport gate for a managed no-transport turn', () => {
  it('is resolved from the pid-marker ancestry, so stripping every BOTMUX_* env var does not bypass it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'api-only-cli-gate-'));
    try {
      seedPersistedSessionRows(dataDir, 'cli_gate_bot', {
        s_virtual: { sessionId: 's_virtual', chatId: 'http_async_gate', larkAppId: 'cli_gate_bot', rootMessageId: '', scope: 'chat', status: 'active' },
      });
      // The worker writes this marker for its CLI's process tree; the spawned
      // CLI's parent is this test process.
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 's_virtual' }));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BOTMUX_') && v !== undefined) env[k] = v;
      env.SESSION_DATA_DIR = dataDir;
      for (const command of ['create-group', 'top-notice']) {
        const r = spawnSyncTsScript('src/cli.ts', [command], { env, encoding: 'utf8', timeout: 60_000 });
        expect(r.status, command).toBe(2);
        expect(String(r.stderr), command).toMatch(/no Feishu transport/);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('core-only entrypoint', () => {
  it('freezes a dedicated state root, strips BOTS_CONFIG and pins worker HTTP to loopback before the daemon starts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'core-only-entry-'));
    const before = { ...process.env };
    let envAtStart: NodeJS.ProcessEnv | undefined;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.resetModules();
    vi.doMock('../src/daemon.js', () => ({ startDaemon: async () => { envAtStart = { ...process.env }; } }));
    try {
      Object.assign(process.env, {
        HOME: home,
        BOTMUX_API_PORT: '45931',
        BOTS_CONFIG: '/fleet/bots.json',
        SESSION_DATA_DIR: '/fleet/data',
        BOTMUX_WORKER_HTTP_HOST: '0.0.0.0',
        BOTMUX_WORKER_HOST: '0.0.0.0',
      });
      delete process.env.BOTMUX_CORE_STATE_DIR;
      delete process.env.BOTMUX_API_ONLY_BOT;
      await import('../src/index-core-only.js');
      await vi.waitFor(() => expect(envAtStart).toBeDefined(), { timeout: 30_000 });
      expect(envAtStart!.BOTMUX_CORE_ONLY).toBe('1');
      expect(envAtStart!.BOTS_CONFIG).toBeUndefined();
      expect(envAtStart!.SESSION_DATA_DIR).toBe(join(home, '.botmux', 'core-only', 'local_riff', 'data'));
      expect(envAtStart!.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.1');
      expect(envAtStart!.BOTMUX_WORKER_HOST).toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/daemon.js');
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('source-structure guards (no injectable seam)', () => {
  // 源码结构护栏(K2)：core-only 的 IPC 鉴权与监听地址在 startDaemon 巨型闭包里组装，没有 seam。
  // 不变量：core-only 仍保持 trusted-host HMAC（只额外放行 routeIsCoreOnlyPublic 白名单），终端代理强制 loopback。
  // 白名单 / 就绪闸门的行为由 dashboard-ipc.test.ts 覆盖。来历：#668 codex P1-1（authRequired:false 曾放开全部 IPC 路由）、P1-4。
  it('core-only daemon keeps trusted-host HMAC on and binds the terminal proxy to loopback', () => {
    const ipcCall = region(daemonSource, 'await startIpcServer({', '});');
    expect(ipcCall).toMatch(/\bauthRequired:\s*true\b/);
    expect(ipcCall).toMatch(/\bcoreOnlyPublicRoutes:\s*coreOnly\b/);
    expect(daemonSource).toMatch(/const terminalProxyHost\s*=\s*coreOnly\s*\?\s*'127\.0\.0\.1'/);
    expect(region(daemonSource, 'await startTerminalProxy({', 'resolvePort')).toMatch(/\bhost:\s*terminalProxyHost\b/);
  });

  // 源码结构护栏(K3)：core-only 与 fleet 可能共用同一 HOME；下列动作都在 daemon 闭包 / writePidFile 里，没有 seam。
  // 不变量：core-only 不跑宿主级维护（全局 update + detached restart 会拆掉整个 fleet）、不跑会改写 fleet bots.json
  // 的沙箱迁移、不改写共享 HOME 的 ~/.botmux/.data-dir；就绪闸门在 bind 前布防、session 恢复后才放行，
  // ready 行（riff 解析的契约）只在放行后打印——否则 trigger 会撞上未完成的持久恢复而重发。来历：#668 codex P1 第 2/3 轮、P1-3。
  it('core-only daemon never touches fleet-wide host state and holds triggers until restore completes', () => {
    expect(daemonSource).toMatch(/if \(process\.env\.BOTMUX_CORE_ONLY !== '1'\) \{\s*await migrateSandboxConfigAtStartup\(\);/);
    const maintenance = braceBlock(daemonSource, 'if (idx === 0 && !coreOnly) {');
    for (const call of ['startMaintenance(', 'startCliRuntimeUpdateMonitor(', 'sendRestartReportIfPending(']) {
      expect(maintenance, call).toContain(call);
    }
    const breadcrumbGuard = braceBlock(braceBlock(daemonSource, 'function writePidFile('), "BOTMUX_CORE_ONLY !== '1'");
    expect(breadcrumbGuard).toContain("'.data-dir'");

    const armAt = daemonSource.indexOf('armCoreOnlyReadinessGate()');
    const bindAt = daemonSource.indexOf('await startIpcServer(');
    const restoreAt = daemonSource.indexOf('await restoreSessionsAndScheduleStartupRecovery(');
    const readyAt = daemonSource.indexOf('setCoreOnlyReady()');
    const readyLineAt = daemonSource.indexOf('[core-only] listening on ');
    expect(armAt).toBeGreaterThan(0);
    expect(bindAt).toBeGreaterThan(armAt);
    expect(restoreAt).toBeGreaterThan(bindAt);
    expect(readyAt).toBeGreaterThan(restoreAt);
    expect(readyLineAt).toBeGreaterThan(readyAt);
  });

  // 源码结构护栏(K1)：wrapper bin 目录只能有一个解析口（resolveBotmuxWrapperBinDir，行为见 botmux-wrapper.test.ts）；
  // 消费方分散在 worker / worker-pool / 三个持久后端里，绕开解析口硬编码 ~/.botmux/bin 会让 core-only 会话的
  // `botmux` 命中 fleet 的 wrapper。来历：#668 codex P1 第 4 轮。
  it('every botmux wrapper PATH consumer resolves the bin dir through the single resolver', () => {
    const sharedBinJoin = /['"]\.botmux['"]\s*,\s*['"]bin['"]/;
    for (const file of ['src/worker.ts', 'src/core/worker-pool.ts', 'src/daemon.ts']) {
      const src = stripLineComments(read(file));
      expect(src, file).toContain('resolveBotmuxWrapperBinDir(');
      expect(src, file).not.toMatch(sharedBinJoin);
    }
    for (const file of [
      'src/adapters/backend/tmux-pipe-backend.ts',
      'src/adapters/backend/zellij-backend.ts',
      'src/adapters/backend/zmx-backend.ts',
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/resolveBotmuxWrapperBinDir\(\s*opts\.env\s*\?\?\s*process\.env\s*\)/);
      expect(src, file).toContain('shellWrapperScript(');
    }
    const script = shellWrapperScript('/srv/core-only/data/bin');
    expect(script).toContain('/srv/core-only/data/bin');
    expect(script).not.toContain('.botmux/bin');
  });

  // 源码结构护栏(K2)：trusted caller 的 senderType 是消费方区分「真人」与「bot 自触发」的唯一依据（数据库账号映射、
  // 审批门、审计归属都靠它）；五个 IM 入口（三个 inline + queue + ask）经 #2039 的 trustedCallerForInboundTurn
  // 包装、dispatch launch 仍走 trustedCallerForTurn，都在 daemon 闭包里没有 seam。不变量：inline IM 入口一律经
  // senderIsBotTriState（含 cross-ref 外部 bot 信号）推导，绝不用裸 sender_type 比较把 peer bot 写成 'user'；
  // queue/ask 只能转发同帧早先算好的三态局部量；dispatch launch 把直接触发者标成 bot，且 callerUnionId 证词绝不喂给
  // evaluateBotTalk。来历：#1145、#2039。
  it('every trusted caller stamps a tri-state sender type and never vouches for a bot as a person', () => {
    const inbound = callArgs(daemonSource, 'trustedCallerForInboundTurn');
    expect(inbound).toHaveLength(5);
    // Three inline IM entries (new topic, principal-lane proposer, thread
    // reply) name parsed.senderType and the cross-ref foreign-bot leg at the
    // call site. The (?!false) lookahead rejects downgrading any single site
    // to a literal, which would vouch a peer bot as a person.
    const inlineEntries = inbound.filter(args => args.some(a => /\bparsed\.senderType\b/.test(a)));
    expect(inlineEntries).toHaveLength(3);
    for (const args of inlineEntries) {
      expect(args[3], args.join(', ')).toMatch(/^senderIsBotTriState\(\s*parsed\.senderType\s*,\s*(?!false\b)\w+/);
    }
    // The queue and ask sites forward a tri-state value computed earlier in
    // the same frame; pin the local names so a boolean literal goes red.
    const precomputedEntries = inbound.filter(args => !args.some(a => /\bparsed\.senderType\b/.test(a)));
    expect(precomputedEntries).toHaveLength(2);
    for (const args of precomputedEntries) {
      expect(args[3], args.join(', ')).toMatch(/^(?:senderIsBot|byType)$/);
    }
    for (const args of inbound) {
      expect(args[3] ?? '', args.join(', ')).not.toMatch(/isBotSenderType|senderType\s*===/);
    }
    const calls = callArgs(daemonSource, 'trustedCallerForTurn');
    for (const args of calls) {
      expect(args[3] ?? '', args.join(', ')).not.toMatch(/isBotSenderType|senderType\s*===/);
    }
    const dispatch = calls.filter(args => args.some(a => /callerUnionId/.test(a)));
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0][3]).toBe('true');
    for (const args of callArgs(daemonSource, 'evaluateBotTalk')) {
      expect(args.join(', ')).not.toMatch(/callerUnionId/);
    }
  });

  // 源码结构护栏(K2)：worker 组装 no-transport 沙箱策略上下文的代码在 worker.ts 闭包里；fs-policy.test.ts 只测纯函数，
  // 手喂权威根，删掉 worker 侧的冻结仍全绿。不变量：buildFsPolicy 拿到配置根 + 冻结的默认 ~/.botmux（.dashboard-secret
  // 所在）+ daemon 冻结的实际 bots.json 路径；策略构建失败一律中止 spawn，绝不回落到无约束运行。来历：#668 codex P1/P2。
  it('worker builds the no-transport fs policy from host-frozen authority roots and aborts the spawn when it cannot', () => {
    const ctx = braceBlock(workerSource, 'const fsPolicyCtx = {');
    expect(ctx).toMatch(/\bbotmuxHome:[^,\n]*\bdataDir\b/);
    expect(ctx).toMatch(/\bdefaultBotmuxHome:[^,\n]*\bdefaultBotmuxHome\b/);
    expect(ctx).toMatch(/\bloadedBotsConfigPath:[^\n]*\bcfg\.loadedBotsConfigPath\b/);
    const policy = braceBlock(workerSource, 'const policy = (() => {');
    expect(policy).toContain('buildFsPolicy(fsPolicyCtx)');
    const onFailure = policy.slice(policy.indexOf('catch'));
    expect(onFailure).toMatch(/\bthrow\b/);
    expect(onFailure).not.toMatch(/\breturn\b/);
  });

  // 源码结构护栏(K2)：riff 后端的 env 合并在 worker.ts 闭包里，backendConfig.env 最后合并且不做净化。不变量：合并之后
  // 重新冻结 no-transport 键（删 BOTMUX_LARK_APP_SECRET、钉 BOTMUX_API_ONLY / BOTMUX_CHAT_ID），配置无法恢复发送能力。
  // 与 owner env 合并后冻结同一模式。来历：#668 codex 复审。
  it('riff env re-freezes the no-transport keys after the backend env merge', () => {
    const start = workerSource.indexOf('const mergedEnv');
    const merge = workerSource.slice(start, workerSource.indexOf('riffBackendConfig = Object.assign(', start));
    expect(start).toBeGreaterThan(-1);
    expect(merge).toMatch(/\.\.\.riffCfg\.env/);
    expect(merge).toContain('delete mergedEnv.BOTMUX_LARK_APP_SECRET');
    expect(merge).toMatch(/mergedEnv\.BOTMUX_API_ONLY\s*=\s*'1'/);
    expect(merge).toMatch(/mergedEnv\.BOTMUX_CHAT_ID\s*=\s*cfg\.chatId/);
  });

  // 源码结构护栏(K2/K3)：持久 pane 的复用判定与有序副作用已抽成纯函数（read-isolation.test.ts 行为覆盖），但「worker
  // 真的走这两个函数、守卫覆盖残留证明、晚到 pane 按精确目标拆除」的接线在 worker.ts 闭包里。不变量：残留 marker /
  // tombstone 也进入守卫（否则重开沙箱会把未隔离的新 pane 当成已隔离复用）；policy-ON 的 PENDING 证明写失败在 spawn
  // 前抛错；拆除走 persistentTeardownKillKind（herdr 共享宿主会话按名字杀会拆掉所有 bot 的 agent）。来历：#899。
  it('persistent-pane reuse is decided and torn down through the behaviour-tested read-isolation helpers', () => {
    expect(workerSource).toContain('evaluatePersistentPaneMigration({');
    expect(workerSource).toMatch(/executePersistentPaneMigration\(\s*migration\s*,/);
    const guard = workerSource.slice(workerSource.indexOf('const persistentPaneGuardApplies'));
    const guardExpr = guard.slice(0, guard.indexOf(';'));
    expect(guardExpr).toContain('stalePaneMarkerPresent');
    expect(guardExpr).toContain('policyOffTombstonePresent');
    const pendingWrite = region(workerSource,
      'if (appliedIsolationCapabilities.length > 0 && persistentSessionName && !willReattachPersistent) {',
      '} else if (');
    expect(pendingWrite).toMatch(/catch\s*\(\w*\)\s*\{\s*throw\b/);
    const commit = braceBlock(workerSource, 'if (pendingProvenanceCommit) {');
    expect(commit).toContain('persistentTeardownKillKind(');
    expect(commit).toMatch(/if \(actuallyReattachedPersistent\)/);
  });
});
