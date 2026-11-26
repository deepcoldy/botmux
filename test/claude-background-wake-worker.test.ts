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

describe('worker foldBackgroundUpdates: non-terminal Monitor mid-stream gating & CoT folding', () => {
  interface HarnessOpts {
    replyDelivery?: 'send' | 'transcript';
    zeroPrompt?: boolean;
    foldBackgroundUpdates?: boolean;
    adoptMode?: boolean;
    apiOnly?: boolean;
    sendMarkers?: gateModule.BridgeSendMarker[];
  }

  function createHarness(opts: HarnessOpts = {}) {
    const sent: Array<Record<string, unknown>> = [];
    const terminals: Array<{ turnId: string; status: string; dispatchAttempt?: number }> = [];
    const logs: string[] = [];
    const answeredCalls: string[] = [];
    const tracker = new transcriptModule.BackgroundTaskTracker();
    const scope: Record<string, unknown> = {
      ...transcriptModule,
      ...gateModule,
      ...queueModule,
      ...localFailureModule,
      t,
      bridgeFingerprintScanLastMs: new Map(),
      journalBridgeTurnClear: () => {},
      rememberTurnLinkRefMode: () => {},
      readSendMarkers: () => opts.sendMarkers ?? [],
      lastInitConfig: {
        cliId: 'claude-code',
        chatId: 'oc_chat',
        rootMessageId: 'om_root',
        ...(opts.adoptMode ? { adoptMode: true } : {}),
        ...(opts.apiOnly ? { apiOnly: true } : {}),
        ...(opts.zeroPrompt ? { promptInjection: 'none' } : {}),
        ...(opts.foldBackgroundUpdates ? { foldBackgroundUpdates: true } : {}),
      },
      log: (line: string) => { logs.push(line); },
      cliName: () => 'Claude',
      zeroPromptTerminalSync: () => opts.zeroPrompt === true && !opts.adoptMode && !opts.apiOnly,
      WORKER_STARTED_AT_MS: Date.now() - 1_000,
      send: (msg: Record<string, unknown>) => { sent.push(msg); },
      emitTurnTerminal: (turnId: string, status: string, _err?: string, dispatchAttempt?: number) => {
        terminals.push({ turnId, status, dispatchAttempt });
      },
      replyDeliveryMode: () => opts.replyDelivery ?? 'transcript',
      sessionId: 'session-monitor-test',
      bridgeJsonlPath: '',
      workerFinalOutputHandoff: undefined,
      universalOutputHandoff: false,
      finalHandoffAdmissionEnabled: false,
      foldReplyEnabled: () => false,
      hostWithPendingAbsorbedReply: () => false,
      formatHeadlessLocalTurnContent: (text: string) => text,
      formatLocalTurnFields: (u: string, a: string) => ({ content: `${u}\n${a}`, userText: u }),
      usageLimitTracker: { noteTurnCompleted: (k: string) => { answeredCalls.push(k); } },
      notifyExplicitRepliesObserved: () => {},
      backgroundTaskTracker: tracker,
      backgroundTaskPins: new queueModule.BackgroundTaskPinSnapshot(),
      backgroundWaitTasks: 0,
      backgroundCotHold: false,
      backgroundStopScanSinceMs: 0,
      backgroundStopScanOffsets: new Map(),
      antigravityFooterBackgroundTasks: 0,
      // CoT accumulator state matching src/worker.ts
      thinkingTurnKey: undefined as string | undefined,
      thinkingTurn: undefined as { turnId: string; dispatchAttempt?: number } | undefined,
      thinkingEntries: [] as unknown[],
      thinkingTotalChars: 0,
      thinkingCapNoted: false,
      THINKING_ACCUMULATED_CAP: 60_000,
      THINKING_EMIT_INTERVAL_MS: 1_500,
      thinkingEmitTimer: null as ReturnType<typeof setTimeout> | null,
      cotEntryChars: (e: { text?: string; args?: string; result?: string }) =>
        (e.text?.length ?? 0) + (e.args?.length ?? 0) + (e.result?.length ?? 0),
    };
    scope.scheduleThinkingEmit = () => {};
    scope.flushThinkingUpdate = () => {
      const turn = scope.thinkingTurn as { turnId: string; dispatchAttempt?: number } | undefined;
      const entries = scope.thinkingEntries as unknown[];
      if (!turn || entries.length === 0) return;
      sent.push({
        type: 'thinking_update',
        turnId: turn.turnId,
        ...(turn.dispatchAttempt !== undefined ? { dispatchAttempt: turn.dispatchAttempt } : {}),
        entries: [...entries],
      });
    };
    scope.syncBackgroundTaskPinsToDaemon = loadWorkerFunction('syncBackgroundTaskPinsToDaemon', scope);
    scope.refreshBackgroundWait = loadWorkerFunction('refreshBackgroundWait', scope);
    scope.observeCotEntries = loadWorkerFunction('observeCotEntries', scope);
    scope.observeThinkingAttribution = loadWorkerFunction('observeThinkingAttribution', scope);
    scope.observePendingMonitorWakeCotActivity = loadWorkerFunction('observePendingMonitorWakeCotActivity', scope);
    scope.flushPendingMonitorWakeCotOnTextlessComplete = loadWorkerFunction('flushPendingMonitorWakeCotOnTextlessComplete', scope);
    scope.notifyTerminalTurnStarted = loadWorkerFunction('notifyTerminalTurnStarted', scope);
    scope.attributableExplicitReplyMarkersForTurnWindow = loadWorkerFunction('attributableExplicitReplyMarkersForTurnWindow', scope);
    scope.setFoldBackgroundUpdatesLive = loadWorkerFunction('setFoldBackgroundUpdatesLive', scope);
    scope.resetFoldBackgroundUpdatesStateForInit = loadWorkerFunction('resetFoldBackgroundUpdatesStateForInit', scope);
    scope.backgroundWaitPayload = loadWorkerFunction('backgroundWaitPayload', scope);
    const emitReadyTurns = loadWorkerFunction<(opts?: { explicitTerminalOnly?: boolean; releaseHeldTerminals?: boolean }) => void>('emitReadyTurns', scope);

    const queue = new queueModule.BridgeTurnQueue(
      turn => (scope.notifyTerminalTurnStarted as (t: queueModule.BridgePendingTurn) => void)(turn),
    );
    scope.bridgeQueue = queue;

    const observeThinking = scope.observeThinkingAttribution as (ev: TranscriptEvent, turn: queueModule.BridgePendingTurn) => void;
    const pendingWakeObserver: queueModule.PendingWakeCotObserver = {
      onActivity: (ev, anchor) => (scope.observePendingMonitorWakeCotActivity as (e: TranscriptEvent, a: queueModule.BackgroundTaskAnchor) => void)(ev, anchor),
      onTextlessComplete: anchor => (scope.flushPendingMonitorWakeCotOnTextlessComplete as (a: queueModule.BackgroundTaskAnchor) => void)(anchor),
    };

    const transcriptPath = join(dir, `monitor-${Math.random().toString(36).slice(2)}.jsonl`);
    const allEvents: TranscriptEvent[] = [];
    const feed = (batch: TranscriptEvent[], emit = true) => {
      allEvents.push(...batch);
      writeFileSync(transcriptPath, allEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
      scope.bridgeJsonlPath = transcriptPath;
      queue.ingest(batch, transcriptPath, observeThinking, undefined, pendingWakeObserver);
      for (const ev of batch) tracker.observe(ev);
      (scope.refreshBackgroundWait as () => void)();
      if (emit) emitReadyTurns({ explicitTerminalOnly: true });
    };

    return {
      sent, terminals, logs, answeredCalls, queue, tracker, scope, feed, emitReadyTurns,
      finals: () => sent.filter(m => m.type === 'final_output'),
      thinkings: () => sent.filter(m => m.type === 'thinking_update'),
      terminalStarts: () => sent.filter(m => m.type === 'terminal_turn_started'),
      userNotifies: () => sent.filter(m => m.type === 'user_notify'),
    };
  }

  function makeTurnEvents(base: number) {
    const iso = (ms: number) => new Date(base + ms).toISOString();
    return {
      user: (uuid: string, ms: number, text: string): TranscriptEvent => ({
        type: 'user', uuid, timestamp: iso(ms), isSidechain: false, promptSource: 'user',
        message: { role: 'user', content: text },
      } as TranscriptEvent),
      monitorAck: (uuid: string, ms: number, taskId: string, persistent = false, timeoutMs = 1_800_000): TranscriptEvent => ({
        type: 'user', uuid, timestamp: iso(ms), isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${taskId}`, content: 'Monitor started' }] },
        toolUseResult: { taskId, timeoutMs, persistent },
      } as TranscriptEvent),
      agentAck: (uuid: string, ms: number, agentId: string): TranscriptEvent => ({
        type: 'user', uuid, timestamp: iso(ms), isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${agentId}`, content: 'Agent started' }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId },
      } as TranscriptEvent),
      bashAck: (uuid: string, ms: number, taskId: string): TranscriptEvent => ({
        type: 'user', uuid, timestamp: iso(ms), isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${taskId}`, content: 'Bash started' }] },
        toolUseResult: { backgroundTaskId: taskId },
      } as TranscriptEvent),
      notice: (uuid: string, ms: number, content: string): TranscriptEvent => ({
        type: 'user', uuid, timestamp: iso(ms), isSidechain: false, promptSource: 'system', turnOrigin: 'task_notification',
        message: { role: 'user', content },
      } as TranscriptEvent),
      attachedNotice: (uuid: string, ms: number, content: string): TranscriptEvent => ({
        type: 'attachment', uuid, timestamp: iso(ms), isSidechain: false,
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: content },
      } as unknown as TranscriptEvent),
      thinking: (uuid: string, ms: number, text: string): TranscriptEvent => ({
        type: 'assistant', uuid, timestamp: iso(ms), isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
      } as TranscriptEvent),
      toolUse: (uuid: string, ms: number, id: string, name: string, input: Record<string, unknown>): TranscriptEvent => ({
        type: 'assistant', uuid, timestamp: iso(ms), isSidechain: false,
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
      } as TranscriptEvent),
      toolResult: (uuid: string, ms: number, id: string, content: string): TranscriptEvent => ({
        type: 'user', uuid, timestamp: iso(ms), isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
      } as TranscriptEvent),
      text: (uuid: string, ms: number, text: string, stopReason = 'end_turn'): TranscriptEvent => ({
        type: 'assistant', uuid, timestamp: iso(ms), isSidechain: false,
        message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
      } as TranscriptEvent),
      apiError: (uuid: string, ms: number): TranscriptEvent => ({
        type: 'assistant', uuid, timestamp: iso(ms), isSidechain: false, isApiErrorMessage: true,
        message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: 'API Error: 500 {"type":"error","error":{"type":"api_error"}}' }] },
      } as TranscriptEvent),
      duration: (uuid: string, ms: number): TranscriptEvent => ({
        type: 'system', subtype: 'turn_duration', uuid, timestamp: iso(ms), isSidechain: false,
      } as TranscriptEvent),
    };
  }

  it.each([
    { label: 'zero-prompt (promptInjection: none)', zeroPrompt: true, replyDelivery: 'transcript' as const },
    { label: 'transcript delivery (PR #2877)', zeroPrompt: false, replyDelivery: 'transcript' as const },
  ])('$label: default OFF keeps current behavior; ON mutes non-terminal Monitor mid-stream wakes while preserving first-turn final, CoT progress, and terminal/expiry/subagent/persistent replies', ({ zeroPrompt, replyDelivery }) => {
    const base = Date.now() + 1_000;
    const ev = makeTurnEvents(base);

    const runScenario = (foldBackgroundUpdates: boolean) => {
      const h = createHarness({ zeroPrompt, replyDelivery, foldBackgroundUpdates });
      h.queue.mark('om_main', queueModule.makeFingerprint('帮我盯 CI'), base, queueModule.normaliseForFingerprint('帮我盯 CI'), 1);

      // 1. Main human turn launches bounded Monitor + subagent + persistent Monitor and ends.
      h.feed([
        ev.user('u-main', 100, '帮我盯 CI'),
        ev.monitorAck('ack-m1', 200, 'm1', false, 1_800_000),
        ev.monitorAck('ack-mp', 210, 'mp', true, 0),
        ev.agentAck('ack-ag', 220, 'ag1'),
        ev.text('a-main', 300, '好的，已挂后台监控'),
        ev.duration('d-main', 400),
      ]);

      // 2. Non-terminal Monitor mid-stream wake (leading thinking + tool + text "继续等待…").
      h.feed([
        ev.notice('n-mid', 10_000, '<task-notification>\n<task-id>m1</task-id>\n<result>job 1/3 running</result>\n</task-notification>'),
        ev.thinking('w1-think', 10_100, 'CI 仍在运行'),
        ev.toolUse('w1-tool', 10_200, 'tu-chk', 'Bash', { command: 'echo check' }),
        ev.toolResult('w1-tr', 10_300, 'tu-chk', 'running'),
        ev.text('w1-text', 10_400, '继续等待…'),
        ev.duration('w1-dur', 10_500),
      ]);

      // 3. Persistent alert Monitor wake (no <status>, persistent:true -> MUST deliver).
      h.feed([
        ev.notice('n-alert', 20_000, '<task-notification>\n<task-id>mp</task-id>\n<result>CRITICAL: 5xx spike</result>\n</task-notification>'),
        ev.text('w2-text', 20_200, '告警：线上出现 5xx 抖动'),
        ev.duration('w2-dur', 20_300),
      ]);

      // 4. Subagent completion (<status>completed</status> -> MUST deliver).
      h.feed([
        ev.notice('n-ag', 30_000, '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n<summary>subagent done</summary>\n</task-notification>'),
        ev.text('w3-text', 30_200, '子任务分析已完成'),
        ev.duration('w3-dur', 30_300),
      ]);

      // 5. Monitor 30m expiry ([Monitor expired...] without <status> -> MUST deliver).
      h.feed([
        ev.notice('n-exp', 40_000, '<task-notification>\n<task-id>m1</task-id>\n<result>[Monitor expired after 30m]</result>\n</task-notification>'),
        ev.text('w4-text', 40_200, '监控 30 分钟已到期，当前状态汇总'),
        ev.duration('w4-dur', 40_300),
      ]);

      // 6. Real human terminal local-* turn (with userUuid -> MUST deliver in zero-prompt).
      h.feed([
        ev.user('u-term', 50_000, '终端里手动问一句'),
        ev.text('a-term', 50_200, '终端手动回复'),
        ev.duration('d-term', 50_300),
      ]);

      return h;
    };

    const off = runScenario(false);
    // Switch OFF: mid-stream "继续等待…" is delivered as before (zero breakchange).
    expect(off.finals().map(f => f.content)).toContain('继续等待…');
    expect(off.terminals.some(t => t.turnId === 'local-headless-w1-text')).toBe(true);

    const on = runScenario(true);
    const contents = on.finals().map(f => String(f.content));
    // First-turn final preserved
    expect(contents).toContain('好的，已挂后台监控');
    // Mid-stream Monitor wake suppressed!
    expect(contents).not.toContain('继续等待…');
    // No turn_terminal or orphan terminal_turn_started emitted for the suppressed micro-turn
    expect(on.terminals.some(t => t.turnId === 'local-headless-w1-text')).toBe(false);
    expect(on.terminalStarts().some(s => s.turnId === 'local-headless-w1-text')).toBe(false);
    // Persistent alert Monitor, subagent completion, and Monitor 30m expiry ALL delivered!
    expect(contents).toContain('告警：线上出现 5xx 抖动');
    expect(contents).toContain('子任务分析已完成');
    expect(contents).toContain('监控 30 分钟已到期，当前状态汇总');
    if (zeroPrompt) expect(contents).toContain('终端手动回复');

    // Progress of the suppressed micro-turn streamed into om_main's CoT fold with exact dispatchAttempt: 1!
    const mainCotUpdates = on.thinkings().filter(m => m.turnId === 'om_main' && m.dispatchAttempt === 1);
    const lastCotEntries = (mainCotUpdates.at(-1)?.entries ?? []) as Array<{ kind: string; text?: string; name?: string }>;
    expect(lastCotEntries.some(e => e.kind === 'thinking' && e.text === 'CI 仍在运行')).toBe(true);
    expect(lastCotEntries.some(e => e.kind === 'tool_call' && e.name === 'Bash')).toBe(true);
    expect(lastCotEntries.some(e => e.kind === 'tool_result')).toBe(true);
    expect(lastCotEntries.some(e => e.kind === 'text' && e.text === '继续等待…')).toBe(true);
  });

  it('must never suppress adoptMode, apiOnly, CronCreate scheduled turns, Monitor terminal <status>, live API failures, or interleaved newer Lark CoT', () => {
    const base = Date.now() + 1_000;
    const ev = makeTurnEvents(base);

    // 1. adoptMode & apiOnly both bypass suppression even with foldBackgroundUpdates: true.
    for (const flag of [{ adoptMode: true }, { apiOnly: true }] as const) {
      const h = createHarness({ replyDelivery: 'transcript', foldBackgroundUpdates: true, ...flag });
      h.queue.mark('om_1', 'watch', base, 'watch', 1);
      h.feed([
        ev.user('u1', 100, 'watch'),
        ev.monitorAck('ack-m1', 200, 'm1', false),
        ev.text('a1', 300, 'started'),
        ev.duration('d1', 400),
        ev.notice('n1', 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
        ev.text('w1', 5_200, 'tick reply'),
        ev.duration('dw1', 5_300),
      ]);
      expect(h.finals().map(f => f.content)).toContain('tick reply');
    }

    // 2. Live API error on a non-terminal Monitor wake MUST still surface user_notify (with JIT terminal_turn_started in zero-prompt).
    const hErr = createHarness({ zeroPrompt: true, replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hErr.queue.mark('om_1', 'watch', base, 'watch', 1);
    hErr.feed([
      ev.user('u1', 100, 'watch'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'started'),
      ev.duration('d1', 400),
      ev.notice('n1', 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      ev.text('w1', 5_100, 'partial'),
      ev.apiError('w1-err', 5_200),
      ev.duration('dw1', 5_300),
    ]);
    expect(hErr.finals().some(f => f.turnId === 'local-headless-w1')).toBe(false);
    expect(hErr.userNotifies()).toHaveLength(1);
    expect(hErr.terminalStarts().some(s => s.turnId === 'local-headless-w1')).toBe(true);

    // 3. CronCreate scheduled turn & Monitor terminal <status>completed</status> both deliver.
    const hCron = createHarness({ replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hCron.queue.mark('om_1', 'schedule', base, 'schedule', 1);
    hCron.feed([
      ev.user('u1', 100, 'schedule'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'ok'),
      ev.duration('d1', 400),
      {
        type: 'user', uuid: 'cron-fire', timestamp: new Date(base + 5_000).toISOString(),
        isSidechain: false, isMeta: true, turnOrigin: 'scheduled', scheduledTaskId: 'job1', scheduledFireId: 'fire1',
        message: { role: 'user', content: 'run scheduled check' },
      } as TranscriptEvent,
      ev.text('a-cron', 5_200, '定时巡检完成'),
      ev.duration('d-cron', 5_300),
      ev.notice('n-done', 6_000, '<task-notification>\n<task-id>m1</task-id>\n<status>completed</status>\n</task-notification>'),
      ev.text('a-done', 6_200, '监控任务已完成'),
      ev.duration('d-done', 6_300),
    ]);
    expect(hCron.finals().map(f => f.content)).toContain('定时巡检完成');
    expect(hCron.finals().map(f => f.content)).toContain('监控任务已完成');

    // 4. Interleaved newer Lark turn om_2: late Monitor wake anchored to om_1 must NOT wipe om_2's thinkingEntries.
    const hInter = createHarness({ replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hInter.queue.mark('om_1', 'first task', base, 'first task', 1);
    hInter.feed([
      ev.user('u1', 100, 'first task'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'first started'),
      ev.duration('d1', 400),
    ]);
    hInter.queue.mark('om_2', 'second task', base + 1_000, 'second task', 1);
    hInter.feed([
      ev.user('u2', 1_100, 'second task'),
      ev.thinking('t2', 1_200, 'working on second task'),
      ev.text('a2', 1_300, 'second done'),
      ev.duration('d2', 1_400),
    ]);
    hInter.feed([
      ev.notice('n-late', 10_000, '<task-notification>\n<task-id>m1</task-id>\n<result>late tick</result>\n</task-notification>'),
      ev.thinking('w-late-think', 10_100, 'late monitor thought'),
      ev.text('w-late-text', 10_200, '继续等待…'),
      ev.duration('w-late-dur', 10_300),
    ]);
    expect(hInter.finals().map(f => f.content)).not.toContain('继续等待…');
    expect(hInter.scope.thinkingTurnKey).toBe('om_2|1');
    expect((hInter.scope.thinkingEntries as Array<{ text?: string }>).some(e => e.text === 'working on second task')).toBe(true);
    expect((hInter.scope.thinkingEntries as Array<{ text?: string }>).some(e => e.text === 'late monitor thought')).toBe(false);
  });

  it('supports live toggle OFF mid-turn (JIT terminal_turn_started + anchor CoT flush), absorbed terminal notice mid-turn, text-less Monitor wake CoT flush, and backgroundCotHold payload', () => {
    const base = Date.now() + 1_000;
    const ev = makeTurnEvents(base);

    // 1. Mid-turn live toggle OFF in zero-prompt mode -> JIT sends terminal_turn_started BEFORE final_output!
    const h = createHarness({ zeroPrompt: true, replyDelivery: 'transcript', foldBackgroundUpdates: true });
    h.queue.mark('om_main', 'watch', base, 'watch', 1);
    h.feed([
      ev.user('u1', 100, 'watch'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'watching'),
      ev.duration('d1', 400),
    ]);
    // Mid-turn: Monitor notice + text arrived, turn NOT closed yet -> terminal_turn_started was deferred.
    h.feed([
      ev.notice('n1', 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      ev.text('w1', 5_100, '继续等待…', 'tool_use'),
    ], false);
    expect(h.terminalStarts().some(s => s.turnId === 'local-headless-w1')).toBe(false);
    // While mid-turn with switch ON, backgroundCotHold is true!
    expect((h.scope.backgroundWaitPayload as () => Record<string, unknown>)()).toEqual({ cotHoldForBackground: true });

    // User flips switch OFF mid-turn!
    (h.scope.setFoldBackgroundUpdatesLive as (v: boolean) => void)(false);
    expect((h.scope.backgroundWaitPayload as () => Record<string, unknown>)()).toEqual({});

    // Micro-turn finishes -> MUST emit terminal_turn_started BEFORE final_output, and emit turn_terminal.
    h.feed([ev.duration('dw1', 5_200)]);
    const startIdx = h.sent.findIndex(m => m.type === 'terminal_turn_started' && m.turnId === 'local-headless-w1');
    const finalIdx = h.sent.findIndex(m => m.type === 'final_output' && m.turnId === 'local-headless-w1');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeGreaterThan(startIdx);
    expect(h.terminals.some(t => t.turnId === 'local-headless-w1')).toBe(true);

    // Fresh init resets live override back to init baseline (true).
    (h.scope.resetFoldBackgroundUpdatesStateForInit as () => void)();
    expect(h.scope.foldBackgroundUpdatesLive).toBeUndefined();

    // 2. Mid-turn absorption of terminal subagent notice flips deferred wake to deliverable with JIT terminal_turn_started.
    const hAbsorb = createHarness({ zeroPrompt: true, replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hAbsorb.queue.mark('om_main', 'watch', base, 'watch', 1);
    hAbsorb.feed([
      ev.user('u1', 100, 'watch'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.agentAck('ack-ag', 210, 'ag1'),
      ev.text('a1', 300, 'watching'),
      ev.duration('d1', 400),
    ]);
    hAbsorb.feed([
      ev.notice('n1', 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      ev.text('w1', 5_100, 'checking', 'tool_use'),
    ], false);
    expect(hAbsorb.terminalStarts().some(s => s.turnId === 'local-headless-w1')).toBe(false);
    hAbsorb.feed([
      ev.attachedNotice('att-ag', 5_200, '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>'),
      ev.text('w2', 5_300, '子任务跑完了'),
      ev.duration('dw', 5_400),
    ]);
    const absorbStartIdx = hAbsorb.sent.findIndex(m => m.type === 'terminal_turn_started' && m.turnId === 'local-headless-w1');
    const absorbFinalIdx = hAbsorb.sent.findIndex(m => m.type === 'final_output' && m.turnId === 'local-headless-w1');
    expect(absorbStartIdx).toBeGreaterThanOrEqual(0);
    expect(absorbFinalIdx).toBeGreaterThan(absorbStartIdx);
    expect(String(hAbsorb.finals().at(-1)?.content)).toContain('子任务跑完了');

    // 3. Text-less Monitor micro-turn flushes leading CoT at turn_duration with zero final_output and zero turn_terminal.
    const hTextless = createHarness({ zeroPrompt: true, replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hTextless.queue.mark('om_main', 'watch', base, 'watch', 1);
    hTextless.feed([
      ev.user('u1', 100, 'watch'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'watching'),
      ev.duration('d1', 400),
    ]);
    const cotBefore = hTextless.thinkings().length;
    hTextless.feed([
      ev.notice('n1', 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      ev.thinking('w-th', 5_100, '静默巡检，继续等'),
      ev.duration('w-dur', 5_200),
    ]);
    expect(hTextless.finals()).toHaveLength(1);
    expect(hTextless.terminals).toHaveLength(1);
    expect(hTextless.thinkings().length).toBeGreaterThan(cotBefore);
    const flushedEntries = hTextless.thinkings().at(-1)?.entries as Array<{ kind: string; text?: string }>;
    expect(flushedEntries.some(e => e.kind === 'thinking' && e.text === '静默巡检，继续等')).toBe(true);
  });

  it('hardens mid-wake OFF->ON toggle, expiresAtMs mid-turn hold, pre-release CoT flush, human-turn CoT hold isolation, sibling scan window continuity, and daemonCotHoldMayBeActive', () => {
    const base = Date.now() + 1_000;
    const ev = makeTurnEvents(base);

    // 1. L1-6: OFF->ON mid-wake after terminal_turn_started was already sent fails open (no orphan turnReplyContexts).
    const hOffToOn = createHarness({ zeroPrompt: true, replyDelivery: 'transcript', foldBackgroundUpdates: false });
    hOffToOn.queue.mark('om_main', 'watch', base, 'watch', 1);
    hOffToOn.feed([
      ev.user('u1', 100, 'watch'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'watching'),
      ev.duration('d1', 400),
    ]);
    hOffToOn.feed([
      ev.notice('n1', 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick 1</result>\n</task-notification>'),
      ev.text('w1', 5_100, 'in-flight tick 1', 'tool_use'),
    ], false);
    expect(hOffToOn.terminalStarts().some(s => s.turnId === 'local-headless-w1')).toBe(true);
    // Toggle ON mid-wake #1: wake #1 finishes deliverable; wake #2 starts AFTER toggle ON and IS suppressed.
    (hOffToOn.scope.setFoldBackgroundUpdatesLive as (v: boolean) => void)(true);
    hOffToOn.feed([ev.duration('dw1', 5_200)]);
    expect(hOffToOn.finals().map(f => f.content)).toContain('in-flight tick 1');
    hOffToOn.feed([
      ev.notice('n2', 6_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick 2</result>\n</task-notification>'),
      ev.text('w2', 6_100, 'suppressed tick 2'),
      ev.duration('dw2', 6_200),
    ]);
    expect(hOffToOn.finals().map(f => f.content)).not.toContain('suppressed tick 2');
    expect(hOffToOn.terminalStarts().some(s => s.turnId === 'local-headless-w2')).toBe(false);

    // 2. L3-4 & L3-5: Monitor crossing expiresAtMs mid-micro-turn keeps backgroundCotHold true until micro-turn finishes,
    // and refreshBackgroundWait flushes buffered thinking_update BEFORE clearing backgroundCotHold.
    const hEdge = createHarness({ zeroPrompt: true, replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hEdge.queue.mark('om_main', 'watch', base, 'watch', 1);
    hEdge.feed([
      ev.user('u1', 100, 'watch'),
      ev.monitorAck('ack-m1', 200, 'm1', false, 10_000),
      ev.text('a1', 300, 'watching'),
      ev.duration('d1', 400),
    ]);
    hEdge.feed([
      ev.notice('n1', 9_999, '<task-notification>\n<task-id>m1</task-id>\n<result>edge tick</result>\n</task-notification>'),
      ev.thinking('w-th', 10_050, 'edge thinking'),
      ev.text('w-tx', 10_100, 'edge waiting', 'tool_use'),
    ], false);
    // Even past expiresAtMs (base + 200 + 10_000), computeBackgroundCotHold stays true while suppressed wake is active!
    const computeHold = loadWorkerFunction<(nowMs?: number) => boolean>('computeBackgroundCotHold', hEdge.scope);
    expect(computeHold(base + 20_000)).toBe(true);
    expect(hEdge.scope.backgroundCotHold).toBe(true);
    // Finish and pop the micro-turn -> once expired and popped, refreshBackgroundWait flushes CoT before clearing hold.
    const thinkingsBeforeClear = hEdge.thinkings().length;
    hEdge.feed([ev.duration('dw', 10_200)]);
    // Force tracker past deadline via TaskStop/settlement, then refreshBackgroundWait flushes before clearing hold.
    hEdge.tracker.settle('m1', base + 20_000);
    hEdge.scope.backgroundCotHold = true;
    (hEdge.scope.refreshBackgroundWait as () => void)();
    expect(hEdge.scope.backgroundCotHold).toBe(false);
    expect(hEdge.thinkings().length).toBeGreaterThan(thinkingsBeforeClear);

    // 3. L1-4 & L3-1 & L3-3: computeBackgroundCotHold returns false while a new human Lark turn is actively collecting;
    // backgroundWaitPayload marks daemonCotHoldMayBeActive; sibling scan continuity preserves backgroundStopScanSinceMs.
    const hHuman = createHarness({ replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hHuman.queue.mark('om_1', 'watch', base, 'watch', 1);
    hHuman.feed([
      ev.user('u1', 100, 'watch'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'watching'),
      ev.duration('d1', 400),
    ]);
    expect((hHuman.scope.backgroundWaitPayload as () => Record<string, unknown>)()).toEqual({ backgroundTasks: 1 });
    expect(hHuman.scope.daemonCotHoldMayBeActive).toBe(true);
    const initialScanSince = hHuman.scope.backgroundStopScanSinceMs as number;
    expect(initialScanSince).toBeGreaterThan(0);

    // New human Lark turn om_2 starts while m1 is still running:
    hHuman.queue.mark('om_2', 'new human question', base + 1_000, 'new human question', 1);
    hHuman.feed([ev.user('u2', 1_100, 'new human question')], false);
    expect(hHuman.scope.backgroundCotHold).toBe(false);
    // Sibling scan floor stayed anchored to original Monitor launch (not jumped forward!).
    expect(hHuman.scope.backgroundStopScanSinceMs).toBe(initialScanSince);
  });

  it('keeps Scenario 3A late-recovery anchored on the originating turn (CoT key, cotHoldForBackground, launched Monitor anchor) and preserves deferredTerminalTurnStarts across Loop 2 rollbacks', () => {
    const base = Date.now() + 1_000;
    const ev = makeTurnEvents(base);

    // 1. Scenario 3A late-recovery (#3810) x folded Monitor updates (#3823):
    const h = createHarness({ replyDelivery: 'transcript', foldBackgroundUpdates: true });
    // Non-durable turn (dispatchAttempt: undefined) can pop at a bounded unobserved idle boundary.
    h.queue.mark('om_1', 'watch late', base, 'watch late');
    // Turn emits interim text (no stop_reason / no turn_duration) and launches bounded Monitor m1.
    h.feed([
      { ...ev.user('u1', 100, 'watch late'), parentUuid: null } as TranscriptEvent,
      { ...ev.monitorAck('ack-m1', 200, 'm1', false), parentUuid: 'u1' } as TranscriptEvent,
      {
        type: 'assistant', uuid: 'a1-interim', parentUuid: 'ack-m1', timestamp: new Date(base + 300).toISOString(),
        isSidechain: false, message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: '正在盯构建' }] },
      } as TranscriptEvent,
    ], false);
    // Pop at bounded unobserved idle boundary -> emits om_1 and records recentUnobservedTurn (Scenario 3A).
    h.emitReadyTurns({ explicitTerminalOnly: false });
    expect(h.finals().map(f => f.turnId)).toEqual(['om_1']);
    expect(h.scope.thinkingTurnKey).toBe('om_1|');

    // Late record re-attaches via Scenario 3A (`late-recovery-a2-late`) and also launches Monitor m2.
    h.feed([
      {
        type: 'assistant', uuid: 'a2-late', parentUuid: 'a1-interim', timestamp: new Date(base + 2_000).toISOString(),
        isSidechain: false, message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: '补充最终结论' }] },
      } as TranscriptEvent,
      { ...ev.monitorAck('ack-m2', 2_100, 'm2', false), parentUuid: 'a2-late' } as TranscriptEvent,
    ], false);
    // Confirm Scenario 3A actually synthesized `late-recovery-a2-late`!
    expect(h.queue.peek().some(t => t.turnId === 'late-recovery-a2-late')).toBe(true);
    // thinkingTurnKey must stay anchored to om_1| (NOT 'late-recovery-a2-late|'),
    // hasActiveNonLocalTurn must stay false (so backgroundCotHold stays true!),
    // and Monitor m2 must anchor to om_1 (NOT synthetic late-recovery-a2-late)!
    expect(h.scope.thinkingTurnKey).toBe('om_1|');
    expect(h.queue.hasActiveNonLocalTurn()).toBe(false);
    expect(h.scope.backgroundCotHold).toBe(true);
    expect(h.queue.backgroundTaskAnchorTurnIds(['m2'])).toEqual(['om_1']);

    // Finish late-recovery, then fire a non-terminal wake from m2 -> CoT still streams into om_1|!
    h.feed([ev.duration('d-late', 2_200)]);
    expect(h.finals().some(f => f.turnId === 'late-recovery-a2-late' && f.replyTurnId === 'om_1')).toBe(true);
    const thinkingsBeforeMon = h.thinkings().length;
    h.feed([
      ev.notice('n-m2', 5_000, '<task-notification>\n<task-id>m2</task-id>\n<result>m2 tick</result>\n</task-notification>'),
      ev.thinking('w-m2-th', 5_100, 'm2 仍在运行'),
      ev.text('w-m2-tx', 5_200, '继续等待 m2'),
      ev.duration('d-m2', 5_300),
    ]);
    expect(h.finals().map(f => f.content)).not.toContain('继续等待 m2');
    expect(h.thinkings().length).toBeGreaterThan(thinkingsBeforeMon);
    const latestCot = h.thinkings().at(-1);
    expect(latestCot).toMatchObject({ turnId: 'om_1' });
    expect((latestCot?.entries as Array<{ text?: string }>).some(e => e.text === 'm2 仍在运行')).toBe(true);

    // 2. Loop 2 rollback preserves deferredTerminalTurnStarts for a suppressed Monitor wake:
    const hRollback = createHarness({ zeroPrompt: true, replyDelivery: 'transcript', foldBackgroundUpdates: true });
    hRollback.scope.emittedTurnTerminals = { release: () => {} };
    let failOnce = true;
    const origEmit = hRollback.scope.emitTurnTerminal as (...args: any[]) => void;
    hRollback.scope.emitTurnTerminal = (turnId: string, ...rest: any[]) => {
      if (failOnce && turnId === 'om_1') {
        failOnce = false;
        throw new Error('transient IPC error');
      }
      return origEmit(turnId, ...rest);
    };
    hRollback.queue.mark('om_1', 'watch rollback', base, 'watch rollback', 1);
    // Ingest om_1 + suppressed Monitor wake together in one batch (without emitting yet).
    hRollback.feed([
      ev.user('u1', 100, 'watch rollback'),
      ev.monitorAck('ack-m1', 200, 'm1', false),
      ev.text('a1', 300, 'started'),
      ev.duration('d1', 400),
      ev.notice('n1', 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      ev.text('w1', 5_100, 'waiting'),
      ev.duration('dw1', 5_200),
    ], false);
    expect(hRollback.terminalStarts()).toHaveLength(0);
    // First emit throws in Loop 2 on om_1 -> restores [om_1, local-headless-w1].
    expect(() => hRollback.emitReadyTurns({ explicitTerminalOnly: true })).toThrow('transient IPC error');
    // Operator toggles foldBackgroundUpdates OFF before retry -> JIT terminal_turn_started MUST still fire before final_output!
    (hRollback.scope.setFoldBackgroundUpdatesLive as (v: boolean) => void)(false);
    hRollback.emitReadyTurns({ explicitTerminalOnly: true });
    const startIdx = hRollback.sent.findIndex(m => m.type === 'terminal_turn_started' && m.turnId === 'local-headless-w1');
    const finalIdx = hRollback.sent.findIndex(m => m.type === 'final_output' && m.turnId === 'local-headless-w1');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeGreaterThan(startIdx);
  });
});
