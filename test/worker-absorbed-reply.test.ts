/**
 * Worker-level replies to Lark messages Claude Code folded into the running
 * turn (adopt): the real live observer (`observeBridgeAttribution` →
 * `observeAbsorbedReplies`) and `emitReadyTurns`, via the worker function
 * harness, over the real BridgeTurnQueue and transcript reader, fed a
 * transcript file the test appends to as Claude would. Plus the Codex
 * same-turn steer observer (`observeCodexSteerReply`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as queueModule from '../src/services/bridge-turn-queue.js';
import * as gateModule from '../src/services/bridge-fallback-gate.js';
import * as transcriptModule from '../src/services/claude-transcript.js';
import * as localFailureModule from '../src/services/local-turn-failure.js';
import { CodexSteerReplyCollector, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';
import * as restoredLabelModule from '../src/services/restored-turn-label.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';
import { t } from '../src/i18n/index.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const PROMPT_A = '<user_message>把整套用例跑一遍</user_message>';
const PROMPT_B = '<user_message>现在用的是什么模型？</user_message>';
const PROMPT_C = '<user_message>CI 绿了吗？</user_message>';
const dir = mkdtempSync(join(tmpdir(), 'bmx-absorbed-reply-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let clock = Date.now() + 1_000;
const at = () => new Date(clock += 10).toISOString();
const user = (uuid: string, content: string): TranscriptEvent =>
  ({ type: 'user', uuid, timestamp: at(), message: { role: 'user', content } }) as TranscriptEvent;
const assistant = (uuid: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}): TranscriptEvent =>
  ({ type: 'assistant', uuid, timestamp: at(), message: { role: 'assistant', content: [block], ...extra } }) as TranscriptEvent;
const text = (uuid: string, value: string, stop?: string) =>
  assistant(uuid, { type: 'text', text: value }, stop ? { stop_reason: stop } : {});
const thinking = (uuid: string, value: string) => assistant(uuid, { type: 'thinking', thinking: value, signature: 'sig' });
const tool = (uuid: string) => assistant(uuid, { type: 'tool_use', id: `tu-${uuid}`, name: 'Bash', input: {} });
const result = (uuid: string): TranscriptEvent =>
  ({ type: 'user', uuid, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }) as TranscriptEvent;
const fold = (uuid: string, prompt: string): TranscriptEvent => ({
  type: 'attachment', uuid, timestamp: at(), renderedRole: 'system',
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt' },
  rendered: [{ content: `<system-reminder>\nThe user sent a new message while you were working:\n${prompt}\n</system-reminder>` }],
}) as TranscriptEvent;
const apiError = (uuid: string): TranscriptEvent => ({
  ...text(uuid, 'API Error: 500 {"type":"error","error":{"type":"api_error"}}', 'stop_sequence'), isApiErrorMessage: true,
}) as TranscriptEvent;
const duration = (uuid: string): TranscriptEvent =>
  ({ type: 'system', subtype: 'turn_duration', uuid, timestamp: at() }) as TranscriptEvent;

function harness(opts: { adoptMode?: boolean; folds?: string[]; followUpReply?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const terminals: Array<{ turnId: string; status: string; disposition?: string }> = [];
  const reads: number[] = [];
  const queue = new queueModule.BridgeTurnQueue();
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, '');
  const scope: Record<string, unknown> = {
    ...transcriptModule, ...gateModule, ...queueModule, ...localFailureModule, ...restoredLabelModule, t,
    bridgeQueue: queue,
    bridgeFingerprintScanLastMs: new Map(),
    journalBridgeTurnClear: () => {},
    rememberTurnLinkRefMode: () => {},
    readSendMarkers: () => [],
    lastInitConfig: {
      cliId: 'claude-code', chatId: 'oc_chat', rootMessageId: 'om_root', adoptMode: opts.adoptMode ?? true,
      ...(opts.followUpReply ?? true ? { followUpReply: true } : {}),
    },
    log: () => {},
    cliName: () => 'Claude',
    zeroPromptTerminalSync: () => false,
    WORKER_STARTED_AT_MS: Date.now() - 1_000,
    send: (msg: Record<string, unknown>) => { sent.push(msg); },
    emitTurnTerminal: (turnId: string, status: string, _code?: string, _attempt?: number, disposition?: string) => {
      terminals.push({ turnId, status, ...(disposition ? { disposition } : {}) });
    },
    drainTranscript: (file: string, offset: number) => { reads.push(offset); return transcriptModule.drainTranscript(file, offset); },
    foldReadOffsets: new Map(),
    FOLD_READ_OFFSETS_MAX: 32,
    replyDeliveryMode: () => 'transcript',
    sessionId: 'session-under-test',
    bridgeJsonlPath: path,
    workerFinalOutputHandoff: undefined,
    universalOutputHandoff: false,
    finalHandoffAdmissionEnabled: false,
    usageLimitTracker: { noteTurnCompleted: () => {} },
    notifyExplicitRepliesObserved: () => {},
    observeThinkingAttribution: () => {},
    absorbedReplyCollectors: new WeakMap(),
  };
  scope.attributableExplicitReplyMarkersForTurnWindow = loadWorkerFunction('attributableExplicitReplyMarkersForTurnWindow', scope);
  scope.followUpReplyEnabled = loadWorkerFunction('followUpReplyEnabled', scope);
  scope.sendAbsorbedReply = loadWorkerFunction('sendAbsorbedReply', scope);
  scope.readFoldReply = loadWorkerFunction('readFoldReply', scope);
  const noteFoldReadOffsets = loadWorkerFunction<(events: TranscriptEvent[], file: string, offset: number) => void>('noteFoldReadOffsets', scope);
  scope.observeAbsorbedReplies = loadWorkerFunction('observeAbsorbedReplies', scope);
  const observe = loadWorkerFunction<(ev: TranscriptEvent, turn: queueModule.BridgePendingTurn) => void>('observeBridgeAttribution', scope);
  const emitReadyTurns = loadWorkerFunction<(opts?: { explicitTerminalOnly?: boolean }) => void>('emitReadyTurns', scope);
  /** The polling read pops turns at a screen-idle edge too, without waiting for terminal records. */
  const emitAtIdle = () => emitReadyTurns({});
  queue.mark('om_A', queueModule.makeFingerprint(PROMPT_A), clock - 500, queueModule.normaliseForFingerprint(PROMPT_A));
  for (const [i, prompt] of (opts.folds ?? [PROMPT_B]).entries()) {
    queue.mark(`om_${String.fromCharCode(66 + i)}`, queueModule.makeFingerprint(prompt), clock - 400 + i, queueModule.normaliseForFingerprint(prompt));
  }
  /** Claude writes these records; the worker's polling read ingests them. */
  const live = (events: TranscriptEvent[]) => {
    const batchOffset = statSync(path).size;
    appendFileSync(path, events.map(ev => `${JSON.stringify(ev)}\n`).join(''));
    noteFoldReadOffsets(events, path, batchOffset);
    queue.ingest(events, path, observe);
  };
  /** Records the live read ingested without the observer (another read path). */
  const unobserved = (events: TranscriptEvent[]) => {
    appendFileSync(path, events.map(ev => `${JSON.stringify(ev)}\n`).join(''));
    queue.ingest(events, path);
  };
  const emit = () => emitReadyTurns({ explicitTerminalOnly: true });
  const replies = () => sent.filter(msg => msg.type === 'absorbed_reply')
    .map(msg => [msg.turnId, msg.answer, msg.source] as const);
  const finals = () => sent.filter(msg => msg.type === 'final_output').map(msg => [msg.turnId, msg.content] as const);
  return { live, unobserved, emit, emitAtIdle, replies, finals, sent, terminals, reads, path };
}

describe('worker: replies to folded Lark messages (adopt)', () => {
  it('answers a folded message live, once, and never again when the host turn ends', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', '用的是 gpt-6-astra。')]);
    expect(h.replies()).toEqual([]);
    h.live([tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '用的是 gpt-6-astra。', 'text']]);
    h.live([result('r1'), text('a-final', 'all green', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toHaveLength(1);
    expect(h.finals().map(([turnId]) => turnId)).toEqual(['om_A']);
    const reply = h.sent.find(msg => msg.type === 'absorbed_reply')!;
    expect(reply).toMatchObject({ replyUuid: 'aB', turnReply: true });
    expect(h.terminals).toEqual([{ turnId: 'om_A', status: 'completed' }, { turnId: 'om_B', status: 'completed' }]);
  });

  it('reads a live reply from where its fold was read, not the whole transcript', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0')]);
    const foldBatch = statSync(h.path).size;
    h.live([fold('qB', PROMPT_B), text('aB', '用的是 gpt-6-astra。')]);
    h.live([tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '用的是 gpt-6-astra。', 'text']]);
    expect(foldBatch).toBeGreaterThan(0);
    expect(h.reads).toEqual([foldBatch]);
  });

  it('answers with a thinking summary, marked as such', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), thinking('aB', '对，用的是 gpt-6-astra。'), tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '对，用的是 gpt-6-astra。', 'thinking']]);
  });

  it('answers at the end of the host turn when the model never moved on before it ended', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('a-final', 'answer and summary', 'end_turn'), duration('dur')]);
    expect(h.replies()).toEqual([]);
    h.emit();
    expect(h.replies()).toEqual([['om_B', 'answer and summary', 'text']]);
    expect(h.finals().map(([turnId]) => turnId)).toEqual(['om_A']);
  });

  it('reads the reply from the transcript even when another read path ingested the fold', () => {
    const h = harness();
    h.unobserved([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', '用的是 gpt-6-astra。')]);
    h.live([tool('t1'), result('r1'), text('a2', 'Now running the integration suite.'), tool('t2')]);
    expect(h.replies()).toEqual([['om_B', '用的是 gpt-6-astra。', 'text']]);
    expect(h.reads).toEqual([0]);
  });

  it('does not mark a folded turn it answered as ending without output when the host is cut at an idle edge', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer')]);
    h.emitAtIdle();
    expect(h.replies()).toEqual([['om_B', 'answer', 'text']]);
    expect(h.terminals.find(term => term.turnId === 'om_B')).toEqual({ turnId: 'om_B', status: 'completed' });
  });

  it('gives a later folded message its own answer and the earlier silent one none', () => {
    const h = harness({ folds: [PROMPT_B, PROMPT_C] });
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), thinking('aB', ''), tool('t1'), result('r1')]);
    h.live([fold('qC', PROMPT_C), text('aC', 'CI 全绿。'), tool('t2'), result('r2')]);
    h.live([text('a-final', 'done', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([['om_C', 'CI 全绿。', 'text']]);
  });

  it('does not fail a folded turn it answered when the host turn then fails', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer'), tool('t1'), result('r1')]);
    h.live([apiError('err'), duration('dur')]);
    h.emit();
    const status = (turnId: string) => h.terminals.find(term => term.turnId === turnId)?.status;
    expect(status('om_A')).not.toBe('completed');
    expect(status('om_B')).toBe('completed');
  });

  it('handles a folded message exactly as before while followUpReply is off', () => {
    const answered = harness({ followUpReply: false });
    answered.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer'), tool('t1'), result('r1')]);
    answered.live([text('a-final', 'done', 'end_turn'), duration('dur')]);
    answered.emit();
    expect(answered.replies()).toEqual([]);
    expect(answered.finals().map(([turnId]) => turnId)).toEqual(['om_A']);
    // An answered fold no longer settles apart from its host: it takes the host's failure.
    const failing = harness({ followUpReply: false });
    failing.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer'), tool('t1'), result('r1')]);
    failing.live([apiError('err'), duration('dur')]);
    failing.emit();
    const status = (turnId: string) => failing.terminals.find(term => term.turnId === turnId)?.status;
    expect(status('om_B')).toBe(status('om_A'));
    expect(status('om_A')).not.toBe('completed');
  });

  it('leaves a session that is not adopted alone', () => {
    const h = harness({ adoptMode: false });
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer'), tool('t1'), result('r1')]);
    h.live([text('a-final', 'done', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([]);
  });
});

describe('worker: replies to Codex same-turn steers', () => {
  const steered = (overrides: Partial<CodexPendingTurn> = {}): CodexPendingTurn =>
    ({ turnId: 'om_followup', started: true, steeredMidTurn: true, ...overrides }) as CodexPendingTurn;
  const message = (uuid: string, value: string): CodexBridgeEvent =>
    ({ uuid, timestampMs: 0, kind: 'cot', text: '', cotEntries: [], assistantMessage: value });
  const toolCall = (uuid: string): CodexBridgeEvent =>
    ({ uuid, timestampMs: 0, kind: 'cot', text: '', cotEntries: [{ kind: 'tool_call', id: uuid, name: 'js', args: '' }] });

  function observer(initConfig: Record<string, unknown>, replyDelivery: 'send' | 'transcript' = 'transcript') {
    const sent: Array<Record<string, unknown>> = [];
    const scope: Record<string, unknown> = {
      lastInitConfig: { cliId: 'codex', followUpReply: true, ...initConfig },
      replyDeliveryMode: () => replyDelivery,
      send: (msg: Record<string, unknown>) => { sent.push(msg); },
      log: () => {},
      CodexSteerReplyCollector,
      codexSteerReplyCollectors: new WeakMap(),
    };
    scope.followUpReplyEnabled = loadWorkerFunction('followUpReplyEnabled', scope);
    scope.structuredBridgeIs = loadWorkerFunction('structuredBridgeIs', scope);
    const observe = loadWorkerFunction<(ev: CodexBridgeEvent, turn: CodexPendingTurn) => void>('observeCodexSteerReply', scope);
    const answer = (turn = steered()) => {
      observe(message('m1', '可以关闭下载窗口。'), turn);
      observe(toolCall('t1'), turn);
      return sent;
    };
    return { answer };
  }

  it('answers the steered message once the model goes back to work', () => {
    expect(observer({}).answer()).toEqual([{
      type: 'absorbed_reply', turnId: 'om_followup', answer: '可以关闭下载窗口。', replyUuid: 'm1', source: 'text',
    }]);
    expect(observer({ adoptMode: true }, 'send').answer()).toHaveLength(1);
  });

  it('stays quiet when off, for other CLIs, local turns, and botmux-send delivery outside adopt', () => {
    expect(observer({ followUpReply: undefined }).answer()).toEqual([]);
    expect(observer({ cliId: 'traex' }).answer()).toEqual([]);
    expect(observer({}).answer(steered({ isLocal: true }))).toEqual([]);
    expect(observer({}, 'send').answer()).toEqual([]);
  });
});
