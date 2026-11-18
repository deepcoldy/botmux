import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAntigravityAdapter } from '../src/adapters/cli/antigravity.js';
import {
  drainAntigravityForRestartScan,
  evaluateAntigravityProvisionalFinalVerdict,
  isAntigravityExecutionIdleAtOrAfterStep,
  readAntigravityExecutionSnapshot,
} from '../src/services/antigravity-execution-state.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';
import { structuredTurnOpen } from '../src/services/restart-interruption.js';
import {
  conversationIdFromAntigravityTranscriptPath,
  drainAntigravityTranscript,
  readLatestAntigravityTranscriptStepIndex,
} from '../src/services/antigravity-transcript.js';
import {
  enableWorkerScratchIsolation,
  registerScratchView,
  resetWorkerScratchIsolationForTests,
} from '../src/services/scratch-host-view.js';
import { writeAntigravityExecutionDbFixture } from './helpers/antigravity-execution-db-fixture.js';

const roots = new Set<string>();

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bmx-agy-exec-state-'));
  roots.add(dir);
  return dir;
}

afterEach(() => {
  resetWorkerScratchIsolationForTests();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.clear();
});

describe('antigravity execution state & non-screen zmx turn verdicts', () => {
  const cid = '11111111-2222-3333-4444-555555555555';

  it('tracks provisionalFinalStepIndex through drainAntigravityTranscript and clears it on flush', () => {
    const root = makeTempRoot();
    const transcriptPath = join(root, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    mkdirSync(join(transcriptPath, '..'), { recursive: true });
    writeFileSync(transcriptPath, [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-17T00:00:00Z', content: '<USER_REQUEST>\nping\n</USER_REQUEST>' },
      { step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: '2026-11-17T00:00:01Z', content: 'candidate answer' },
    ].map(r => JSON.stringify(r) + '\n').join(''));

    expect(conversationIdFromAntigravityTranscriptPath(transcriptPath)).toBe(cid);
    expect(readLatestAntigravityTranscriptStepIndex(transcriptPath)).toBe(3);

    const first = drainAntigravityTranscript(transcriptPath, 0);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.kind).toBe('user');
    expect(first.state.provisionalFinal?.text).toBe('candidate answer');
    expect(first.state.provisionalFinalStepIndex).toBe(3);

    const flushed = drainAntigravityTranscript(transcriptPath, first.newOffset, first.state, { flushTrailingFinal: true });
    expect(flushed.events).toHaveLength(1);
    expect(flushed.events[0]).toMatchObject({ kind: 'assistant_final', text: 'candidate answer' });
    expect(flushed.state.provisionalFinal).toBeUndefined();
    expect(flushed.state.provisionalFinalStepIndex).toBeUndefined();
  });

  it('confirms a candidate only when executor_metadata and conversation_summaries prove terminal idle at/after candidate step', () => {
    const root = makeTempRoot();
    const geminiCliDir = join(root, '.gemini', 'antigravity-cli');

    // Missing DBs → fail closed ('hold')
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 1, { geminiCliDir })).toBe('hold');

    // Stop-hook mid-flight: step 1 written in steps, no executor_metadata row yet, status RUNNING
    writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 1,
      execMetadataRows: [],
      summary: { stepCount: 2, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true },
    });
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 1, { geminiCliDir })).toBe('hold');

    // Background task / subagent still active (`not_fully_idle = 1` or `backgroundTaskCount > 0`) → hold
    writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 3,
      execMetadataRows: [{ idx: 0, terminationReason: 4, lastStepIdx: 3 }],
      summary: { stepCount: 4, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, backgroundTaskCount: 1 },
    });
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 3, { geminiCliDir })).toBe('hold');

    // Lagging conversation_summaries (`step_count` behind `maxStepIdx + 1`) → hold
    writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 5,
      execMetadataRows: [{ idx: 0, terminationReason: 4, lastStepIdx: 5 }],
      summary: { stepCount: 4, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false },
    });
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 5, { geminiCliDir })).toBe('hold');

    // Non-terminal continuation reasons (EARLY_CONTINUE=7, CHAINED=12, auto-continue) → hold
    for (const nonTerminal of [
      { terminationReason: 7, proceededWithAutoContinue: false },
      { terminationReason: 12, proceededWithAutoContinue: false },
      { terminationReason: 4, proceededWithAutoContinue: true },
    ]) {
      writeAntigravityExecutionDbFixture({
        geminiCliDir,
        conversationId: cid,
        maxStepIdx: 5,
        execMetadataRows: [{ idx: 0, lastStepIdx: 5, ...nonTerminal }],
        summary: { stepCount: 6, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false },
      });
      expect(evaluateAntigravityProvisionalFinalVerdict(cid, 5, { geminiCliDir })).toBe('hold');
    }

    // Completed turn (`NO_TOOL_CALL = 4`, caught-up idle summary) → confirm!
    writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 5,
      execMetadataRows: [{ idx: 0, terminationReason: 4, lastStepIdx: 5 }],
      summary: { stepCount: 6, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, latestTerminationReason: 4 },
    });
    expect(readAntigravityExecutionSnapshot(cid, { geminiCliDir })?.authoritativelyIdle).toBe(true);
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 5, { geminiCliDir })).toBe('confirm');
    // Newer candidate step beyond DB's lastStepIdx → hold
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 6, { geminiCliDir })).toBe('hold');
  });

  it('discards aborted interim candidates (USER_CANCELED / ERROR) and settles isSessionBusy without consulting screen', () => {
    const root = makeTempRoot();
    const isolatedHome = join(root, 'isolated-home');
    const geminiCliDir = join(isolatedHome, '.gemini', 'antigravity-cli');
    const logsDir = join(geminiCliDir, 'brain', cid, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    // Bind isolated view via scratch registry so createAntigravityAdapter reads isolatedHome without touching real $HOME
    enableWorkerScratchIsolation('sess-cancel', join(root, 'data'));
    registerScratchView('sess-cancel', [{ from: '/', to: isolatedHome }]);
    // Mirror canonical host $HOME path inside isolatedHome for full-root mapping
    const canonHome = realpathSync(homedir());
    const inOverlayGeminiDir = join(isolatedHome, canonHome, '.gemini', 'antigravity-cli');
    const inOverlayLogsDir = join(inOverlayGeminiDir, 'brain', cid, '.system_generated', 'logs');
    mkdirSync(inOverlayLogsDir, { recursive: true });

    // Dangling transcript ending at PLANNER_RESPONSE with tool_calls (step_index: 7)
    writeFileSync(join(inOverlayLogsDir, 'transcript_full.jsonl'), [
      { step_index: 6, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: '<USER_REQUEST>\nsleep 10\n</USER_REQUEST>' },
      { step_index: 7, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '', tool_calls: [{ id: 'tc1', name: 'run_command' }] },
    ].map(r => JSON.stringify(r) + '\n').join(''));

    const adapter = createAntigravityAdapter('/bin/agy');
    // Without SQLite execution state and without getCurrentScreen (zmx), stays conservative (busy = true)
    expect(adapter.isSessionBusy!({ sessionId: 'sess-cancel', cliSessionId: cid, isCliProcessAlive: () => true })).toBe(true);

    // Record USER_CANCELED (2) at step 8 (canceled tool step in DB) and IDLE summary
    writeAntigravityExecutionDbFixture({
      geminiCliDir: inOverlayGeminiDir,
      conversationId: cid,
      maxStepIdx: 8,
      execMetadataRows: [{ idx: 0, terminationReason: 2, lastStepIdx: 8 }],
      summary: { stepCount: 9, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, latestTerminationReason: 2 },
    });

    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 7, { geminiCliDir: inOverlayGeminiDir })).toBe('discard_aborted');
    expect(isAntigravityExecutionIdleAtOrAfterStep(cid, 7, { geminiCliDir: inOverlayGeminiDir })).toBe(true);
    // Now isSessionBusy with getCurrentScreen: undefined returns false!
    expect(adapter.isSessionBusy!({ sessionId: 'sess-cancel', cliSessionId: cid, isCliProcessAlive: () => true })).toBe(false);
  });

  it('reconciles cold-resume restart scans so completed and USER_CANCELED turns stay closed while in-flight hooks/tools stay open', () => {
    const root = makeTempRoot();
    const geminiCliDir = join(root, '.gemini', 'antigravity-cli');
    const transcriptPath = join(geminiCliDir, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    mkdirSync(join(transcriptPath, '..'), { recursive: true });
    const beforeMs = Date.parse('2026-11-17T01:00:00Z');

    // 1. Completed turn: trailing PLANNER_RESPONSE(no tool_calls) + SQLite confirm → turnOpen = false
    writeFileSync(transcriptPath, [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-17T00:00:10Z', content: '<USER_REQUEST>\nhello\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: '2026-11-17T00:00:12Z', content: 'done' },
    ].map(r => JSON.stringify(r) + '\n').join(''));
    writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 1,
      execMetadataRows: [{ idx: 0, terminationReason: 4, lastStepIdx: 1 }],
      summary: { stepCount: 2, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false },
    });
    expect(structuredTurnOpen(drainAntigravityForRestartScan(transcriptPath, 0, { geminiCliDir, beforeMs }).events, beforeMs)).toBe(false);

    // 2. Process died while Stop hook / background task kept CASCADE_RUN_STATUS_RUNNING → turnOpen = true
    writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 1,
      execMetadataRows: [],
      summary: { stepCount: 2, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true },
    });
    expect(structuredTurnOpen(drainAntigravityForRestartScan(transcriptPath, 0, { geminiCliDir, beforeMs }).events, beforeMs)).toBe(true);

    // 3. Process crashed mid-tool-call without USER_CANCELED → turnOpen = true
    writeFileSync(transcriptPath, [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-17T00:00:10Z', content: '<USER_REQUEST>\nrun tool\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: '2026-11-17T00:00:12Z', content: '', tool_calls: [{ id: 'c1', name: 'run_command' }] },
    ].map(r => JSON.stringify(r) + '\n').join(''));
    expect(structuredTurnOpen(drainAntigravityForRestartScan(transcriptPath, 0, { geminiCliDir, beforeMs }).events, beforeMs)).toBe(true);

    // 4. User canceled mid-tool-call before suspend (`USER_CANCELED = 2` at step 2) → turnOpen = false
    writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 2,
      execMetadataRows: [{ idx: 0, terminationReason: 2, lastStepIdx: 2 }],
      summary: { stepCount: 3, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false },
    });
    expect(structuredTurnOpen(drainAntigravityForRestartScan(transcriptPath, 0, { geminiCliDir, beforeMs }).events, beforeMs)).toBe(false);
  });

  it('handles 64-bit/negative protobuf varints, multi-execution per-step verdicts, and transcript-lagged completions', () => {
    const root = makeTempRoot();
    const geminiCliDir = join(root, '.gemini', 'antigravity-cli');
    const transcriptPath = join(geminiCliDir, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    mkdirSync(join(transcriptPath, '..'), { recursive: true });

    const encodeBigVarint = (v: bigint): number[] => {
      const out: number[] = [];
      let n = BigInt.asUintN(64, v);
      while (n >= 0x80n) {
        out.push(Number(n & 0x7fn) | 0x80);
        n >>= 7n;
      }
      out.push(Number(n));
      return out;
    };

    // 1. Multi-execution SQLite rows (`idx=0 USER_CANCELED at step 2`, `idx=1 NO_TOOL_CALL at step 4`)
    //    + 64-bit UnixNano varint in `raw_summary` + 10-byte negative varint (-1) in `executor_metadata`
    let fakeNow = 1_700_000_000_000;
    const queue = new CodexBridgeQueue(() => fakeNow);
    queue.mark('om_turn_1', 'CANCEL_ME', fakeNow);
    fakeNow += 100;
    writeFileSync(transcriptPath, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date(fakeNow).toISOString(), content: '<USER_REQUEST>\nCANCEL_ME\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(fakeNow + 10).toISOString(), content: 'ABORTED_INTERIM_TEXT_MUST_NOT_LEAK' },
    ].map(r => JSON.stringify(r) + '\n').join(''));
    const d1 = drainAntigravityTranscript(transcriptPath, 0, {});
    queue.ingest(d1.events);

    fakeNow += 200;
    queue.mark('om_turn_2', 'FOLLOW_UP_TURN', fakeNow);
    writeFileSync(transcriptPath, [
      { step_index: 3, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date(fakeNow + 20).toISOString(), content: '<USER_REQUEST>\nFOLLOW_UP_TURN\n</USER_REQUEST>' },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(fakeNow + 50).toISOString(), content: 'VALID_TURN_2_FINAL' },
    ].map(r => JSON.stringify(r) + '\n').join(''), { flag: 'a' });

    const { convDbPath, summariesDbPath } = writeAntigravityExecutionDbFixture({
      geminiCliDir,
      conversationId: cid,
      maxStepIdx: 4,
      execMetadataRows: [
        { idx: 0, terminationReason: 2, lastStepIdx: 2 },
        { idx: 1, terminationReason: 4, lastStepIdx: 4 },
      ],
      summary: { stepCount: 5, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, latestTerminationReason: 4 },
    });

    // Inject unknown uint64 UnixNano field (field 10) into raw_summary and negative int32 (-1, field 99) into idx=1
    const sumDb = openDatabaseSyncNow(summariesDbPath)!;
    sumDb.prepare('UPDATE conversation_summaries SET raw_summary = ? WHERE conversation_id = ?').run(
      Buffer.from([...encodeBigVarint((10n << 3n) | 0n), ...encodeBigVarint(1_794_916_000_000_000_000n), ...encodeBigVarint((28n << 3n) | 0n), 4]),
      cid,
    );
    sumDb.close();
    const convDb = openDatabaseSyncNow(convDbPath)!;
    convDb.prepare('UPDATE executor_metadata SET data = ? WHERE idx = 1').run(
      Buffer.from([
        ...encodeBigVarint((1n << 3n) | 0n), 4,
        ...encodeBigVarint((3n << 3n) | 0n), 4,
        ...encodeBigVarint((99n << 3n) | 0n), ...encodeBigVarint(-1n),
      ]),
    );
    convDb.close();

    // Per-step verdict still identifies step 1 as 'discard_aborted' and step 4 as 'confirm'!
    expect(readAntigravityExecutionSnapshot(cid, { geminiCliDir })?.authoritativelyIdle).toBe(true);
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 1, { geminiCliDir })).toBe('discard_aborted');
    expect(evaluateAntigravityProvisionalFinalVerdict(cid, 4, { geminiCliDir })).toBe('confirm');

    // Draining Turn 2's USER_INPUT + final emits turn_aborted for Turn 1 (never ABORTED_INTERIM_TEXT_MUST_NOT_LEAK!)
    const d2 = drainAntigravityTranscript(transcriptPath, d1.newOffset, d1.state, { flushTrailingFinal: true });
    queue.ingest(d2.events);
    const emittable = queue.drainEmittable();
    expect(emittable).toHaveLength(2);
    expect(emittable[0]).toMatchObject({ turnId: 'om_turn_1', finalText: '', terminalStatus: 'ambiguous' });
    expect(emittable[1]).toMatchObject({ turnId: 'om_turn_2', finalText: 'VALID_TURN_2_FINAL' });

    // 2. Transcript lagging behind a completed SQLite step (`minStepIndex: 3 < lastStepIdx: 4`) stays NOT idle!
    expect(isAntigravityExecutionIdleAtOrAfterStep(cid, 3, { geminiCliDir })).toBe(false);
    expect(isAntigravityExecutionIdleAtOrAfterStep(cid, 4, { geminiCliDir })).toBe(true);

    // 3. A 0-byte `<cid>.db` fd placeholder (e.g. native `/fork` before SQLite writes) does NOT
    //    discard a completed turn on the next `USER_INPUT` or mark restart scan as `turnOpen: true`.
    const placeholderCid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    mkdirSync(join(geminiCliDir, 'conversations'), { recursive: true });
    writeFileSync(join(geminiCliDir, 'conversations', `${placeholderCid}.db`), '');
    const placeholderTranscript = join(geminiCliDir, 'brain', placeholderCid, '.system_generated', 'logs', 'transcript_full.jsonl');
    mkdirSync(join(placeholderTranscript, '..'), { recursive: true });
    writeFileSync(placeholderTranscript, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date(fakeNow).toISOString(), content: '<USER_REQUEST>\nCHILD_FIRST\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(fakeNow + 10).toISOString(), content: 'CHILD_REPLY_1' },
      { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date(fakeNow + 20).toISOString(), content: '<USER_REQUEST>\nCHILD_QUEUED\n</USER_REQUEST>' },
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(fakeNow + 30).toISOString(), content: 'CHILD_REPLY_2' },
    ].map(r => JSON.stringify(r) + '\n').join(''));
    const forkDrain = drainAntigravityTranscript(placeholderTranscript, 0, {}, { flushTrailingFinal: true });
    expect(forkDrain.events.filter(e => e.kind === 'assistant_final').map(e => e.text)).toEqual(['CHILD_REPLY_1', 'CHILD_REPLY_2']);
    rmSync(join(geminiCliDir, 'conversation_summaries.db'), { force: true });
    expect(structuredTurnOpen(drainAntigravityForRestartScan(placeholderTranscript, 0, { geminiCliDir, beforeMs: fakeNow + 100 }).events, fakeNow + 100)).toBe(false);
  });
});
