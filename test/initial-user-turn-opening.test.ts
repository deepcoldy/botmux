/**
 * Route-level regression guard for the **empty-start opening turn**.
 *
 * `/repo homelab`（或选仓卡 / 跳过 / mid-session 切仓）会在没有任何 buffered 用户
 * 输入时以 `forkWorker(ds, '', false)` 把 CLI 空启动：进程活着，但从没见过
 * `<botmux_routing>` / `<botmux_builtin_skills>` / `<identity>` 这套开场上下文
 * （只有 `buildNewTopicCliInput` 会产出它们）。
 *
 * 修复前，下一条真实业务消息只按「worker 活没活」判定，一律走
 * `buildFollowUpCliInput` / `buildReforkCliInput`，PR #477 的 opening routing +
 * built-in skill discovery 永久丢失。这里驱动**真实**路由 handler
 * （`handleThreadReply`）钉住：
 *
 *   - live worker 与 worker-null/refork 两条路都用 new-topic 开场构造首条业务输入；
 *   - 第二条消息回落成普通 follow-up，开场块不重复；
 *   - 空启动后重启（hasHistory:true + 持久标记）仍然生效，且不会错误 `--resume`；
 *   - 并发/紧邻两条首消息只有一个 opener；
 *   - botmux 控制命令 / CLI passthrough 不消费状态；
 *   - sender / mentions / attachments / quoted 侧车不丢；
 *   - prompt / off / global / dynamic 四种 skill 注入模式按**能力**断言；
 *   - 没有该标记的普通会话行为不回归。
 *
 * Run:  pnpm vitest run test/initial-user-turn-opening.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-initial-turn-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? {
            openId,
            type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const,
            name: openId === 'ou_owner' ? '凡辞' : undefined,
            email: openId === 'ou_owner' ? 'owner@example.com' : undefined,
          }
        : undefined
    )),
    forkWorker: vi.fn(),
    sendWorkerInput: vi.fn(() => true),
    updateSession: vi.fn(),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => ({
      sessionId: `sess-fake-${++seq}`,
      chatId,
      rootMessageId,
      title,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      chatType,
    })),
    listChatBotMembers: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [] as any[], needLogin: false })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    listChatBotMembers: mocks.listChatBotMembers,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

// Only the network-facing attachment download is stubbed — every prompt builder
// (buildNewTopicCliInput / buildFollowUpCliInput / …) stays REAL so the
// assertions below observe the actual opening bytes.
vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
    sendWorkerInput: (...args: any[]) => mocks.sendWorkerInput(...args),
  };
});

// hook 注入的 preflight：默认 false（不影响现有 codex 测试），特定用例置 true。
const preflightMock = vi.fn(() => false);
vi.mock('../src/adapters/hook-installer.js', () => ({
  hasInstalledPromptHookCached: (...args: any[]) => preflightMock(...args),
}));

import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { globalConfigPath, invalidateGlobalConfigCache } from '../src/global-config.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_computeCodexAppSteerable as computeCodexAppSteerable,
} from '../src/daemon.js';

const APP = 'initial_turn_app';
const CHAT = 'oc_initial_turn_chat';
const OWNER = 'ou_owner';
const NOW = new Date().toISOString();

let home: string;

function writeGlobalConfig(obj: unknown): void {
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  writeFileSync(globalConfigPath(), JSON.stringify(obj));
  invalidateGlobalConfigCache();
}

function writeBots(entries: unknown[]): void {
  const p = join(home, 'bots.json');
  writeFileSync(p, JSON.stringify(entries));
  vi.stubEnv('BOTS_CONFIG', p);
}

function makeEventData(messageId: string, text: string, rootId?: string, extra?: {
  senderOpenId?: string;
  mentions?: any[];
  parentId?: string;
}): any {
  return {
    sender: { sender_id: { open_id: extra?.senderOpenId ?? OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      parent_id: extra?.parentId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      ...(extra?.mentions ? { mentions: extra.mentions } : {}),
    },
  };
}

function makeCtx(anchor: string, messageId: string, replyRootId?: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    replyRootId: replyRootId ?? anchor,
    larkAppId: APP,
  };
}

/**
 * A session whose CLI was empty-started by the repo flow: the durable
 * `initialUserTurnPending` marker is set, everything else looks ordinary.
 */
function seedEmptyStarted(anchor: string, opts?: {
  live?: boolean;
  hasHistory?: boolean;
  cliId?: CliId;
  pending?: boolean;
  adoptedFrom?: string;
}): DaemonSession & { worker: any } {
  const send = vi.fn();
  const ds = {
    scope: 'thread',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: opts?.live === false ? null : { killed: false, send },
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: opts?.hasHistory ?? false,
    ownerOpenId: OWNER,
    ...(opts?.adoptedFrom ? { adoptedFrom: opts.adoptedFrom } : {}),
    workingDir: '/tmp',
    session: {
      sessionId: 'sess-empty-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: anchor,
      title: 'empty started',
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
      scope: 'thread',
      workingDir: '/tmp',
      ...(opts?.cliId ? { cliId: opts.cliId } : {}),
      ...(opts?.pending === false ? {} : { initialUserTurnPending: true }),
    },
  } as unknown as DaemonSession & { worker: any };
  activeSessions.set(sessionKey(anchor, APP), ds);
  return ds;
}

/** Payload the daemon handed to the live worker (via sendWorkerInput). */
function liveInputs(): Array<{ content: string; codexAppInput?: any }> {
  return mocks.sendWorkerInput.mock.calls.map(call => (call as any[])[1]);
}

/** Payload the daemon handed to a cold fork (via forkWorker). */
function forkInputs(): Array<{ content: string; codexAppInput?: any }> {
  return mocks.forkWorker.mock.calls.map(call => (call as any[])[1]);
}

/**
 * Capability-derived expectation for one CLI + resolved built-in skill
 * injection mode. Deliberately NOT a single literal-tag assertion: Claude-family
 * (`injectsSessionContext`) gets routing/identity via its own system prompt and
 * must NOT carry those blocks inline, while `skillsDir` CLIs branch per mode.
 */
function openingExpectations(cliId: CliId, mode: 'prompt' | 'off' | 'global') {
  const adapter = createCliAdapterSync(cliId);
  const inlineRouting = !adapter.injectsSessionContext;
  const builtinBlock = inlineRouting && !!adapter.skillsDir
    ? (mode === 'prompt' ? 'catalog' : mode === 'off' ? 'pointer' : 'none')
    : 'none';
  return { inlineRouting, builtinBlock };
}

describe('empty-started session — first real business turn must use the new-topic opening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    home = mkdtempSync(join(tmpdir(), 'botmux-initial-turn-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', '');
    invalidateGlobalConfigCache();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.sendWorkerInput.mockReturnValue(true);
    mocks.listChatBotMembers.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];
    bot.botName = 'TestBot';
    bot.botOpenId = 'ou_selfbot';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  // ─── live worker ────────────────────────────────────────────────────────────

  it('live worker: first business message opens with new-topic context, second is a plain follow-up', async () => {
    const anchor = 'om_live_root';
    const ds = seedEmptyStarted(anchor);

    await handleThreadReply(
      makeEventData('om_first', '帮我看看这个 bug', anchor),
      makeCtx(anchor, 'om_first'),
    );

    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    const opening = liveInputs()[0]!.content;
    expect(opening).toContain('<botmux_routing>');
    expect(opening).toContain('<identity>');
    expect(opening).toContain(`<session_id>${ds.session.sessionId}</session_id>`);
    expect(opening).toContain('<user_message>\n帮我看看这个 bug\n</user_message>');
    // New-topic openings never carry the follow-up reminder envelope.
    expect(opening).not.toContain('<botmux_reminder>');

    // One-shot: consumed + persisted.
    expect(ds.session.initialUserTurnPending).toBeUndefined();
    expect(mocks.updateSession).toHaveBeenCalledWith(ds.session);

    await handleThreadReply(
      makeEventData('om_second', '继续', anchor),
      makeCtx(anchor, 'om_second'),
    );

    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(2);
    const followUp = liveInputs()[1]!.content;
    expect(followUp).toContain('<botmux_reminder>');
    expect(followUp).not.toContain('<botmux_routing>');
    expect(followUp).not.toContain('<botmux_builtin_skills>');
    expect(followUp).not.toContain('<identity>');
  });

  it('live worker: opening carries sender, mentions, available bots and attachments', async () => {
    const anchor = 'om_live_meta_root';
    seedEmptyStarted(anchor);
    mocks.listChatBotMembers.mockResolvedValue([
      { larkAppId: 'peer_app', name: 'peer', displayName: 'Peer Bot', openId: 'ou_peer_bot', mentionable: true },
    ]);
    mocks.downloadResources.mockResolvedValue({
      attachments: [{ type: 'image', path: '/tmp/shot.png', name: 'shot.png' }],
      needLogin: false,
    });

    const data = makeEventData('om_meta', '@_user_1 看下这个', anchor, {
      mentions: [{ key: '@_user_1', name: 'Peer', id: { open_id: 'ou_peer' } }],
    });
    await handleThreadReply(data, makeCtx(anchor, 'om_meta'));

    const opening = liveInputs()[0]!.content;
    // Opening shape (the regression) …
    expect(opening).toContain('<botmux_routing>');
    expect(opening).not.toContain('<botmux_reminder>');
    // … with every per-turn datum still threaded through.
    expect(opening).toContain('<sender type="user" open_id="ou_owner"');
    expect(opening).toContain('email="owner@example.com"');
    expect(opening).toContain('<mentions>');
    expect(opening).toContain('ou_peer');
    expect(opening).toContain('<available_bots');
    expect(opening).toContain('ou_peer_bot');
    expect(opening).toContain('/tmp/shot.png');
  });

  it('live worker: a quoted-reply hint stays in the opening user message', async () => {
    const anchor = 'om_live_quote_root';
    seedEmptyStarted(anchor);

    // parent_id != root_id ⇒ the router prepends the `botmux quoted` hint.
    const data = makeEventData('om_quoted', '按引用里的说明改', anchor, { parentId: 'om_quoted_target' });
    await handleThreadReply(data, makeCtx(anchor, 'om_quoted'));

    const opening = liveInputs()[0]!.content;
    expect(opening).toContain('<botmux_routing>');
    expect(opening).toContain('om_quoted_target');
    expect(opening).toContain('按引用里的说明改');
  });

  it('live worker: Codex App keeps its clean-input sidecar on the opening turn', async () => {
    const anchor = 'om_codex_app_root';
    registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      codexAppCleanInput: true,
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    }).resolvedAllowedUsers = [OWNER];
    seedEmptyStarted(anchor, { cliId: 'codex-app' });

    const data = makeEventData('om_codex_app_msg', '接着上一条改', anchor, { parentId: 'om_codex_quote_target' });
    await handleThreadReply(data, makeCtx(anchor, 'om_codex_app_msg'));

    const payload = liveInputs()[0]!;
    // Visible user text stays exactly the Lark bytes; the quote hint and sender
    // ride the structured sidecar instead of polluting the message.
    expect(payload.codexAppInput?.text).toBe('接着上一条改');
    expect(payload.codexAppInput?.additionalContext?.botmux_message_context?.value)
      .toContain('om_codex_quote_target');
    expect(payload.codexAppInput?.additionalContext?.botmux_sender?.value)
      .toContain('ou_owner');
  });

  it('live worker: a plain human Codex App turn is admitted as steerable (R4-B1 production wiring, not hand-injected)', async () => {
    const anchor = 'om_steer_live_root';
    registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    }).resolvedAllowedUsers = [OWNER];
    seedEmptyStarted(anchor, { cliId: 'codex-app' });

    await handleThreadReply(
      makeEventData('om_steer_live_msg', '第一条真实交互消息', anchor),
      makeCtx(anchor, 'om_steer_live_msg'),
    );

    // The daemon computes codexAppSteerable and passes it as sendWorkerInput's
    // 4th arg (opts) — this is the production path the worker init COPY depends
    // on. The test does NOT hand-inject the flag anywhere.
    const opts = mocks.sendWorkerInput.mock.calls[0]?.[3];
    expect(opts?.codexAppSteerable).toBe(true);
  });

  it('worker-null refork: a plain human Codex App opening carries the frozen steerable flag on the fork payload (R4-B1)', async () => {
    const anchor = 'om_steer_cold_root';
    registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    }).resolvedAllowedUsers = [OWNER];
    seedEmptyStarted(anchor, { live: false, hasHistory: true, cliId: 'codex-app' });

    await handleThreadReply(
      makeEventData('om_steer_cold_msg', '冷启后的第一条真实交互消息', anchor),
      makeCtx(anchor, 'om_steer_cold_msg'),
    );

    // The worker-null re-fork opening must carry the frozen steer authorization
    // on the CliTurnPayload handed to forkWorker (the gap codex flagged: the
    // production init path never set it, only the hand-injected test did).
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const openingPayload = mocks.forkWorker.mock.calls[0]?.[1] as any;
    expect(openingPayload?.codexAppSteerable).toBe(true);
  });

  // ─── worker-null / refork ───────────────────────────────────────────────────

  it('worker-null refork: opens with new-topic context and does NOT resume a never-used CLI', async () => {
    const anchor = 'om_refork_root';
    // hasHistory:true is exactly what restoreActiveSessions sets after a daemon
    // restart — the empty-start marker must still win over it.
    const ds = seedEmptyStarted(anchor, { live: false, hasHistory: true });

    await handleThreadReply(
      makeEventData('om_cold_first', '重启之后的第一条真实消息', anchor),
      makeCtx(anchor, 'om_cold_first'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const opening = forkInputs()[0]!.content;
    expect(opening).toContain('<botmux_routing>');
    expect(opening).toContain('<user_message>\n重启之后的第一条真实消息\n</user_message>');
    expect(opening).not.toContain('<botmux_reminder>');
    expect(mocks.forkWorker.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ resume: false, turnId: 'om_cold_first' }));
    expect(ds.session.initialUserTurnPending).toBeUndefined();
  });

  it('worker-null refork + auto hook: opening 轮不写 speculative sidecar（review 三审 HIGH-3）', async () => {
    // 三审发现：opening 分支曾无条件先跑 buildReforkCliInput（有写 sidecar 的副作用），
    // 结果被 buildNewTopicCliInput 覆盖丢弃，但 sidecar 已写入 opening 的 turnId，
    // opening 的 hook 会领到这份没发出去的 speculative reminder → 双注入。
    // 修复后 opening 分支直接用 buildNewTopicCliInput（不写 sidecar）。
    const anchor = 'om_hook_opening_root';
    const ds = seedEmptyStarted(anchor, { live: false, hasHistory: true, cliId: 'claude-code' });
    ds.session.backendType = 'pty';
    // 切到 claude-code + auto hook + preflight 通过
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
      envelopeInjection: 'auto' as const,
    });
    bot.resolvedAllowedUsers = [OWNER];
    bot.botName = 'TestBot';
    bot.botOpenId = 'ou_selfbot';
    preflightMock.mockReturnValue(true);

    await handleThreadReply(
      makeEventData('om_hook_first', '第一条消息', anchor),
      makeCtx(anchor, 'om_hook_first'),
    );

    // opening 用 new-topic 构造，不应有 sidecar 写入
    const sidecarDir = join(process.env.SESSION_DATA_DIR!, 'prompt-ctx', ds.session.sessionId);
    expect(existsSync(sidecarDir)).toBe(false);
    // opening 内容应包含 user_message（new-topic 开场）；claude 系列不内联 routing 块
    const opening = forkInputs()[0]!.content;
    expect(opening).toContain('<user_message>');
    expect(opening).not.toContain('<botmux_reminder>');
  });

  it('worker-null refork keeps --resume when a non-IM path already fed the CLI', async () => {
    // Scheduler / webhook trigger / doc comment can inject a turn into an
    // empty-started session without being a *user* turn, so the marker survives.
    // That CLI now has real history: the opening must not cold-spawn over it.
    const anchor = 'om_prior_input_root';
    const ds = seedEmptyStarted(anchor, { live: false, hasHistory: true });
    // Both mirrors, exactly as restoreActiveSessions / rememberLastCliInput leave them.
    ds.lastCliInput = '<user_message>\n定时任务的一轮\n</user_message>';
    ds.session.lastCliInput = ds.lastCliInput;

    await handleThreadReply(
      makeEventData('om_after_schedule', '人类的第一条消息', anchor),
      makeCtx(anchor, 'om_after_schedule'),
    );

    const opening = forkInputs()[0]!.content;
    expect(opening).toContain('<botmux_routing>');
    expect(mocks.forkWorker.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ resume: true, turnId: 'om_after_schedule' }));
  });

  it('worker-null refork without the marker keeps the ordinary resume follow-up path', async () => {
    const anchor = 'om_plain_refork_root';
    seedEmptyStarted(anchor, { live: false, hasHistory: true, pending: false });

    await handleThreadReply(
      makeEventData('om_plain_cold', '普通冷启回话', anchor),
      makeCtx(anchor, 'om_plain_cold'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const content = forkInputs()[0]!.content;
    expect(content).toContain('<botmux_reminder>');
    expect(content).not.toContain('<botmux_routing>');
    expect(mocks.forkWorker.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ resume: true, turnId: 'om_plain_cold' }));
  });

  // ─── restart durability ─────────────────────────────────────────────────────

  it('survives a daemon restart: the marker lives on the persisted Session record', async () => {
    const anchor = 'om_restart_root';
    const ds = seedEmptyStarted(anchor, { live: false, hasHistory: true });
    // Simulate restore: a brand-new DaemonSession wrapper around the SAME
    // persisted Session object that was read back from disk.
    const persisted = JSON.parse(JSON.stringify(ds.session));
    expect(persisted.initialUserTurnPending).toBe(true);
    activeSessions.clear();

    const restored = {
      ...ds,
      worker: null,
      hasHistory: true,
      session: persisted,
    } as unknown as DaemonSession;
    activeSessions.set(sessionKey(anchor, APP), restored);

    await handleThreadReply(
      makeEventData('om_after_restart', '重启后第一条', anchor),
      makeCtx(anchor, 'om_after_restart'),
    );

    expect(forkInputs()[0]!.content).toContain('<botmux_routing>');
    expect(restored.session.initialUserTurnPending).toBeUndefined();
  });

  // ─── concurrency ────────────────────────────────────────────────────────────

  it('two back-to-back first messages produce exactly one opener', async () => {
    const anchor = 'om_race_root';
    seedEmptyStarted(anchor);

    await Promise.all([
      handleThreadReply(makeEventData('om_race_a', '第一条', anchor), makeCtx(anchor, 'om_race_a')),
      handleThreadReply(makeEventData('om_race_b', '第二条', anchor), makeCtx(anchor, 'om_race_b')),
    ]);

    const openings = liveInputs().filter(p => p.content.includes('<botmux_routing>'));
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(2);
    expect(openings).toHaveLength(1);
  });

  // ─── control traffic must not consume the state ─────────────────────────────

  it('a botmux daemon command does not consume the pending opening', async () => {
    const anchor = 'om_cmd_root';
    const ds = seedEmptyStarted(anchor);

    await handleThreadReply(
      makeEventData('om_status', '/status', anchor),
      makeCtx(anchor, 'om_status'),
    );

    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ds.session.initialUserTurnPending).toBe(true);

    await handleThreadReply(
      makeEventData('om_after_cmd', '现在才是真正的任务', anchor),
      makeCtx(anchor, 'om_after_cmd'),
    );
    expect(liveInputs()[0]!.content).toContain('<botmux_routing>');
  });

  it('a raw CLI passthrough command keeps its literal contract and does not consume the state', async () => {
    const anchor = 'om_passthrough_root';
    const ds = seedEmptyStarted(anchor);

    await handleThreadReply(
      makeEventData('om_model', '/model opus', anchor),
      makeCtx(anchor, 'om_model'),
    );

    // Literal command straight to the CLI — never wrapped in botmux XML.
    expect(ds.worker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/model opus',
      turnId: 'om_model',
    });
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ds.session.initialUserTurnPending).toBe(true);
  });

  // ─── skill-injection modes, asserted by capability ──────────────────────────

  for (const mode of ['prompt', 'off', 'global'] as const) {
    for (const cliId of ['codex', 'claude-code'] as CliId[]) {
      it(`opening honours skillInjection=${mode} for ${cliId} (capability-derived)`, async () => {
        writeGlobalConfig({ skills: { builtinInjection: mode } });
        writeBots([{ larkAppId: APP, larkAppSecret: 's', cliId }]);
        const anchor = `om_mode_${mode}_${cliId}`;
        seedEmptyStarted(anchor, { cliId });

        await handleThreadReply(
          makeEventData(`${anchor}_msg`, '开工', anchor),
          makeCtx(anchor, `${anchor}_msg`),
        );

        const opening = liveInputs()[0]!.content;
        const { inlineRouting, builtinBlock } = openingExpectations(cliId, mode);

        if (inlineRouting) {
          expect(opening).toContain('<botmux_routing>');
          expect(opening).toContain('botmux send');
        } else {
          // dynamic / session-context CLI: routing + skills ride the CLI's own
          // native injection channel, so the turn must not duplicate them.
          expect(opening).not.toContain('<botmux_routing>');
          expect(opening).not.toContain('<botmux_builtin_skills>');
        }

        if (builtinBlock === 'catalog') {
          expect(opening).toContain('<botmux_builtin_skills>');
          expect(opening).toContain('botmux-send');
        } else if (builtinBlock === 'pointer') {
          expect(opening).toContain('<botmux_builtin_skills>');
          expect(opening).toContain('botmux --help');
          expect(opening).not.toContain('- botmux-send:');
        } else {
          expect(opening).not.toContain('<botmux_builtin_skills>');
        }
        // Always a real user turn, never an empty boilerplate opening — and
        // never the follow-up envelope (the single mode-independent tell that
        // this went through buildNewTopicCliInput, incl. for claude-family).
        expect(opening).toContain('<user_message>\n开工\n</user_message>');
        expect(opening).not.toContain('<botmux_reminder>');
      });
    }
  }

  // ─── adopt / bridge must never be touched ───────────────────────────────────

  it('adopt-bridge sessions never receive a botmux opening envelope', async () => {
    const anchor = 'om_adopt_root';
    const ds = seedEmptyStarted(anchor, { adoptedFrom: 'tmux:user-session' });

    await handleThreadReply(
      makeEventData('om_adopt_msg', '桥接会话的一条消息', anchor),
      makeCtx(anchor, 'om_adopt_msg'),
    );

    const content = liveInputs()[0]!.content;
    expect(content).not.toContain('<botmux_routing>');
    expect(content).not.toContain('<user_message>');
    expect(content).toContain('桥接会话的一条消息');
    // Bridge sessions must not consume (or even see) the marker.
    expect(ds.session.initialUserTurnPending).toBe(true);
  });

  // ─── failure handling ───────────────────────────────────────────────────────

  it('a rejected live send restores the pending opening for the next message', async () => {
    const anchor = 'om_reject_root';
    const ds = seedEmptyStarted(anchor);
    mocks.sendWorkerInput.mockReturnValueOnce(false);

    await handleThreadReply(
      makeEventData('om_rejected', '这条会被 worker 拒绝', anchor),
      makeCtx(anchor, 'om_rejected'),
    );

    // The opening WAS built and offered …
    expect(liveInputs()[0]!.content).toContain('<botmux_routing>');
    // … but the worker refused it, so the one-shot state goes back.
    expect(ds.session.initialUserTurnPending).toBe(true);

    await handleThreadReply(
      makeEventData('om_retry', '再试一次', anchor),
      makeCtx(anchor, 'om_retry'),
    );
    expect(liveInputs()[1]!.content).toContain('<botmux_routing>');
    expect(ds.session.initialUserTurnPending).toBeUndefined();
  });

  it('a throwing cold fork restores the pending opening', async () => {
    const anchor = 'om_fork_boom_root';
    const ds = seedEmptyStarted(anchor, { live: false, hasHistory: true });
    mocks.forkWorker.mockImplementationOnce(() => { throw new Error('fork boom'); });

    await expect(handleThreadReply(
      makeEventData('om_fork_boom', '冷启失败', anchor),
      makeCtx(anchor, 'om_fork_boom'),
    )).rejects.toThrow('fork boom');

    expect(forkInputs()[0]!.content).toContain('<botmux_routing>');
    expect(ds.session.initialUserTurnPending).toBe(true);
  });

  // ─── regression: a FAILED delivery must not poison last* / --resume ──────────
  //
  // The refork branch decides `resume` from `hadPriorCliInput`, i.e. whether the
  // session already has a real `lastCliInput`. An empty-started CLI never took a
  // real turn, so lastCliInput is unset and the opening must COLD-SPAWN
  // (resume:false). The bug: rememberLastCliInput ran BEFORE forkWorker, so a
  // throwing fork left lastCliInput populated with an input that never launched;
  // the retry then read it as prior history and wrongly resumed. The fix records
  // last* only AFTER delivery is confirmed.

  it('after a throwing cold fork, the RETRY still cold-spawns (resume:false), not resume:true', async () => {
    const anchor = 'om_fork_boom_retry_root';
    const ds = seedEmptyStarted(anchor, { live: false, hasHistory: true });
    mocks.forkWorker.mockImplementationOnce(() => { throw new Error('fork boom'); });

    await expect(handleThreadReply(
      makeEventData('om_boom_first', '冷启失败的第一条', anchor),
      makeCtx(anchor, 'om_boom_first'),
    )).rejects.toThrow('fork boom');

    // The failed attempt must NOT have recorded a phantom prior input …
    expect(ds.session.initialUserTurnPending).toBe(true);
    expect(ds.lastCliInput ?? ds.session.lastCliInput).toBeFalsy();

    // … so the retry re-opens AND cold-spawns (never --resume a never-run CLI).
    await handleThreadReply(
      makeEventData('om_boom_retry', '重试', anchor),
      makeCtx(anchor, 'om_boom_retry'),
    );
    const retryInput = forkInputs()[forkInputs().length - 1]!;
    expect(retryInput.content).toContain('<botmux_routing>');
    expect(mocks.forkWorker.mock.calls[mocks.forkWorker.mock.calls.length - 1]?.[2])
      .toEqual(expect.objectContaining({ resume: false, turnId: 'om_boom_retry' }));
    expect(ds.session.initialUserTurnPending).toBeUndefined();
  });

  it('a rejected live send that loses its worker still cold-spawns on the refork retry (resume:false)', async () => {
    // live worker rejects the opening (returns false) → marker restored. The
    // worker then dies before the next message, so the retry hits the
    // worker-null refork branch — which must still see no prior CLI input and
    // cold-spawn, not resume the empty CLI.
    const anchor = 'om_reject_then_dead_root';
    const ds = seedEmptyStarted(anchor, { hasHistory: true });
    mocks.sendWorkerInput.mockReturnValueOnce(false);

    await handleThreadReply(
      makeEventData('om_live_reject', '被拒的第一条', anchor),
      makeCtx(anchor, 'om_live_reject'),
    );
    // Offered as an opening, refused, marker returned, no phantom prior input.
    expect(liveInputs()[0]!.content).toContain('<botmux_routing>');
    expect(ds.session.initialUserTurnPending).toBe(true);
    expect(ds.lastCliInput ?? ds.session.lastCliInput).toBeFalsy();

    // Worker dies; next message re-forks cold.
    ds.worker = null;
    await handleThreadReply(
      makeEventData('om_after_death', '重试', anchor),
      makeCtx(anchor, 'om_after_death'),
    );
    const retryInput = forkInputs()[forkInputs().length - 1]!;
    expect(retryInput.content).toContain('<botmux_routing>');
    expect(mocks.forkWorker.mock.calls[mocks.forkWorker.mock.calls.length - 1]?.[2])
      .toEqual(expect.objectContaining({ resume: false, turnId: 'om_after_death' }));
    expect(ds.session.initialUserTurnPending).toBeUndefined();
  });
});

describe('computeCodexAppSteerable — fail-closed positive-human gate (R7-B1)', () => {
  const humanFacts = {
    humanSender: true,
    adopted: false,
    isForeignBot: false,
    isBotSenderType: false,
    substituteTrigger: false,
    controlRewrite: false,
    messageListener: false,
    vcMeetingReceiver: false,
    vcMeetingImTurnOrigin: false,
  };

  it('authorizes ONLY a positive human sender with no special semantics', () => {
    expect(computeCodexAppSteerable({ ...humanFacts })).toBe(true);
  });

  it('is fail-closed: NO humanSender ⇒ serial even when every exclusion is absent (the fail-open root)', () => {
    // The bug codex caught: excluding a list of known non-human sources is not
    // enough — an un-enumerated non-user source (humanSender:false) must still be
    // denied. This is the core positive-assert guarantee.
    expect(computeCodexAppSteerable({ ...humanFacts, humanSender: false })).toBe(false);
  });

  it('each special-source fact independently forces serial', () => {
    for (const key of [
      'adopted', 'isForeignBot', 'isBotSenderType', 'substituteTrigger',
      'controlRewrite', 'messageListener', 'vcMeetingReceiver', 'vcMeetingImTurnOrigin',
    ] as const) {
      expect(computeCodexAppSteerable({ ...humanFacts, [key]: true })).toBe(false);
    }
  });

  it('a known peer bot (isForeignBot true / humanSender false) stays serial even if sender_type looked user-like', () => {
    // The known-peer fallback: an anomalous sender_type from a known peer must
    // NOT be authorized. Both the humanSender=false and isForeignBot=true facts
    // (which the daemon derives via isKnownPeerBot) independently deny it.
    expect(computeCodexAppSteerable({
      ...humanFacts, humanSender: false, isForeignBot: true,
    })).toBe(false);
  });
});
