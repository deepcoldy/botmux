/**
 * Worker-level delivery of a Claude background-task wake turn: the real
 * `emitReadyTurns` (via the worker function harness) over the real
 * BridgeTurnQueue, gate and transcript reader, fed the real-shaped fixture
 * (Lark turn launches `run_in_background` Bash; its `<task-notification>`
 * later wakes the main thread, which answers on its own).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as queueModule from '../src/services/bridge-turn-queue.js';
import * as gateModule from '../src/services/bridge-fallback-gate.js';
import * as transcriptModule from '../src/services/claude-transcript.js';
import * as localFailureModule from '../src/services/local-turn-failure.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';
import { t } from '../src/i18n/index.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const FIXTURE = new URL('./fixtures/claude-background-wake/wake-after-lark-turn.jsonl', import.meta.url);
const LARK_PROMPT = '<user_message>盯一下 PR 的 CI，跑完告诉我结果</user_message>';
const OTHER_PROMPT = '<user_message>另一个话题：看下日志</user_message>';
const TASK_ID = 'bxfr0j2hg';
const dir = mkdtempSync(join(tmpdir(), 'bmx-bgwake-worker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Fixture re-stamped as live (written after the queue and worker started). */
function liveEvents(): TranscriptEvent[] {
  const events = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TranscriptEvent);
  const shift = Date.now() + 1_000 - Date.parse(events[0].timestamp!);
  return events.map(ev => ({ ...ev, timestamp: new Date(Date.parse(ev.timestamp!) + shift).toISOString() }));
}

function writeTranscript(events: TranscriptEvent[]): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, events.map(ev => JSON.stringify(ev)).join('\n') + '\n');
  return path;
}

/** A second Lark turn (another topic) that ran between the launch and the wake. */
function otherLarkTurn(events: TranscriptEvent[]): TranscriptEvent[] {
  const wakeAt = Date.parse(events.find(ev => ev.uuid === 'wake-user')!.timestamp!);
  const iso = (offsetMs: number) => new Date(wakeAt - 20_000 + offsetMs).toISOString();
  return [
    { type: 'user', uuid: 'other-user', timestamp: iso(0), isSidechain: false, message: { role: 'user', content: OTHER_PROMPT } },
    { type: 'assistant', uuid: 'other-final', timestamp: iso(10), isSidechain: false, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '日志正常' }] } },
    { type: 'system', subtype: 'turn_duration', uuid: 'other-duration', timestamp: iso(20), isSidechain: false },
  ] as TranscriptEvent[];
}

/** The wake answers, then its stream is cut by a provider error. */
function wakeFailsAfterText(events: TranscriptEvent[]): TranscriptEvent[] {
  const finalAt = Date.parse(events.find(ev => ev.uuid === 'wake-a-final')!.timestamp!);
  const cut = { type: 'assistant', uuid: 'wake-api-error', timestamp: new Date(finalAt + 100).toISOString(), isSidechain: false,
    isApiErrorMessage: true,
    message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'API Error: 500 {"type":"error","error":{"type":"api_error"}}' }] } } as TranscriptEvent;
  return events.flatMap(ev => ev.uuid === 'wake-a-final' ? [ev, cut] : [ev]);
}

function run(replyDelivery: 'send' | 'transcript', opts: { otherTopic?: boolean; wakeFails?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const queue = new queueModule.BridgeTurnQueue();
  let events = liveEvents();
  if (opts.otherTopic) {
    const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
    events = [...events.slice(0, wakeAt), ...otherLarkTurn(events), ...events.slice(wakeAt)];
  }
  if (opts.wakeFails) events = wakeFailsAfterText(events);
  const path = writeTranscript(events);
  const scope: Record<string, unknown> = {
    ...transcriptModule, ...gateModule, ...queueModule, ...localFailureModule, t,
    bridgeQueue: queue,
    bridgeFingerprintScanLastMs: new Map(),
    journalBridgeTurnClear: () => {},
    rememberTurnLinkRefMode: () => {},
    readSendMarkers: () => [],
    lastInitConfig: { cliId: 'claude-code', chatId: 'oc_chat', rootMessageId: 'om_root' },
    log: (line: string) => { logs.push(line); },
    cliName: () => 'Claude',
    zeroPromptTerminalSync: () => false,
    WORKER_STARTED_AT_MS: Date.now() - 1_000,
    send: (msg: Record<string, unknown>) => { sent.push(msg); },
    emitTurnTerminal: () => {},
    replyDeliveryMode: () => replyDelivery,
    sessionId: 'session-under-test',
    bridgeJsonlPath: path,
    workerFinalOutputHandoff: undefined,
    universalOutputHandoff: false,
    finalHandoffAdmissionEnabled: false,
    usageLimitTracker: { noteTurnCompleted: () => {} },
    notifyExplicitRepliesObserved: () => {},
  };
  scope.attributableExplicitReplyMarkersForTurnWindow = loadWorkerFunction('attributableExplicitReplyMarkersForTurnWindow', scope);
  const emitReadyTurns = loadWorkerFunction<(opts?: { explicitTerminalOnly?: boolean; releaseHeldTerminals?: boolean }) => void>('emitReadyTurns', scope);
  queue.mark('om_lark1', queueModule.makeFingerprint(LARK_PROMPT), Date.now() - 60_000, queueModule.normaliseForFingerprint(LARK_PROMPT));
  if (opts.otherTopic) {
    queue.mark('om_lark2', queueModule.makeFingerprint(OTHER_PROMPT), Date.now() - 30_000, queueModule.normaliseForFingerprint(OTHER_PROMPT));
  }
  queue.ingest(events, path);
  emitReadyTurns({ explicitTerminalOnly: true, releaseHeldTerminals: true });
  const finals = sent.filter(msg => msg.type === 'final_output')
    .map(msg => ({ turnId: msg.turnId, replyTurnId: msg.replyTurnId, content: msg.content }));
  const notices = sent.filter(msg => msg.type === 'user_notify');
  return { finals, notices, logs };
}

describe('worker emitReadyTurns: Claude background-task wake', () => {
  it('transcript delivery posts the wake answer, anchored to the Lark turn that launched the task', () => {
    const { finals } = run('transcript');
    expect(finals.map(f => f.turnId)).toEqual(['om_lark1', 'local-headless-wake-a-final']);
    expect(finals[1]).toMatchObject({ replyTurnId: 'om_lark1' });
    expect(String(finals[1].content)).toContain('CI 已全部跑完');
  });

  it('send delivery posts only the Lark turn; the wake stays a suppressed local turn', () => {
    expect(run('send').finals.map(f => f.turnId)).toEqual(['om_lark1']);
  });

  it('a forwarded wake that fails reports to the launching topic, not the latest Lark turn', () => {
    const { finals, notices } = run('transcript', { otherTopic: true, wakeFails: true });
    expect(finals.some(f => f.turnId === 'local-headless-wake-a-final')).toBe(false);
    expect(notices).toEqual([expect.objectContaining({ turnId: 'om_lark1' })]);
  });

  it('in send delivery a failed wake keeps the ordinary local-turn notice target', () => {
    const { notices } = run('send', { otherTopic: true, wakeFails: true });
    expect(notices).toEqual([expect.objectContaining({ turnId: 'om_lark2' })]);
  });
});

describe('worker syncBackgroundTaskPinsToDaemon', () => {
  function pinSync(replyDelivery: 'send' | 'transcript', initConfig: Record<string, unknown> = {}, zeroInjection = false) {
    const sent: Array<Record<string, unknown>> = [];
    const queue = new queueModule.BridgeTurnQueue();
    const tracker = new transcriptModule.BackgroundTaskTracker();
    const scope: Record<string, unknown> = {
      bridgeQueue: queue,
      backgroundTaskTracker: tracker,
      // The production change detector, in its initial ("never sent") state.
      backgroundTaskPins: new queueModule.BackgroundTaskPinSnapshot(),
      backgroundWaitTasks: 0,
      backgroundStopScanSinceMs: 0,
      backgroundStopScanOffsets: new Map(),
      lastInitConfig: { cliId: 'claude-code', ...initConfig },
      replyDeliveryMode: () => replyDelivery,
      zeroPromptTerminalSync: () => zeroInjection,
      send: (msg: Record<string, unknown>) => { sent.push(msg); },
      log: () => {},
    };
    // The real drain hook (observeClaudeBackgroundTasks) and the sampler-tick
    // refresh, wired to the real sync, over the real queue and tracker.
    scope.syncBackgroundTaskPinsToDaemon = loadWorkerFunction('syncBackgroundTaskPinsToDaemon', scope);
    scope.refreshBackgroundWait = loadWorkerFunction('refreshBackgroundWait', scope);
    const observe = loadWorkerFunction<(events: readonly TranscriptEvent[]) => void>('observeClaudeBackgroundTasks', scope);
    const tick = scope.refreshBackgroundWait as () => void;
    queue.mark('om_lark1', queueModule.makeFingerprint(LARK_PROMPT), Date.now() - 60_000, queueModule.normaliseForFingerprint(LARK_PROMPT));
    const events = liveEvents();
    const feed = (slice: TranscriptEvent[]) => {
      queue.ingest(slice);
      observe(slice);
    };
    const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
    return { sent, feed, tick, launch: events.slice(0, wakeAt), wake: events.slice(wakeAt) };
  }

  it('pins the launching Lark turn while the task runs and releases it when the task stops', () => {
    const { sent, feed, tick, launch, wake } = pinSync('transcript');
    feed(launch);
    expect(sent).toEqual([{ type: 'background_task_pins_sync', turnIds: ['om_lark1'] }]);
    tick();
    expect(sent).toHaveLength(1);
    feed(wake);  // the completed notification stops the task
    expect(sent.at(-1)).toEqual({ type: 'background_task_pins_sync', turnIds: [] });
    expect(sent).toHaveLength(2);
  });

  it('sends nothing where a wake is never forwarded', () => {
    for (const { mode, cfg, zero } of [
      { mode: 'send' as const, cfg: {}, zero: false },
      { mode: 'transcript' as const, cfg: { adoptMode: true }, zero: false },
      { mode: 'transcript' as const, cfg: {}, zero: true },
    ]) {
      const { sent, feed, launch, wake } = pinSync(mode, cfg, zero);
      feed(launch);
      feed(wake);
      expect(sent).toEqual([]);
    }
  });

  it('pins nothing for a task launched outside a Lark turn, after one snapshot that clears an earlier worker\'s pins', () => {
    const { sent, feed, tick, launch } = pinSync('transcript');
    // Same launch, but typed in the terminal: no Lark mark matches the prompt.
    feed(launch.map(ev => ev.uuid === 'lark-user-1'
      ? { ...ev, message: { role: 'user', content: '本地终端里敲的命令' } } as TranscriptEvent
      : ev));
    tick();
    expect(sent).toEqual([{ type: 'background_task_pins_sync', turnIds: [] }]);
  });
});
