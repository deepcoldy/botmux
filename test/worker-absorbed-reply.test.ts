/**
 * Worker-level replies to Lark messages Claude Code folded into the running
 * turn (adopt): the real live observer (`observeBridgeAttribution` →
 * `observeAbsorbedReplies`) and `emitReadyTurns`, via the worker function
 * harness, over the real BridgeTurnQueue and transcript reader, fed a
 * transcript file the test appends to as Claude would.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as queueModule from '../src/services/bridge-turn-queue.js';
import * as gateModule from '../src/services/bridge-fallback-gate.js';
import * as transcriptModule from '../src/services/claude-transcript.js';
import * as localFailureModule from '../src/services/local-turn-failure.js';
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

function harness(opts: { adoptMode?: boolean; folds?: string[] } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const terminals: Array<{ turnId: string; status: string }> = [];
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
    lastInitConfig: { cliId: 'claude-code', chatId: 'oc_chat', rootMessageId: 'om_root', adoptMode: opts.adoptMode ?? true },
    log: () => {},
    cliName: () => 'Claude',
    zeroPromptTerminalSync: () => false,
    WORKER_STARTED_AT_MS: Date.now() - 1_000,
    send: (msg: Record<string, unknown>) => { sent.push(msg); },
    emitTurnTerminal: (turnId: string, status: string) => { terminals.push({ turnId, status }); },
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
  scope.sendAbsorbedReply = loadWorkerFunction('sendAbsorbedReply', scope);
  scope.observeAbsorbedReplies = loadWorkerFunction('observeAbsorbedReplies', scope);
  const observe = loadWorkerFunction<(ev: TranscriptEvent, turn: queueModule.BridgePendingTurn) => void>('observeBridgeAttribution', scope);
  const emitReadyTurns = loadWorkerFunction<(opts?: { explicitTerminalOnly?: boolean }) => void>('emitReadyTurns', scope);
  queue.mark('om_A', queueModule.makeFingerprint(PROMPT_A), clock - 500, queueModule.normaliseForFingerprint(PROMPT_A));
  for (const [i, prompt] of (opts.folds ?? [PROMPT_B]).entries()) {
    queue.mark(`om_${String.fromCharCode(66 + i)}`, queueModule.makeFingerprint(prompt), clock - 400 + i, queueModule.normaliseForFingerprint(prompt));
  }
  /** Claude writes these records; the worker's live read ingests them. */
  const live = (events: TranscriptEvent[]) => {
    appendFileSync(path, events.map(ev => `${JSON.stringify(ev)}\n`).join(''));
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
  return { live, unobserved, emit, replies, finals, sent, terminals };
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
    expect(reply.replyUuid).toBe('aB');
    expect(h.terminals).toEqual([{ turnId: 'om_A', status: 'completed' }, { turnId: 'om_B', status: 'completed' }]);
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

  it('leaves a session that is not adopted alone', () => {
    const h = harness({ adoptMode: false });
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer'), tool('t1'), result('r1')]);
    h.live([text('a-final', 'done', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([]);
  });
});
