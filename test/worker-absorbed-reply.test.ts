/**
 * Worker-level replies to Lark messages Claude Code folded into the running
 * turn (adopt): the real live observer (`observeBridgeAttribution` →
 * `observeAbsorbedReplies`) and `emitReadyTurns`, via the worker function
 * harness, over the real BridgeTurnQueue and transcript reader, fed a
 * transcript file the test appends to as Claude would. Plus the Codex
 * mid-turn reply observer (`observeCodexMidTurnReply`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as queueModule from '../src/services/bridge-turn-queue.js';
import * as gateModule from '../src/services/bridge-fallback-gate.js';
import * as transcriptModule from '../src/services/claude-transcript.js';
import * as localFailureModule from '../src/services/local-turn-failure.js';
import { CodexMidTurnReplyCollector, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
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
/** Claude Code ≥ 2.1.31x: a uuid-less copy of the request's user content,
 *  written after a fold and before the model's answer to it. */
const requestCopy = (prompt: string): TranscriptEvent => ({
  type: 'api-request-blob', sessionId: 's', hash: 'h',
  message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'x', content: 'ok' },
    { type: 'text', text: `<system-reminder>\nThe user sent a new message while you were working:\n${prompt}\n</system-reminder>` },
  ] },
}) as unknown as TranscriptEvent;

/** Cap on a terminal-typed turn's mirrored answer in this fixture (the worker's
 *  LOCAL_TURN_ASSISTANT_MAX), small so a test can exceed it. */
const LOCAL_CAP = 200;

function harness(opts: {
  adoptMode?: boolean; folds?: string[]; followUpReply?: boolean; replyDelivery?: 'send' | 'transcript';
  /** Lark turn the host prompt binds to; null leaves it unmarked (a terminal-typed turn). */
  host?: string | null;
  /** Final outputs go through the worker's final-output handoff. */
  handoff?: boolean;
} = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const offers: Array<{ turnId: string; content: string }> = [];
  let failLinkRefFor: string | undefined;
  const terminals: Array<{ turnId: string; status: string; disposition?: string }> = [];
  const reads: number[] = [];
  let failReplySends = 0;
  const queue = new queueModule.BridgeTurnQueue();
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, '');
  const scope: Record<string, unknown> = {
    ...transcriptModule, ...gateModule, ...queueModule, ...localFailureModule, ...restoredLabelModule, t,
    bridgeQueue: queue,
    bridgeFingerprintScanLastMs: new Map(),
    journalBridgeTurnClear: () => {},
    rememberTurnLinkRefMode: (turnId: string) => {
      if (turnId === failLinkRefFor) { failLinkRefFor = undefined; throw new Error('journal write failed'); }
    },
    readSendMarkers: () => [],
    lastInitConfig: {
      cliId: 'claude-code', chatId: 'oc_chat', rootMessageId: 'om_root', adoptMode: opts.adoptMode ?? true,
      ...(opts.followUpReply ?? true ? { followUpReply: true } : {}),
    },
    log: () => {},
    cliName: () => 'Claude',
    zeroPromptTerminalSync: () => false,
    WORKER_STARTED_AT_MS: Date.now() - 1_000,
    send: (msg: Record<string, unknown>) => {
      if (msg.type === 'absorbed_reply' && failReplySends > 0) { failReplySends--; throw new Error('IPC channel closed'); }
      sent.push(msg);
    },
    emitTurnTerminal: (turnId: string, status: string, _code?: string, _attempt?: number, disposition?: string) => {
      terminals.push({ turnId, status, ...(disposition ? { disposition } : {}) });
    },
    drainTranscript: (file: string, offset: number) => { reads.push(offset); return transcriptModule.drainTranscript(file, offset); },
    foldReadOffsets: new Map(),
    FOLD_READ_OFFSETS_MAX: 32,
    replyDeliveryMode: () => opts.replyDelivery ?? 'transcript',
    sessionId: 'session-under-test',
    bridgeJsonlPath: path,
    workerFinalOutputHandoff: opts.handoff
      ? { offer: (out: { turnId: string; content: string }) => { offers.push(out); }, hasTurn: () => false }
      : undefined,
    bridgeTurnJournalFilePath: () => join(dir, 'journal.jsonl'),
    readBridgeTurnJournal: () => [],
    canAdmitFinalOutputHandoff: () => true,
    canHandoffFinalOutput: () => true,
    LOCAL_TURN_USER_MAX: 1_000,
    LOCAL_TURN_ASSISTANT_MAX: LOCAL_CAP,
    universalOutputHandoff: false,
    finalHandoffAdmissionEnabled: opts.handoff === true,
    usageLimitTracker: { noteTurnCompleted: () => {} },
    notifyExplicitRepliesObserved: () => {},
    observeThinkingAttribution: () => {},
    absorbedReplyCollectors: new WeakMap(),
    followUpReplyLive: undefined,
  };
  scope.attributableExplicitReplyMarkersForTurnWindow = loadWorkerFunction('attributableExplicitReplyMarkersForTurnWindow', scope);
  scope.followUpReplyEnabled = loadWorkerFunction('followUpReplyEnabled', scope);
  scope.foldReplyEnabled = loadWorkerFunction('foldReplyEnabled', scope);
  const setFollowUpReplyLive = loadWorkerFunction<(enabled: boolean) => void>('setFollowUpReplyLive', scope);
  scope.truncatePreambleText = loadWorkerFunction('truncatePreambleText', scope);
  scope.formatLocalTurnFields = loadWorkerFunction('formatLocalTurnFields', scope);
  scope.formatHeadlessLocalTurnContent = loadWorkerFunction('formatHeadlessLocalTurnContent', scope);
  scope.sendAbsorbedReply = loadWorkerFunction('sendAbsorbedReply', scope);
  scope.readFoldReply = loadWorkerFunction('readFoldReply', scope);
  const noteFoldReadOffsets = loadWorkerFunction<(events: TranscriptEvent[], file: string, offset: number) => void>('noteFoldReadOffsets', scope);
  scope.observeAbsorbedReplies = loadWorkerFunction('observeAbsorbedReplies', scope);
  const observe = loadWorkerFunction<(ev: TranscriptEvent, turn: queueModule.BridgePendingTurn) => void>('observeBridgeAttribution', scope);
  const emitReadyTurns = loadWorkerFunction<(opts?: { explicitTerminalOnly?: boolean }) => void>('emitReadyTurns', scope);
  /** The polling read pops turns at a screen-idle edge too, without waiting for terminal records. */
  const emitAtIdle = () => emitReadyTurns({});
  const host = opts.host === undefined ? 'om_A' : opts.host;
  if (host) queue.mark(host, queueModule.makeFingerprint(PROMPT_A), clock - 500, queueModule.normaliseForFingerprint(PROMPT_A));
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
  /** The CLI rewrote the transcript (shorter) without the worker reading it. */
  const rewrite = (events: TranscriptEvent[]) => writeFileSync(path, events.map(ev => `${JSON.stringify(ev)}\n`).join(''));
  /** The daemon pushed a change of the bot's followUpReply (set_follow_up_reply). */
  const setFollowUpReply = (enabled: boolean) => setFollowUpReplyLive(enabled);
  const failNextReplySend = () => { failReplySends = 1; };
  /** The next emit throws while it handles `turnId` (a journal write failing). */
  const failEmitAt = (turnId: string) => { failLinkRefFor = turnId; };
  const finalKinds = () => sent.filter(msg => msg.type === 'final_output').map(msg => [msg.turnId, msg.kind ?? 'turn'] as const);
  return {
    live, unobserved, rewrite, emit, emitAtIdle, replies, finals, finalKinds, offers, sent, terminals, reads, path,
    setFollowUpReply, failNextReplySend, failEmitAt,
  };
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

  it('falls back to the whole transcript when its fold is no longer where it was read', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0')]);
    const batch = [fold('qB', PROMPT_B), text('aB', '用的是 gpt-6-astra。')];
    h.live(batch);
    h.rewrite(batch);
    h.live([tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '用的是 gpt-6-astra。', 'text']]);
    expect(h.reads.at(-1)).toBe(0);
  });

  it('marks the reply as the turn\'s final only under transcript delivery', () => {
    const h = harness({ replyDelivery: 'send' });
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer'), tool('t1')]);
    expect(h.replies()).toEqual([['om_B', 'answer', 'text']]);
    expect(h.sent.find(msg => msg.type === 'absorbed_reply')).not.toHaveProperty('turnReply');
  });

  it('answers with a thinking summary, marked as such', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), thinking('aB', '对，用的是 gpt-6-astra。'), tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '对，用的是 gpt-6-astra。', 'thinking']]);
  });

  it('lets the host turn\'s final carry an answer written at its end, posted once', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), text('a0', '先跑单测。'), tool('t0'), result('r0'), fold('qB', PROMPT_B),
      text('a-final', 'answer and summary', 'end_turn'), duration('dur')]);
    expect(h.replies()).toEqual([]);
    h.emit();
    expect(h.replies()).toEqual([]);
    expect(h.finals()).toEqual([['om_A', '先跑单测。\n\nanswer and summary']]);
    expect(h.terminals).toEqual([{ turnId: 'om_A', status: 'completed' }, { turnId: 'om_B', status: 'completed' }]);
  });

  it('answers at the end of the host turn with what the host\'s final does not carry', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), thinking('aB', '对，用的是 gpt-6-astra。'), duration('dur')]);
    expect(h.replies()).toEqual([]);
    h.emit();
    expect(h.replies()).toEqual([['om_B', '对，用的是 gpt-6-astra。', 'thinking']]);
    expect(h.finals()).toEqual([]);
  });

  it('keeps a live reply too long to post whole in the host turn\'s final', () => {
    const long = '长'.repeat(transcriptModule.ABSORBED_REPLY_MAX_CHARS + 1);
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', long), tool('t1'), result('r1')]);
    h.live([text('a-final', 'done', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([['om_B', long, 'text']]);
    expect(h.finals()).toEqual([['om_A', `${long}\n\ndone`]]);
  });

  it('keeps a live reply in the host turn\'s final once followUpReply is switched off', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', '收到，开始做。'), tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '收到，开始做。', 'text']]);
    // The daemon gates posting on the live switch, so that reply may have been dropped.
    h.setFollowUpReply(false);
    h.live([result('r1'), text('a-final', 'done', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.finals()).toEqual([['om_A', '收到，开始做。\n\ndone']]);
    expect(h.terminals).toEqual([{ turnId: 'om_A', status: 'completed' }, { turnId: 'om_B', status: 'completed' }]);
  });

  it('starts answering folded messages once followUpReply is switched on', () => {
    const h = harness({ followUpReply: false });
    h.setFollowUpReply(true);
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', '收到，开始做。'), tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '收到，开始做。', 'text']]);
  });

  it('keeps a reply whose live send failed in the host turn\'s final, posted once', () => {
    const h = harness();
    h.failNextReplySend();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', '收到，开始做。'), tool('t1')]);
    expect(h.replies()).toEqual([]);
    h.live([result('r1'), text('a-final', 'done', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([]);
    expect(h.finals()).toEqual([['om_A', '收到，开始做。\n\ndone']]);
  });

  it('does not settle a folded turn apart from its host when its live reply failed to send', () => {
    const h = harness();
    h.failNextReplySend();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', 'answer'), tool('t1'), result('r1')]);
    h.live([apiError('err'), duration('dur')]);
    h.emit();
    const status = (turnId: string) => h.terminals.find(term => term.turnId === turnId)?.status;
    expect(status('om_A')).not.toBe('completed');
    expect(status('om_B')).toBe(status('om_A'));
  });

  it('lets a terminal-typed host turn\'s mirrored final carry an answer written at its end', () => {
    const h = harness({ host: null });
    h.live([user('uL', 'terminal typed prompt'), tool('t0'), result('r0'), fold('qB', PROMPT_B),
      text('a-final', 'THE_ANSWER', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([]);
    expect(h.finals()).toEqual([[expect.stringMatching(/^local-/), 'THE_ANSWER']]);
    expect(h.finalKinds()).toEqual([[expect.stringMatching(/^local-/), 'local-turn']]);
  });

  it('still answers the folded message when a terminal-typed host\'s mirror is cut before the answer', () => {
    const h = harness({ host: null });
    h.live([user('uL', 'terminal typed prompt'), text('a0', 'x'.repeat(LOCAL_CAP + 50)), tool('t0'), result('r0'),
      fold('qB', PROMPT_B), text('a-final', 'THE_ANSWER', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.finals()[0][1]).not.toContain('THE_ANSWER');
    expect(h.replies()).toEqual([['om_B', 'THE_ANSWER', 'text']]);
  });

  it('lets a headless continuation host\'s final carry an answer written at its end', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), text('a0', 'step one'), tool('t0')]);
    h.emitAtIdle();
    h.live([result('r0'), text('a1', 'step two'), tool('t1'), result('r1'),
      fold('qB', PROMPT_B), text('a-final', 'THE_ANSWER', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.finalKinds().map(([, kind]) => kind)).toEqual(['turn', 'local-turn-headless']);
    expect(h.finals()[1][1]).toContain('THE_ANSWER');
    expect(h.replies()).toEqual([]);
  });

  it('still answers the folded message when the host is a headless continuation cut before the answer', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), text('a0', 'step one'), tool('t0')]);
    h.emitAtIdle();
    h.live([result('r0'), text('a1', 'x'.repeat(LOCAL_CAP + 50)), tool('t1'), result('r1'),
      fold('qB', PROMPT_B), text('a-final', 'THE_ANSWER', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.finalKinds().map(([, kind]) => kind)).toEqual(['turn', 'local-turn-headless']);
    expect(h.finals().some(([, content]) => content.includes('THE_ANSWER'))).toBe(false);
    expect(h.replies()).toEqual([['om_B', 'THE_ANSWER', 'text']]);
  });

  it('lets a handed-off host final carry an answer written at its end', () => {
    const h = harness({ handoff: true });
    h.live([user('uA', PROMPT_A), text('a0', 'pre'), tool('t0'), result('r0'), fold('qB', PROMPT_B),
      text('a-final', 'THE_ANSWER', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.offers.map(out => [out.turnId, out.content])).toEqual([['om_A', 'pre\n\nTHE_ANSWER']]);
    expect(h.replies()).toEqual([]);
  });

  it('answers the folded message itself when the host\'s final does not go to the chat (an HTTP trigger)', () => {
    const h = harness({ host: 'trg_A' });
    h.live([user('uA', PROMPT_A), text('a0', 'pre'), tool('t0'), result('r0'), fold('qB', PROMPT_B),
      text('a-final', 'THE_ANSWER', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.finals()).toEqual([['trg_A', 'pre\n\nTHE_ANSWER']]);
    expect(h.replies()).toEqual([['om_B', 'THE_ANSWER', 'text']]);
  });

  it('posts an answer its host\'s final carried only once when the emit is retried after a throw', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), text('a0', 'pre'), tool('t0'), result('r0'), fold('qB', PROMPT_B),
      text('a-final', 'THE_ANSWER', 'end_turn'), duration('dur')]);
    h.failEmitAt('om_B');
    expect(() => h.emit()).toThrow('journal write failed');
    h.emit();
    expect(h.finals()).toEqual([['om_A', 'pre\n\nTHE_ANSWER']]);
    expect(h.replies()).toEqual([]);
  });

  it('leaves a reply it sent live out of the host turn\'s final', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), text('a0', '先跑单测。'), tool('t0'), result('r0'),
      fold('qB', PROMPT_B), text('aB', '收到，开始做。'), tool('t1'), result('r1')]);
    h.live([text('a-final', 'all green', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([['om_B', '收到，开始做。', 'text']]);
    expect(h.finals()).toEqual([['om_A', '先跑单测。\n\nall green']]);
  });

  it('posts no second copy of a live reply when an idle edge cuts the host while it still works', () => {
    // The live reply is all the host has said when the screen looks idle mid-turn.
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), text('aB', '收到，开始做。'), tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '收到，开始做。', 'text']]);
    h.live([result('r1'), tool('t2')]);
    h.emitAtIdle();
    expect(h.replies()).toHaveLength(1);
    expect(h.finals()).toEqual([]);
    // Its output went out as the reply: not a turn cut off without output.
    expect(h.terminals).toEqual([{ turnId: 'om_A', status: 'completed' }, { turnId: 'om_B', status: 'completed' }]);
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
    // Not yet answered live: the host's final carries the answer, once.
    expect(h.replies()).toEqual([]);
    expect(h.finals()).toEqual([['om_A', 'answer']]);
    expect(h.terminals).toEqual([{ turnId: 'om_A', status: 'completed' }, { turnId: 'om_B', status: 'completed' }]);
  });

  it('reads past the request copy Claude Code writes before the answer, live and at the turn end', () => {
    const h = harness();
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), requestCopy(PROMPT_B), text('aB', '用的是 gpt-6-astra。')]);
    h.live([tool('t1')]);
    expect(h.replies()).toEqual([['om_B', '用的是 gpt-6-astra。', 'text']]);
    const atEnd = harness();
    atEnd.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), requestCopy(PROMPT_B),
      thinking('aB', 'answer'), duration('dur')]);
    atEnd.emit();
    expect(atEnd.replies()).toEqual([['om_B', 'answer', 'thinking']]);
  });

  it('gives a later folded message its own answer and the earlier silent one none', () => {
    const h = harness({ folds: [PROMPT_B, PROMPT_C] });
    h.live([user('uA', PROMPT_A), tool('t0'), result('r0'), fold('qB', PROMPT_B), thinking('aB', ''), tool('t1'), result('r1')]);
    h.live([fold('qC', PROMPT_C), text('aC', 'CI 全绿。'), tool('t2'), result('r2')]);
    h.live([text('a-final', 'done', 'end_turn'), duration('dur')]);
    h.emit();
    expect(h.replies()).toEqual([['om_C', 'CI 全绿。', 'text']]);
    expect(h.finals()).toEqual([['om_A', 'done']]);
  });

  it('suppresses ambiguous answers after consecutive folds without assistant activity, live and at turn end', () => {
    const live = harness({ folds: [PROMPT_B, PROMPT_C] });
    live.live([user('uA', PROMPT_A), tool('t0'), result('r0'),
      fold('qB', PROMPT_B), fold('qC', PROMPT_C), text('aC', '用的是 gpt-x。'), tool('t1'), result('r1')]);
    expect(live.replies()).toEqual([]);
    live.live([text('a-final', 'done', 'end_turn'), duration('dur')]);
    live.emit();
    expect(live.replies()).toEqual([]);
    // Unposted as a reply, it stays in the host's final.
    expect(live.finals()).toEqual([['om_A', '用的是 gpt-x。\n\ndone']]);

    const atEnd = harness({ folds: [PROMPT_B, PROMPT_C] });
    atEnd.live([user('uA', PROMPT_A), tool('t0'), result('r0'),
      fold('qB', PROMPT_B), fold('qC', PROMPT_C), text('a-final', '用的是 gpt-x。', 'end_turn'), duration('dur')]);
    atEnd.emit();
    expect(atEnd.replies()).toEqual([]);
    expect(atEnd.finals()).toEqual([['om_A', '用的是 gpt-x。']]);
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
    expect(answered.finals()).toEqual([['om_A', 'answer\n\ndone']]);
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

describe('worker: Codex mid-turn replies', () => {
  const steered = (overrides: Partial<CodexPendingTurn> = {}): CodexPendingTurn =>
    ({ turnId: 'om_followup', started: true, steeredMidTurn: true, transcriptStartTimeMs: 0, ...overrides }) as CodexPendingTurn;
  const ordinary = (overrides: Partial<CodexPendingTurn> = {}): CodexPendingTurn =>
    ({ turnId: 'om_task', started: true, ...overrides }) as CodexPendingTurn;
  const message = (uuid: string, value: string): CodexBridgeEvent =>
    ({ uuid, timestampMs: 0, kind: 'cot', text: '', cotEntries: [], assistantMessage: value });
  const toolCall = (uuid: string): CodexBridgeEvent =>
    ({ uuid, timestampMs: 0, kind: 'cot', text: '', cotEntries: [{ kind: 'tool_call', id: uuid, name: 'js', args: '' }] });

  function observer(initConfig: Record<string, unknown>, replyDelivery: 'send' | 'transcript' = 'transcript', workerStartedAtMs = 0) {
    const sent: Array<Record<string, unknown>> = [];
    const scope: Record<string, unknown> = {
      lastInitConfig: { cliId: 'codex', followUpReply: true, ...initConfig },
      replyDeliveryMode: () => replyDelivery,
      send: (msg: Record<string, unknown>) => { sent.push(msg); },
      log: () => {},
      CodexMidTurnReplyCollector,
      codexMidTurnReplyCollectors: new WeakMap(),
      WORKER_STARTED_AT_MS: workerStartedAtMs,
    };
    scope.followUpReplyEnabled = loadWorkerFunction('followUpReplyEnabled', scope);
    scope.structuredBridgeIs = loadWorkerFunction('structuredBridgeIs', scope);
    const observe = loadWorkerFunction<(ev: CodexBridgeEvent, turn: CodexPendingTurn) => void>('observeCodexMidTurnReply', scope);
    const say = (turn: CodexPendingTurn, uuid: string, text: string, saidAtMs = 0) => {
      observe({ ...message(uuid, text), timestampMs: saidAtMs }, turn);
      observe(toolCall(`${uuid}-tool`), turn);
      return sent;
    };
    return { answer: (turn = steered()) => say(turn, 'm1', '可以关闭下载窗口。'), say };
  }

  it('answers the steered message once the model goes back to work, then posts what it says next as progress', () => {
    const o = observer({});
    const turn = steered();
    o.say(turn, 'm1', '可以关闭下载窗口。');
    expect(o.say(turn, 'm2', '继续跑剩下的用例。')).toEqual([
      { type: 'absorbed_reply', turnId: 'om_followup', answer: '可以关闭下载窗口。', replyUuid: 'm1', source: 'text' },
      { type: 'absorbed_reply', turnId: 'om_followup', answer: '继续跑剩下的用例。', replyUuid: 'm2', source: 'text', progress: true },
    ]);
    expect(observer({ adoptMode: true }, 'send').answer()).toHaveLength(1);
  });

  it('posts an ordinary turn\'s mid-work messages as progress', () => {
    const o = observer({ adoptMode: true });
    const turn = ordinary({ dispatchAttempt: 2 });
    o.say(turn, 'm1', '我先确认终端里实际使用的 Codex CLI 版本。');
    expect(o.say(turn, 'm2', '正在安装 0.171.0。')).toEqual([
      { type: 'absorbed_reply', turnId: 'om_task', dispatchAttempt: 2, answer: '我先确认终端里实际使用的 Codex CLI 版本。', replyUuid: 'm1', source: 'text', progress: true },
      { type: 'absorbed_reply', turnId: 'om_task', dispatchAttempt: 2, answer: '正在安装 0.171.0。', replyUuid: 'm2', source: 'text', progress: true },
    ]);
  });

  it('does not re-post what was said before this worker started, and calls a steer taken before it progress', () => {
    const o = observer({ adoptMode: true }, 'transcript', 1_000);
    const turn = ordinary();
    expect(o.say(turn, 'm1', 'replayed from the previous worker', 999)).toEqual([]);
    expect(o.say(turn, 'm2', 'said now', 1_000)).toMatchObject([{ answer: 'said now', progress: true }]);
    const earlier = observer({ adoptMode: true }, 'transcript', 1_000);
    expect(earlier.say(steered({ transcriptStartTimeMs: 500 }), 'm1', 'after the restart', 1_500))
      .toMatchObject([{ answer: 'after the restart', progress: true }]);
    const live = observer({ adoptMode: true }, 'transcript', 1_000);
    expect(live.say(steered({ transcriptStartTimeMs: 1_200 }), 'm1', 'the answer', 1_500)[0]).not.toHaveProperty('progress');
  });

  it('stays quiet when off, for other CLIs, local turns, and botmux-send delivery outside adopt', () => {
    expect(observer({ followUpReply: undefined }).answer()).toEqual([]);
    expect(observer({ followUpReply: undefined }).answer(ordinary())).toEqual([]);
    expect(observer({ cliId: 'traex' }).answer()).toEqual([]);
    expect(observer({}).answer(steered({ isLocal: true }))).toEqual([]);
    expect(observer({}).answer(ordinary({ isLocal: true }))).toEqual([]);
    expect(observer({}, 'send').answer()).toEqual([]);
    expect(observer({}, 'send').answer(ordinary())).toEqual([]);
  });
});
