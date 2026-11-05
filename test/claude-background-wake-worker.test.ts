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
const dir = mkdtempSync(join(tmpdir(), 'bmx-bgwake-worker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Fixture re-stamped as live (written after the queue and worker started). */
function liveFixture(): { events: TranscriptEvent[]; path: string } {
  const events = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TranscriptEvent);
  const shift = Date.now() + 1_000 - Date.parse(events[0].timestamp!);
  const live = events.map(ev => ({ ...ev, timestamp: new Date(Date.parse(ev.timestamp!) + shift).toISOString() }));
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, live.map(ev => JSON.stringify(ev)).join('\n') + '\n');
  return { events: live, path };
}

function run(replyDelivery: 'send' | 'transcript') {
  const sent: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const queue = new queueModule.BridgeTurnQueue();
  const { events, path } = liveFixture();
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
  queue.ingest(events, path);
  emitReadyTurns({ explicitTerminalOnly: true, releaseHeldTerminals: true });
  const finals = sent.filter(msg => msg.type === 'final_output')
    .map(msg => ({ turnId: msg.turnId, replyTurnId: msg.replyTurnId, content: msg.content }));
  return { finals, logs };
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
});
