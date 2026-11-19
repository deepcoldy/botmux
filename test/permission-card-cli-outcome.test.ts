/**
 * 权限确认卡的结局回写：Claude Code 不经 hook 就结束确认时（内置安全检查超时自动拒绝、终端裁决、
 * Esc / 中断终止 hook），卡片要立刻落到真实结局，而不是挂到 botmux 自己的截止时间再显示
 * 「超时未答」。另外 botmux 自己的截止要写明「已自动拒绝」。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHook, sendCliResolvedReport, type HookCliOutcomeOptions } from '../src/cli.js';
import {
  _resetForTest,
  registerAsk,
  resolveHookAskFromCli,
  restorePersistedAsks,
  setAskPersistStore,
  setCanTalkChecker,
  setCardDispatcher,
  tryResolveAsk,
  getAskSnapshot,
} from '../src/core/ask-broker.js';
import { handleCliResolvedRequest, parseAskBody, registerAskForResponse, type CliResolvedSession } from '../src/core/ask-api.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import type { AskCardDispatcher, AskResult, CliPermissionOutcome, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import claudeCodeAdapter from '../src/core/ask-hook/claude-code.js';
import { buildAskCard } from '../src/im/lark/ask-card.js';
import { turnReplyAskSummary } from '../src/im/lark/turn-reply-ask-elements.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { t } from '../src/i18n/index.js';
import { cardVisibleText } from './helpers/card-visible-text.js';
import {
  AUTO_DENIED, PROMPT_LINE, TERMINAL_NO, TERMINAL_YES,
  permissionPayload, toolResultLine, toolUseLine,
} from './helpers/claude-permission-transcript.js';

const ENV: Record<string, string | undefined> = {
  BOTMUX_SESSION_ID: 'sess_perm_1',
  BOTMUX_CHAT_ID: 'oc_chat',
  BOTMUX_LARK_APP_ID: 'cli_app',
  BOTMUX_ROOT_MESSAGE_ID: 'om_root',
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const never = <T>() => new Promise<T>(() => {});
const until = async (ready: () => boolean) => { while (!ready()) await sleep(5); };

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-perm-outcome-'));
  transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, PROMPT_LINE + toolUseLine('toolu_1'));
  setCanTalkChecker((_app, _chat, openId) => openId === 'ou_owner');
});

afterEach(() => {
  _resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

function decisionOf(stdout: string): { behavior: string; message?: string } {
  return JSON.parse(stdout).hookSpecificOutput.decision;
}

interface Report { body: Record<string, unknown>; budgetMs: number }

function hookOptions(extra: Partial<HookCliOutcomeOptions> = {}): HookCliOutcomeOptions & { reports: Report[] } {
  const reports: Report[] = [];
  return {
    reports,
    pollMs: 10,
    reportCliResolved: async (body, budgetMs) => { reports.push({ body, budgetMs }); return true; },
    ...extra,
  };
}

function startHook(postAsk: (body: Record<string, unknown>) => Promise<AskResult>, opts: HookCliOutcomeOptions) {
  const bodies: Record<string, unknown>[] = [];
  const out = runHook(permissionPayload(transcript), ENV, async (body) => { bodies.push(body); return postAsk(body); },
    'claude-code', async () => null, undefined, () => undefined, opts);
  return { out, bodies };
}

describe('runHook — Claude Code 自行了结确认时回报结局', () => {
  it.each([
    ['内置超时先于卡片截止', AUTO_DENIED, true, 'cli_auto_denied'],
    ['终端选 Yes', TERMINAL_YES, false, 'terminal_allowed'],
    ['终端选 No', TERMINAL_NO, true, 'terminal_rejected'],
  ] as const)('%s → 立刻回报 %s，不等卡片截止', async (_name, record, isError, outcome) => {
    const opts = hookOptions();
    const { out, bodies } = startHook(() => never(), opts);
    await until(() => bodies.length > 0);
    appendFileSync(transcript, toolResultLine('toolu_1', record, isError));
    const { stdout } = await out;
    expect(decisionOf(stdout).behavior).toBe('deny');
    expect(opts.reports).toHaveLength(1);
    expect(opts.reports[0]!.body).toMatchObject({
      sessionId: 'sess_perm_1', larkAppId: 'cli_app', requestId: bodies[0]!.requestId, outcome,
    });
  });

  it('发卡前终端就已选 Yes（CLI 不杀 hook）→ 不再发卡，直接结束', async () => {
    appendFileSync(transcript, toolResultLine('toolu_1', { ...TERMINAL_YES, timestamp: new Date().toISOString() }, false));
    const opts = hookOptions();
    const { out, bodies } = startHook(() => never(), opts);
    expect(decisionOf((await out).stdout).behavior).toBe('deny');
    expect(bodies).toHaveLength(0);
    expect(opts.reports).toHaveLength(0);
  });

  it('发卡前 hook 就已被 CLI 终止 → 不再发卡', async () => {
    const terminated = new AbortController();
    terminated.abort();
    const opts = hookOptions({ terminated: terminated.signal });
    const { out, bodies } = startHook(() => never(), opts);
    expect(decisionOf((await out).stdout).behavior).toBe('deny');
    expect(bodies).toHaveLength(0);
    expect(opts.reports).toHaveLength(0);
  });

  it('hook 被 CLI 终止（Esc）且终端拒绝已落盘 → 回报 terminal_rejected，用短预算', async () => {
    const terminated = new AbortController();
    const opts = hookOptions({ terminated: terminated.signal, pollMs: 60_000 });
    const { out, bodies } = startHook(() => never(), opts);
    await until(() => bodies.length > 0);
    appendFileSync(transcript, toolResultLine('toolu_1', TERMINAL_NO));
    terminated.abort();
    const { stdout } = await out;
    expect(decisionOf(stdout).behavior).toBe('deny');
    expect(opts.reports[0]!.body.outcome).toBe('terminal_rejected');
    expect(opts.reports[0]!.budgetMs).toBeLessThan(1_300);
  });

  it('hook 被终止时终端拒绝还没刷盘、稍后才写入 → 仍回报 terminal_rejected', async () => {
    const terminated = new AbortController();
    const opts = hookOptions({ terminated: terminated.signal, pollMs: 60_000, terminatedGraceMs: 5_000 });
    const { out, bodies } = startHook(() => never(), opts);
    await until(() => bodies.length > 0);
    terminated.abort();
    await sleep(120);
    appendFileSync(transcript, toolResultLine('toolu_1', TERMINAL_NO));
    await out;
    expect(opts.reports.map(r => r.body.outcome)).toEqual(['terminal_rejected']);
  });

  it('hook 被终止但 transcript 里没有记录 → 回报 cli_stopped_waiting', async () => {
    const terminated = new AbortController();
    const opts = hookOptions({ terminated: terminated.signal });
    const { out, bodies } = startHook(() => never(), opts);
    await until(() => bodies.length > 0);
    terminated.abort();
    await out;
    expect(opts.reports.map(r => r.body.outcome)).toEqual(['cli_stopped_waiting']);
  });

  it('卡片先答 → 照旧输出裁决，不回报', async () => {
    const opts = hookOptions();
    const { out } = startHook(async () => ({ kind: 'answered', answers: [['allow']], by: 'ou_owner', comment: null, timedOut: false }), opts);
    expect(decisionOf((await out).stdout)).toEqual({ behavior: 'allow' });
    await sleep(30);
    appendFileSync(transcript, toolResultLine('toolu_1', TERMINAL_YES, false));
    await sleep(30);
    expect(opts.reports).toHaveLength(0);
  });

  it('daemon 重启导致长连接中途断开、正在重连时 CLI 自动拒绝 → 仍回报同一 requestId', async () => {
    const opts = hookOptions();
    let calls = 0;
    const { out, bodies } = startHook(async () => {
      calls++;
      throw Object.assign(new Error('daemon unreachable'), { retryable: true });
    }, opts);
    await until(() => bodies.length > 0);
    appendFileSync(transcript, toolResultLine('toolu_1', AUTO_DENIED));
    await out;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(opts.reports[0]!.body).toMatchObject({ requestId: bodies[0]!.requestId, outcome: 'cli_auto_denied' });
    const settledCalls = calls;
    await sleep(700);
    expect(calls).toBe(settledCalls);
  });

  it('不带观察选项（老调用方）→ 只等卡片，行为不变', async () => {
    let settle!: (r: AskResult) => void;
    let done = false;
    const out = runHook(permissionPayload(transcript), ENV, () => new Promise<AskResult>(r => { settle = r; }),
      'claude-code', async () => null, undefined, () => undefined).finally(() => { done = true; });
    await sleep(10);
    appendFileSync(transcript, toolResultLine('toolu_1', AUTO_DENIED));
    await sleep(50);
    expect(done).toBe(false);
    settle({ kind: 'answered', answers: [['allow']], by: 'ou_owner', comment: null, timedOut: false });
    expect(decisionOf((await out).stdout)).toEqual({ behavior: 'allow' });
  });
});

describe('权限卡提示：Claude Code 的自动拒绝倒计时', () => {
  const lines = (payload: Record<string, unknown>, env?: Record<string, string | undefined>) =>
    claudeCodeAdapter.parsePermissionRequest!(payload, env)!.questions[0]!.prompt.split('\n');
  const bash = (over: Record<string, unknown> = {}) => ({ ...permissionPayload(transcript), ...over });

  it.each([
    ['bypassPermissions', undefined],
    ['auto', undefined],
    ['bypassPermissions', '0'],
  ])('Bash + %s 模式（变量=%s）→ 多一行提醒，写明自动拒绝的时刻', (mode, value) => {
    const payload = bash({ permission_mode: mode });
    const quiet = lines(payload);
    const warned = lines(payload, { ...ENV, CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: value });
    const extra = warned.filter(line => !quiet.includes(line));
    expect(warned).toHaveLength(quiet.length + 1);
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it.each([
    ['default 模式没有倒计时', bash({ permission_mode: 'default' }), ENV],
    ['acceptEdits 模式没有倒计时', bash({ permission_mode: 'acceptEdits' }), ENV],
    ['非 Bash 工具不走危险删除检查', bash({ tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'y' } }), ENV],
    ['用户自己关掉了危险删除检查', bash(), { ...ENV, CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: 'true' }],
  ])('%s → 不加提醒', (_name, payload, env) => {
    expect(lines(payload, env)).toEqual(lines(payload));
  });
});

const PERMISSION_QUESTIONS = () => claudeCodeAdapter.parsePermissionRequest!(permissionPayload('/dev/null'))!.questions;

function permissionInput(over: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    larkAppId: 'cli_app', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'sess_perm_1',
    requestId: 'req-1', originKind: 'hook', backendSurvivesRestart: true,
    questions: PERMISSION_QUESTIONS(), timeoutMs: 600_000, ...over,
  };
}

function recordingDispatcher(): AskCardDispatcher & { sent: PendingAsk[]; settled: Array<{ ask: PendingAsk; result: AskResult }> } {
  const sent: PendingAsk[] = [];
  const settled: Array<{ ask: PendingAsk; result: AskResult }> = [];
  return {
    async send(ask) { sent.push(ask); return { messageId: `om_card_${ask.askId}` }; },
    onSettle(ask, result) { settled.push({ ask, result }); },
    sent,
    settled,
  };
}

const resolveArgs = (outcome: CliPermissionOutcome, requestId = 'req-1') =>
  ({ larkAppId: 'cli_app', sessionId: 'sess_perm_1', requestId, outcome });

const persisted = () => existsSync(join(dir, 'asks')) ? readdirSync(join(dir, 'asks')).filter(f => f.endsWith('.json')) : [];

describe('resolveHookAskFromCli', () => {
  beforeEach(() => setAskPersistStore(createAskPersistStore(join(dir, 'asks'))));

  it('在等的权限卡 → 立刻结算成 CLI 结局，hook 的等待也拿到同一结果', async () => {
    const d = recordingDispatcher();
    setCardDispatcher(d);
    const waiting = registerAsk(permissionInput());
    await sleep(5);
    expect(resolveHookAskFromCli(resolveArgs('cli_auto_denied'))).toBe('settled');
    expect(await waiting).toMatchObject({ kind: 'invalidated', failureCode: 'cli_resolved', cliOutcome: 'cli_auto_denied' });
    expect(d.settled.map(s => s.result)).toEqual([expect.objectContaining({ cliOutcome: 'cli_auto_denied' })]);
    expect(persisted()).toHaveLength(0);
  });

  it('hook 连接中途断开（ask 休眠等重连）→ 报告到达即结算，不等 60 秒回收', async () => {
    const d = recordingDispatcher();
    setCardDispatcher(d);
    const controller = new AbortController();
    const first = registerAsk(permissionInput(), controller.signal);
    await sleep(5);
    controller.abort();
    await first;
    expect(d.settled).toHaveLength(0);
    expect(resolveHookAskFromCli(resolveArgs('terminal_rejected'))).toBe('settled');
    expect(d.settled.map(s => s.result)).toEqual([expect.objectContaining({ cliOutcome: 'terminal_rejected' })]);
    expect(persisted()).toHaveLength(0);
  });

  it('daemon 重启后休眠期间有人点了卡片、答案还没送达 → 让位给 CLI 结局', async () => {
    const first = recordingDispatcher();
    setCardDispatcher(first);
    void registerAsk(permissionInput());
    await sleep(5);
    const original = first.sent[0]!;
    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dir, 'asks')));
    setCanTalkChecker((_app, _chat, openId) => openId === 'ou_owner');
    const d = recordingDispatcher();
    setCardDispatcher(d);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    expect(tryResolveAsk({ askId: original.askId, nonce: original.nonce, selected: 'allow', by: 'ou_owner' })).toBe('accepted');
    expect(resolveHookAskFromCli(resolveArgs('cli_auto_denied'))).toBe('settled');
    expect(d.settled.map(s => s.result.kind)).toEqual(['answered', 'invalidated']);
    expect(d.settled[1]!.result).toMatchObject({ cliOutcome: 'cli_auto_denied' });
    expect(getAskSnapshot(original.askId)).toBeUndefined();
    expect(persisted()).toHaveLength(0);
  });

  it('已被卡片答复并送达 → already_settled，不改结果', async () => {
    const d = recordingDispatcher();
    setCardDispatcher(d);
    const waiting = registerAsk(permissionInput());
    await sleep(5);
    tryResolveAsk({ askId: d.sent[0]!.askId, nonce: d.sent[0]!.nonce, selected: 'allow', by: 'ou_owner' });
    await waiting;
    expect(resolveHookAskFromCli(resolveArgs('cli_auto_denied'))).toBe('already_settled');
    expect(d.settled.map(s => s.result.kind)).toEqual(['answered']);
  });

  it('AskUserQuestion 提问卡和显式 botmux ask 不受影响', async () => {
    const d = recordingDispatcher();
    setCardDispatcher(d);
    void registerAsk(permissionInput({ requestId: 'req-q', questions: [{ prompt: '选哪个？', multiSelect: false,
      options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }] }));
    const allowDenyQuestion = claudeCodeAdapter.parseQuestions({
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '要不要继续？', options: [{ label: 'allow' }, { label: 'deny' }] }] },
    })!.questions;
    void registerAsk(permissionInput({ requestId: 'req-q2', questions: allowDenyQuestion }));
    void registerAsk(permissionInput({ requestId: 'req-x', originKind: 'explicit', backendSurvivesRestart: undefined }));
    void registerAsk(permissionInput({ requestId: 'req-1' }));
    await sleep(5);
    expect(resolveHookAskFromCli(resolveArgs('cli_auto_denied', 'req-q'))).toBe('not_found');
    expect(resolveHookAskFromCli(resolveArgs('cli_auto_denied', 'req-q2'))).toBe('not_found');
    expect(resolveHookAskFromCli(resolveArgs('cli_auto_denied', 'req-x'))).toBe('not_found');
    expect(resolveHookAskFromCli({ ...resolveArgs('cli_auto_denied'), sessionId: 'other-session' })).toBe('not_found');
    expect(resolveHookAskFromCli({ ...resolveArgs('cli_auto_denied'), larkAppId: 'cli_other' })).toBe('not_found');
    expect(d.settled).toHaveLength(0);
  });
});

describe('POST /api/asks/cli-resolved 路由', () => {
  const OWN: CliResolvedSession = {
    larkAppId: 'cli_app', sessionId: 'sess_perm_1', receiverSession: false,
    liveOrigin: { capability: 'cap-own', turnId: 'turn-1', dispatchAttempt: 1 },
  };
  const OTHER: CliResolvedSession = {
    larkAppId: 'cli_app', sessionId: 'sess_other', receiverSession: false,
    liveOrigin: { capability: 'cap-other', turnId: 'turn-9', dispatchAttempt: 1 },
  };
  const sessions = new Map([[OWN.sessionId, OWN], [OTHER.sessionId, OTHER]]);
  const report = (over: Record<string, unknown> = {}) =>
    ({ sessionId: 'sess_perm_1', requestId: 'req-1', outcome: 'cli_auto_denied', originCapability: 'cap-own', ...over });
  const handle = (raw: unknown, ctx: Partial<Parameters<typeof handleCliResolvedRequest>[1]> = {}) =>
    handleCliResolvedRequest(raw, { trustedHost: false, sessionsRestored: true, findSession: id => sessions.get(id), ...ctx });

  let d: ReturnType<typeof recordingDispatcher>;
  beforeEach(async () => {
    d = recordingDispatcher();
    setCardDispatcher(d);
    void registerAsk(permissionInput());
    void registerAsk(permissionInput({ sessionId: 'sess_other', requestId: 'req-other' }));
    await until(() => d.sent.length === 2);
  });

  it('带本会话的 live capability → 结算本会话的卡；请求里自报的 larkAppId 不参与定位', () => {
    expect(handle(report({ larkAppId: 'cli_forged' }))).toEqual({ status: 200, body: { ok: true, outcome: 'settled' } });
    expect(d.settled.map(x => x.ask.sessionId)).toEqual(['sess_perm_1']);
    expect(handle(report())).toEqual({ status: 200, body: { ok: true, outcome: 'already_settled' } });
  });

  it.each([
    ['没带 capability', report({ originCapability: undefined }), 'origin_unproven'],
    ['拿别的会话的 capability', report({ originCapability: 'cap-other' }), 'origin_unproven'],
    ['用自己的 capability 冒充别的会话', report({ sessionId: 'sess_other', requestId: 'req-other' }), 'origin_unproven'],
  ])('%s → 403，卡不动', (_name, raw, error) => {
    expect(handle(raw)).toEqual({ status: 403, body: { ok: false, error } });
    expect(d.settled).toHaveLength(0);
  });

  it('会议接收会话不接受 capability 上报', () => {
    const receiver = { ...OWN, receiverSession: true };
    expect(handle(report(), { findSession: () => receiver })).toEqual({ status: 403, body: { ok: false, error: 'managed_action_required' } });
    expect(d.settled).toHaveLength(0);
  });

  it('已鉴权为本会话，却报别的会话的 requestId → 409，那张卡不动', () => {
    expect(handle(report({ requestId: 'req-other' }))).toEqual({ status: 409, body: { ok: false, error: 'ask_not_found' } });
    expect(handle(report({ requestId: 'req-other' }), { trustedHost: true })).toMatchObject({ status: 409 });
    expect(d.settled).toHaveLength(0);
  });

  it('未知会话：启动窗口内 503；之后未鉴权的请求只得 403（不暴露会话是否存在），宿主请求得 404', () => {
    const unknown = report({ sessionId: 'sess_gone' });
    expect(handle(unknown, { sessionsRestored: false })).toEqual({ status: 503, body: { ok: false, error: 'startup_not_ready' } });
    expect(handle(unknown)).toEqual({ status: 403, body: { ok: false, error: 'origin_unproven' } });
    expect(handle(unknown, { trustedHost: true })).toEqual({ status: 404, body: { ok: false, error: 'session_not_found' } });
  });

  it('宿主 HMAC 请求不需要 capability；已知会话在启动窗口内也能处理', () => {
    expect(handle(report({ originCapability: undefined }), { trustedHost: true, sessionsRestored: false }))
      .toEqual({ status: 200, body: { ok: true, outcome: 'settled' } });
  });

  it.each([
    ['缺 requestId', report({ requestId: undefined })],
    ['未知的结局', report({ outcome: 'answered' })],
    ['不是对象', 'nope'],
  ])('%s → 400', (_name, raw) => {
    expect(handle(raw)).toEqual({ status: 400, body: { ok: false, error: 'bad_body' } });
  });
});

describe('结局回报的重试', () => {
  const response = (status: number) => new Response(status === 200 ? '{"ok":true}' : '{}', { status });
  const sender = (statuses: Array<number | null>) => {
    const calls: number[] = [];
    return {
      calls,
      send: async () => {
        const status = statuses[Math.min(calls.length, statuses.length - 1)]!;
        calls.push(Date.now());
        return status === null ? null : response(status);
      },
    };
  };

  it('daemon 还不认识这张卡（409，卡片的 POST 还在登记）→ 短间隔重试直到结算', async () => {
    const s = sender([409, 409, 200]);
    expect(await sendCliResolvedReport(s.send, 30_000)).toBe(true);
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2]! - s.calls[0]!).toBeLessThan(1_000);
  });

  it('一直 409 → 只在短窗口内重试，不耗尽整个预算', async () => {
    const s = sender([409]);
    const started = Date.now();
    expect(await sendCliResolvedReport(s.send, 30_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(s.calls.length).toBeGreaterThan(2);
  });

  it('daemon 启动中（503）/ 暂时找不到 daemon → 预算内继续重试', async () => {
    const s = sender([null, 503, 200]);
    expect(await sendCliResolvedReport(s.send, 30_000)).toBe(true);
    expect(s.calls).toHaveLength(3);
  });

  it.each([404, 403, 400])('确定性失败 %i（如老 daemon 没有这条路由）→ 立即放弃', async (status) => {
    const s = sender([status]);
    expect(await sendCliResolvedReport(s.send, 30_000)).toBe(false);
    expect(s.calls).toHaveLength(1);
  });
});

describe('权限卡结局文案', () => {
  const ask = (): PendingAsk => ({
    askId: 'ask-1', nonce: 'n-1', larkAppId: 'cli_app', chatId: 'oc_chat', rootMessageId: 'om_root',
    sessionId: 'sess_perm_1', originKind: 'hook', questions: PERMISSION_QUESTIONS(),
    createdAt: 1_000, deadlineAt: 601_000, settled: true,
  });
  const timedOut: AskResult = { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true };
  const cliResolved = (cliOutcome: CliPermissionOutcome): AskResult => ({
    kind: 'invalidated', reason: 'x', failureCode: 'cli_resolved', cliOutcome, selected: null, by: null, comment: null, timedOut: false,
  });

  it('botmux 自己的截止 → 写明已自动拒绝；普通提问卡照旧「超时未答」', () => {
    expect(cardVisibleText(buildAskCard(ask(), timedOut))).toContain(t('card.ask.permission_timed_out'));
    const plain = { ...ask(), questions: [{ prompt: '选哪个？', multiSelect: false, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }] };
    const text = cardVisibleText(buildAskCard(plain, timedOut));
    expect(text).toContain(t('card.ask.timed_out'));
    expect(text).not.toContain(t('card.ask.permission_timed_out'));
  });

  it.each(['cli_auto_denied', 'terminal_allowed', 'terminal_rejected', 'cli_stopped_waiting'] as const)(
    'CLI 结局 %s → 独立卡与回复卡都显示对应结局，按钮收起', (outcome) => {
      const card = buildAskCard(ask(), cliResolved(outcome));
      expect(cardVisibleText(card)).toContain(t(`card.ask.cli_outcome.${outcome}`));
      expect(card).not.toContain('"tag":"button"');
      expect(turnReplyAskSummary({ ask: ask(), result: cliResolved(outcome) } as never))
        .toContain(t(`card.ask.cli_outcome.${outcome}`));
    });
});

describe('端到端：真实 runHook → IPC → broker → 卡片结算', () => {
  let server: Server;
  let port: number;
  let closed = false;
  let registerDelayMs = 0;

  beforeEach(async () => {
    closed = false;
    registerDelayMs = 0;
    setAskPersistStore(createAskPersistStore(join(dir, 'asks')));
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/api/asks') {
        const parsed = parseAskBody(raw);
        if ('error' in parsed) { res.writeHead(400).end(JSON.stringify(parsed)); return; }
        if (registerDelayMs) await sleep(registerDelayMs);
        const result = await registerAskForResponse({ ...parsed, backendSurvivesRestart: true } as CreateAskInput, res);
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } else if (req.url === '/api/asks/cli-resolved') {
        const { status, body } = handleCliResolvedRequest(raw, {
          trustedHost: true,
          sessionsRestored: true,
          findSession: id => id === 'sess_perm_1' ? { larkAppId: 'cli_app', sessionId: id, receiverSession: false } : undefined,
        });
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    closed = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const post = async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => loopbackFetch(
    `http://127.0.0.1:${port}${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) },
  );

  function realHook(postAsk?: (body: Record<string, unknown>) => Promise<AskResult>) {
    return runHook(permissionPayload(transcript), ENV, postAsk ?? (async (body) => {
      if (closed) return never();
      return (await (await post('/api/asks', body)).json()) as AskResult;
    }), 'claude-code', async () => null, undefined, () => undefined, {
      pollMs: 10,
      reportCliResolved: (body, budgetMs) => sendCliResolvedReport(
        async signal => closed ? null : post('/api/asks/cli-resolved', body, signal), budgetMs),
    });
  }

  it('内置超时先于卡片截止：卡片立刻变成「已超时 · Claude Code 自动拒绝」', async () => {
    const d = recordingDispatcher();
    setCardDispatcher(d);
    const hook = realHook();
    await until(() => d.sent.length > 0);
    expect(d.settled).toHaveLength(0);
    appendFileSync(transcript, toolResultLine('toolu_1', AUTO_DENIED));
    expect(decisionOf((await hook).stdout).behavior).toBe('deny');
    await sleep(20);
    expect(d.settled).toHaveLength(1);
    const { ask, result } = d.settled[0]!;
    expect(cardVisibleText(buildAskCard(ask, result))).toContain(t('card.ask.cli_outcome.cli_auto_denied'));
  });

  it('长连接中途断开、hook 还没重连上时终端已裁决：卡片仍落到终端结局', async () => {
    const d = recordingDispatcher();
    setCardDispatcher(d);
    let attempt = 0;
    let dropped = false;
    const hook = realHook(async (body) => {
      attempt++;
      if (closed) return never();
      if (attempt === 1) {
        const drop = new AbortController();
        void until(() => d.sent.length > 0).then(() => drop.abort());
        try {
          return (await (await post('/api/asks', body, drop.signal)).json()) as AskResult;
        } catch {
          dropped = true;
          throw Object.assign(new Error('connection reset'), { retryable: true });
        }
      }
      await sleep(5_000);
      return never();
    });
    await until(() => dropped);
    expect(persisted()).toHaveLength(1);
    expect(d.settled).toHaveLength(0);
    appendFileSync(transcript, toolResultLine('toolu_1', TERMINAL_YES, false));
    await hook;
    await sleep(20);
    expect(d.settled.map(s => s.result)).toEqual([expect.objectContaining({ cliOutcome: 'terminal_allowed' })]);
  });

  it('卡片的 POST 还在登记时 CLI 已自动拒绝：回报等到登记完成，卡片仍落到真实结局', async () => {
    const d = recordingDispatcher();
    setCardDispatcher(d);
    registerDelayMs = 400;
    let posted = false;
    const hook = realHook(async (body) => {
      posted = true;
      return (await (await post('/api/asks', body)).json()) as AskResult;
    });
    await until(() => posted);
    appendFileSync(transcript, toolResultLine('toolu_1', AUTO_DENIED));
    expect(decisionOf((await hook).stdout).behavior).toBe('deny');
    expect(d.sent).toHaveLength(1);
    await until(() => d.settled.length > 0);
    expect(d.settled.map(s => s.result)).toEqual([expect.objectContaining({ cliOutcome: 'cli_auto_denied' })]);
  });
});
