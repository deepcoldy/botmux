import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CandidateTurnDurability,
  candidateTurnOutputUuid,
  type CandidateTurnDispatch,
} from '../src/services/candidate-turn-durability.js';
import {
  acceptCandidateTurnFromDaemon,
  settleCandidateTurnFromWorker,
  submitCandidateTurnFromWorker,
} from '../src/core/candidate-turn-entry.js';
import * as candidateTurnEntry from '../src/core/candidate-turn-entry.js';
import {
  candidateCocoTranscriptEvidence,
  reconcileCandidateCocoTranscript,
  reconcileCandidateRuntimeTranscript,
} from '../src/services/candidate-turn-transcript.js';
import { deliverCandidateTurnReceiptHistory } from '../src/services/rca-shadow-mirror.js';
import { CandidateTurnReceiptDeliveryError } from '../src/services/rca-shadow-mirror.js';
import { CandidateTurnReceiptReporter } from '../src/services/candidate-turn-reporter.js';
import { __testOnly_setupWorkerHandlers, initWorkerPool } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { registerBot } from '../src/bot-registry.js';

const BOTMUX_COMMIT = 'b'.repeat(40);
const BOTMUX_ARTIFACT_SHA256 = '6'.repeat(64);

function input(turnId: string, prompt = `prompt:${turnId}`) {
  return {
    incidentKey: 'argos:alarm-42',
    candidateDispatchId: 'cand_alarm_42',
    releaseId: 'release-a',
    releaseManifestSha256: '1'.repeat(64),
    runtimeBundleId: 'runtime-a',
    larkAppId: 'cli_candidate',
    chatId: 'oc_shadow',
    rootMessageId: 'om_candidate_root',
    botmuxSessionId: 'botmux-session-1',
    botmuxCommit: BOTMUX_COMMIT,
    botmuxArtifactSha256: BOTMUX_ARTIFACT_SHA256,
    turnId,
    prompt,
    acceptedAt: '2026-08-13T00:00:00.000Z',
  };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-candidate-turn-'));
  return { dataDir, turns: new CandidateTurnDurability({ dataDir }) };
}

describe('Candidate durable continuation', () => {
  it('serializes busy inbound turns and each receipt follows accepted → submitted → completed', async () => {
    const { dataDir, turns } = fixture();
    const dispatched: CandidateTurnDispatch[] = [];
    for (const turnId of ['om_turn_1', 'om_turn_2', 'om_turn_3']) {
      await acceptCandidateTurnFromDaemon(input(turnId), {
        dataDir, receiverBootId: 'boot-a', workerGeneration: 4,
        dispatch(turn) { dispatched.push(turn); },
      });
    }
    expect(dispatched.map(item => item.turnId)).toEqual(['om_turn_1']);

    await submitCandidateTurnFromWorker({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_turn_1',
      dispatchAttempt: 1, workerGeneration: 4,
      evidence: { kind: 'cli_transcript', nativeSessionId: 'coco-a', transcriptRef: 'events:10' },
    }, {
      dataDir, receiverBootId: 'boot-a', workerGeneration: 4,
      dispatch(turn) { dispatched.push(turn); },
    });
    await settleCandidateTurnFromWorker({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_turn_1',
      dispatchAttempt: 1, workerGeneration: 4, status: 'completed',
      evidence: {
        kind: 'cli_transcript_terminal', nativeSessionId: 'coco-a', transcriptRef: 'events:20',
        output: 'turn one conclusion',
      },
    }, {
      dataDir, receiverBootId: 'boot-a', workerGeneration: 4,
      dispatch(turn) { dispatched.push(turn); },
    });
    expect(dispatched.map(item => item.turnId)).toEqual(['om_turn_1', 'om_turn_2']);
    expect(turns.get('cand_alarm_42', 'om_turn_1')?.transitions.map(t => t.status))
      .toEqual(['accepted', 'submitted', 'completed']);
  });

  it('hands a failed busy-successor dispatch to exact-attempt recovery', async () => {
    const { dataDir, turns } = fixture();
    const dispatched: Array<{ turnId: string; dispatchAttempt: number }> = [];
    const ambiguous: Array<{ turnId: string; dispatchAttempt: number; error: string }> = [];
    const deps = {
      dataDir,
      receiverBootId: 'boot-a',
      workerGeneration: 4,
      dispatch(turn: CandidateTurnDispatch) {
        dispatched.push({ turnId: turn.turnId, dispatchAttempt: turn.dispatchAttempt });
        if (turn.turnId === 'om_turn_2') throw new Error('worker died during successor IPC');
      },
      onAmbiguousDispatch(receipt: { turnId: string; dispatchAttempt: number }, error: unknown) {
        ambiguous.push({
          turnId: receipt.turnId,
          dispatchAttempt: receipt.dispatchAttempt,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    };

    await acceptCandidateTurnFromDaemon(input('om_turn_1'), deps);
    await acceptCandidateTurnFromDaemon(input('om_turn_2'), deps);
    await submitCandidateTurnFromWorker({
      candidateDispatchId: 'cand_alarm_42',
      turnId: 'om_turn_1',
      dispatchAttempt: 1,
      workerGeneration: 4,
      evidence: { kind: 'cli_transcript', nativeSessionId: 'coco-a', transcriptRef: 'events:10' },
    }, deps);

    await expect(settleCandidateTurnFromWorker({
      candidateDispatchId: 'cand_alarm_42',
      turnId: 'om_turn_1',
      dispatchAttempt: 1,
      workerGeneration: 4,
      status: 'completed',
      evidence: {
        kind: 'cli_transcript_terminal',
        nativeSessionId: 'coco-a',
        transcriptRef: 'events:20',
        output: 'turn one conclusion',
      },
    }, deps)).rejects.toThrow(/successor IPC/);

    expect(dispatched).toEqual([
      { turnId: 'om_turn_1', dispatchAttempt: 1 },
      { turnId: 'om_turn_2', dispatchAttempt: 1 },
    ]);
    expect(ambiguous).toEqual([{
      turnId: 'om_turn_2',
      dispatchAttempt: 1,
      error: 'worker died during successor IPC',
    }]);
    expect(turns.get('cand_alarm_42', 'om_turn_2')).toMatchObject({
      status: 'accepted',
      dispatchAttempt: 1,
    });
  });

  it('recovers an accepted turn after kill with the same identity and one replay attempt', async () => {
    const { dataDir } = fixture();
    const dispatched: CandidateTurnDispatch[] = [];
    await acceptCandidateTurnFromDaemon(input('om_after_kill'), {
      dataDir, receiverBootId: 'boot-a', workerGeneration: 2,
      dispatch(turn) { dispatched.push(turn); },
    });
    expect(dispatched).toMatchObject([{ turnId: 'om_after_kill', dispatchAttempt: 1 }]);

    const restarted = new CandidateTurnDurability({ dataDir });
    const recovery = restarted.recoveryPlan('cand_alarm_42', 'boot-b');
    expect(recovery).toMatchObject({ kind: 'fence_then_replay', turnId: 'om_after_kill', dispatchAttempt: 1 });
    expect((await restarted.claimHead('cand_alarm_42', {
      receiverBootId: 'boot-b', workerGeneration: 3,
    })).kind).toBe('in_flight');
    const replay = await restarted.claimHead('cand_alarm_42', {
      receiverBootId: 'boot-b', workerGeneration: 3, fencedAttempt: 1,
    });
    expect(replay).toMatchObject({ kind: 'dispatch', dispatch: { turnId: 'om_after_kill', dispatchAttempt: 2 } });
    expect(restarted.list('cand_alarm_42')).toHaveLength(1);
  });

  it('hands an ambiguous post-claim dispatch failure to recovery with the durable accepted receipt', async () => {
    const { dataDir, turns } = fixture();
    const recovery: Array<{ turnId: string; dispatchAttempt: number }> = [];
    await expect(acceptCandidateTurnFromDaemon(input('om_dispatch_crash'), {
      dataDir, receiverBootId: 'boot-a', workerGeneration: 2,
      dispatch() { throw new Error('worker died during IPC'); },
      onAmbiguousDispatch(receipt) {
        recovery.push({ turnId: receipt.turnId, dispatchAttempt: receipt.dispatchAttempt });
      },
    })).rejects.toThrow(/worker died/);

    expect(recovery).toEqual([{ turnId: 'om_dispatch_crash', dispatchAttempt: 1 }]);
    expect(turns.get('cand_alarm_42', 'om_dispatch_crash')).toMatchObject({
      status: 'accepted',
      dispatchAttempt: 1,
    });
  });

  it('does not replay a submitted turn after restart and reconciles its transcript terminal', async () => {
    const { dataDir, turns } = fixture();
    await turns.accept(input('om_submitted'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 9 });
    await turns.markSubmitted({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_submitted',
      dispatchAttempt: 1, workerGeneration: 9,
      evidence: { kind: 'cli_transcript', nativeSessionId: 'coco-a', transcriptRef: 'events:40' },
    });

    const restarted = new CandidateTurnDurability({ dataDir });
    expect(restarted.recoveryPlan('cand_alarm_42', 'boot-b')).toMatchObject({
      kind: 'reconcile_transcript', turnId: 'om_submitted', dispatchAttempt: 1,
    });
    expect((await restarted.claimHead('cand_alarm_42', {
      receiverBootId: 'boot-b', workerGeneration: 10,
    })).kind).toBe('submitted');

    const eventsPath = join(dataDir, 'events.jsonl');
    writeFileSync(eventsPath, [
      JSON.stringify({
        created_at: '2026-08-13T00:00:01.000Z',
        message: { message: { role: 'user', content: 'prompt:om_submitted', extra: { is_original_user_input: true } } },
      }),
      JSON.stringify({
        created_at: '2026-08-13T00:00:02.000Z',
        message: { message: { role: 'assistant', content: 'durable answer', response_meta: { finish_reason: 'stop' } } },
      }),
      '',
    ].join('\n'));
    const transcript = reconcileCandidateCocoTranscript(
      restarted.get('cand_alarm_42', 'om_submitted')!,
      'coco-a',
      eventsPath,
    );
    expect(transcript).toMatchObject({ kind: 'completed', output: 'durable answer' });
    if (transcript.kind !== 'completed') throw new Error('expected completed transcript');

    await restarted.markTerminal({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_submitted',
      dispatchAttempt: 1, workerGeneration: 9, status: 'completed',
      evidence: {
        kind: 'cli_transcript_terminal', nativeSessionId: 'coco-a',
        transcriptRef: transcript.terminalTranscriptRef, output: transcript.output,
      },
    });
    expect(restarted.get('cand_alarm_42', 'om_submitted')?.status).toBe('completed');
  });

  it('recovers a release-named Coco turn from the mapped TRAE rollout after worker restart', async () => {
    const { dataDir, turns } = fixture();
    const turnId = 'om_trae_recovery';
    const prompt = `prompt:${turnId}`;
    const nativeSessionId = '00000000-0000-7000-8000-000000000041';
    await turns.accept(input(turnId, prompt));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 9 });

    const sessionsDir = join(
      dataDir,
      'candidate-runtime',
      'botmux-session-1',
      'home',
      '.trae',
      'cli',
      'sessions',
      '2026',
      '08',
      '14',
    );
    mkdirSync(sessionsDir, { recursive: true });
    const rollout = join(sessionsDir, `rollout-2026-08-14T00-00-00-${nativeSessionId}.jsonl`);
    writeFileSync(rollout, [
      JSON.stringify({
        timestamp: '2026-08-14T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-14T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete', turn_id: '00000000-0000-7000-8000-000000000042',
          last_agent_message: 'recovered TRAE conclusion',
        },
      }),
      '',
    ].join('\n'));

    const recovered = reconcileCandidateRuntimeTranscript(
      turns.get('cand_alarm_42', turnId)!,
      {
        runtimeName: 'coco',
        nativeSessionId,
        dataDir,
        botmuxSessionId: 'botmux-session-1',
      },
    );

    expect(recovered).toMatchObject({
      kind: 'completed',
      nativeSessionId,
      output: 'recovered TRAE conclusion',
    });
  });

  it('fails an accepted dispatched turn with unknown native identity instead of replaying it', async () => {
    const settleUnknown = (candidateTurnEntry as any).settleCandidateTurnWithUnknownRuntimeIdentity;
    expect(settleUnknown).toBeTypeOf('function');
    const { dataDir, turns } = fixture();
    await turns.accept(input('om_unknown_native'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 9 });
    const receipt = turns.get('cand_alarm_42', 'om_unknown_native')!;
    const redispatched: CandidateTurnDispatch[] = [];

    await settleUnknown(receipt, {
      dataDir,
      receiverBootId: 'boot-b',
      workerGeneration: 10,
      dispatch(turn: CandidateTurnDispatch) { redispatched.push(turn); },
    });

    expect(redispatched).toEqual([]);
    expect(turns.get('cand_alarm_42', 'om_unknown_native')).toMatchObject({
      status: 'failed',
      dispatchAttempt: 1,
      transitions: [
        { status: 'accepted' },
        {
          status: 'failed',
          evidence: {
            kind: 'runtime_terminal',
            transcriptRef: expect.stringContaining('native_session_unknown'),
          },
        },
      ],
    });
  });

  it('records an explicit failed terminal when a submitted native runtime is gone', async () => {
    const { dataDir, turns } = fixture();
    await turns.accept(input('om_runtime_gone'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 9 });
    await turns.markSubmitted({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_runtime_gone',
      dispatchAttempt: 1, workerGeneration: 9,
      evidence: { kind: 'cli_transcript', nativeSessionId: 'coco-a', transcriptRef: 'events:40' },
    });

    await settleCandidateTurnFromWorker({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_runtime_gone',
      dispatchAttempt: 1, workerGeneration: 9, status: 'failed',
      evidence: {
        kind: 'runtime_terminal',
        nativeSessionId: 'coco-a',
        transcriptRef: 'events:40#runtime_gone',
      },
    }, {
      dataDir, receiverBootId: 'boot-b', workerGeneration: 10,
      dispatch() { throw new Error('no successor expected'); },
    });

    expect(turns.get('cand_alarm_42', 'om_runtime_gone')?.transitions.map(t => t.status))
      .toEqual(['accepted', 'submitted', 'failed']);
  });

  it('rejects PTY writes as submit confirmation', async () => {
    const { turns } = fixture();
    await turns.accept(input('om_pty'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 1 });
    await expect(turns.markSubmitted({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_pty',
      dispatchAttempt: 1, workerGeneration: 1,
      evidence: { kind: 'pty_write' } as never,
    })).rejects.toThrow(/submit confirmation/i);
    expect(turns.get('cand_alarm_42', 'om_pty')?.status).toBe('accepted');
  });

  it('drives a confirmed non-submit through worker IPC, durable receipt, and the Search RCA callback without submitted', async () => {
    const { dataDir, turns } = fixture();
    const callbacks: any[] = [];
    const callbackServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      callbacks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
    });
    await new Promise<void>((resolve, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = callbackServer.address();
      if (!address || typeof address === 'string') throw new Error('callback server address unavailable');
      const mirrorConfig = {
        url: `http://127.0.0.1:${address.port}`,
        token: 'test-token',
        botAppIds: ['cli_candidate'],
        candidateBotAppIds: ['cli_candidate'],
        timeoutMs: 1_000,
        maxInFlight: 1,
        maxQueued: 1,
      };
      const reporter = new CandidateTurnReceiptReporter({
        dataDir,
        deliver: receipt => deliverCandidateTurnReceiptHistory(receipt, mirrorConfig),
      });
      const deps = {
        dataDir,
        receiverBootId: 'boot-a',
        workerGeneration: 1,
        dispatch() {},
        onReceipt(receipt: Parameters<CandidateTurnReceiptReporter['report']>[0]) {
          reporter.report(receipt);
        },
      };
      await acceptCandidateTurnFromDaemon(input('om_not_submitted'), deps);
      await reporter.flush();

      registerBot({
        larkAppId: 'cli_candidate', larkAppSecret: 'test', cliId: 'coco',
        allowedUsers: ['ou_owner'],
      });
      const worker = new EventEmitter() as any;
      worker.killed = false;
      worker.send = vi.fn();
      worker.kill = vi.fn();
      worker.stdout = new EventEmitter();
      worker.stderr = new EventEmitter();
      const ds = {
        session: {
          sessionId: 'botmux-session-1', rootMessageId: 'om_candidate_root', chatId: 'oc_shadow',
          title: 'Candidate', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
          pid: null, chatType: 'group', cliId: 'coco', candidateRuntimeContract: {},
        },
        worker, workerPort: null, workerToken: null, larkAppId: 'cli_candidate', chatId: 'oc_shadow',
        chatType: 'group', scope: 'thread', spawnedAt: Date.now(), cliVersion: 'test',
        lastMessageAt: Date.now(), hasHistory: true, displayMode: 'hidden',
        lastScreenContent: '', lastScreenStatus: 'working', currentTurnTitle: 'Candidate',
      } as DaemonSession;
      let terminalDone!: () => void;
      const terminalSignal = new Promise<void>(resolve => { terminalDone = resolve; });
      initWorkerPool({
        sessionReply: vi.fn(async () => 'unused'),
        getSessionWorkingDir: () => dataDir,
        getActiveCount: () => 1,
        closeSession: vi.fn(),
        async onTurnTerminal(_ds, terminal, context) {
          await settleCandidateTurnFromWorker({
            candidateDispatchId: 'cand_alarm_42',
            turnId: terminal.turnId,
            dispatchAttempt: terminal.dispatchAttempt!,
            workerGeneration: context.workerGeneration,
            status: 'failed',
            evidence: {
              kind: 'runtime_terminal',
              nativeSessionId: terminal.nativeSessionId!,
              transcriptRef: terminal.transcriptRef!,
            },
          }, deps);
          terminalDone();
        },
      });
      __testOnly_setupWorkerHandlers(ds, worker);
      worker.emit('message', {
        type: 'turn_terminal', sessionId: 'botmux-session-1', turnId: 'om_not_submitted',
        dispatchAttempt: 1, status: 'failed', errorCode: 'submit_not_confirmed',
        nativeSessionId: 'botmux-session-1', transcriptRef: 'worker:submit_not_confirmed',
      });
      await terminalSignal;
      await reporter.flush();

      expect(turns.get('cand_alarm_42', 'om_not_submitted')?.transitions.map(item => item.status))
        .toEqual(['accepted', 'failed']);
      expect([...new Set(callbacks.map(item => item.status))]).toEqual(['accepted', 'failed']);
      expect(callbacks.some(item => item.status === 'submitted')).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => callbackServer.close(error => error ? reject(error) : resolve()));
    }
  });

  it('replays the durable transition history to Search RCA with the same turn and Session identity', async () => {
    const { turns } = fixture();
    await turns.accept(input('om_callback'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 3 });
    await turns.markSubmitted({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_callback',
      dispatchAttempt: 1, workerGeneration: 3,
      evidence: { kind: 'cli_transcript', nativeSessionId: 'coco-a', transcriptRef: 'events:10' },
    });
    const terminal = await turns.markTerminal({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_callback',
      dispatchAttempt: 1, workerGeneration: 3, status: 'completed',
      evidence: {
        kind: 'cli_transcript_terminal', nativeSessionId: 'coco-a', transcriptRef: 'events:20',
        output: 'callback conclusion',
      },
    });
    const callbacks: any[] = [];

    await deliverCandidateTurnReceiptHistory(terminal, {
      url: 'http://127.0.0.1:9090',
      token: 'test-token',
      botAppIds: ['cli_candidate'],
      candidateBotAppIds: ['cli_candidate'],
      timeoutMs: 1_000,
      maxInFlight: 1,
      maxQueued: 1,
    }, async (_url, init) => {
      callbacks.push(JSON.parse(String(init?.body)));
      return { ok: true } as Response;
    });

    expect(callbacks.map(item => item.status)).toEqual(['accepted', 'submitted', 'completed']);
    expect(callbacks.every(item => item.turnId === 'om_callback'
      && item.sequence === 1
      && item.rootMessageId === 'om_candidate_root'
      && item.botmuxSessionId === 'botmux-session-1')).toBe(true);
  });

  it('binds a fresh Candidate CoCo transcript to the BotMux Session before emitting worker evidence', async () => {
    const evidence = candidateCocoTranscriptEvidence({
      botmuxSessionId: 'botmux-session-1',
    });
    expect(evidence.nativeSessionId).toBe('botmux-session-1');
    expect(evidence.transcriptRef).toContain('botmux-session-1');

    const { dataDir, turns } = fixture();
    await turns.accept(input('om_fresh_coco'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 1 });
    const eventsPath = join(dataDir, 'fresh-coco-events.jsonl');
    writeFileSync(eventsPath, [
      JSON.stringify({
        created_at: '2026-08-13T00:00:01.000Z',
        message: { message: { role: 'user', content: 'prompt:om_fresh_coco', extra: { is_original_user_input: true } } },
      }),
      JSON.stringify({
        created_at: '2026-08-13T00:00:02.000Z',
        message: { message: { role: 'assistant', content: 'fresh answer', response_meta: { finish_reason: 'stop' } } },
      }),
      '',
    ].join('\n'));
    const transcript = reconcileCandidateCocoTranscript(
      turns.get('cand_alarm_42', 'om_fresh_coco')!,
      evidence.nativeSessionId,
      eventsPath,
    );
    expect(transcript.kind).toBe('completed');
    if (transcript.kind !== 'completed') throw new Error('expected completed transcript');
    const worker = new EventEmitter() as any;
    worker.killed = false;
    worker.send = vi.fn();
    worker.kill = vi.fn();
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();
    const ds = {
      session: {
        sessionId: 'botmux-session-1', rootMessageId: 'om_candidate_root', chatId: 'oc_shadow',
        title: 'Candidate', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
        pid: null, chatType: 'group', cliId: 'coco', candidateRuntimeContract: {},
      },
      worker, workerPort: null, workerToken: null, larkAppId: 'cli_candidate', chatId: 'oc_shadow',
      chatType: 'group', scope: 'thread', spawnedAt: Date.now(), cliVersion: 'test',
      lastMessageAt: Date.now(), hasHistory: true, displayMode: 'hidden',
      lastScreenContent: '', lastScreenStatus: 'working', currentTurnTitle: 'Candidate',
    } as DaemonSession;
    const dispatched: CandidateTurnDispatch[] = [];
    registerBot({
      larkAppId: 'cli_candidate', larkAppSecret: 'test', cliId: 'coco',
      allowedUsers: ['ou_owner'],
    });
    const deps = {
      dataDir, receiverBootId: 'boot-a', workerGeneration: 1,
      dispatch(turn: CandidateTurnDispatch) { dispatched.push(turn); },
    };
    let submittedDone!: () => void;
    let terminalDone!: () => void;
    const submittedSignal = new Promise<void>(resolve => { submittedDone = resolve; });
    const terminalSignal = new Promise<void>(resolve => { terminalDone = resolve; });
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_answer'),
      getSessionWorkingDir: () => dataDir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      async onTurnSubmitted(_ds, submitted) {
        await submitCandidateTurnFromWorker({
          candidateDispatchId: 'cand_alarm_42', turnId: submitted.turnId,
          dispatchAttempt: submitted.dispatchAttempt, workerGeneration: 1,
          evidence: {
            kind: submitted.evidenceKind,
            nativeSessionId: submitted.nativeSessionId,
            transcriptRef: submitted.transcriptRef,
          },
        }, deps);
        submittedDone();
      },
      async onTurnTerminal(_ds, terminal) {
        await settleCandidateTurnFromWorker({
          candidateDispatchId: 'cand_alarm_42', turnId: terminal.turnId,
          dispatchAttempt: terminal.dispatchAttempt!, workerGeneration: 1,
          status: 'completed',
          evidence: {
            kind: 'cli_transcript_terminal',
            nativeSessionId: terminal.nativeSessionId!,
            transcriptRef: terminal.transcriptRef!,
            output: transcript.output,
          },
        }, deps);
        terminalDone();
      },
    });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'turn_submitted', sessionId: 'botmux-session-1', turnId: 'om_fresh_coco',
      dispatchAttempt: 1, evidenceKind: 'cli_transcript',
      nativeSessionId: evidence.nativeSessionId, transcriptRef: transcript.submitTranscriptRef,
    });
    await submittedSignal;
    worker.emit('message', {
      type: 'turn_terminal', sessionId: 'botmux-session-1', turnId: 'om_fresh_coco',
      dispatchAttempt: 1, status: 'completed', nativeSessionId: evidence.nativeSessionId,
      transcriptRef: transcript.terminalTranscriptRef,
    });
    await terminalSignal;
    expect(turns.get('cand_alarm_42', 'om_fresh_coco')?.transitions.map(item => item.status))
      .toEqual(['accepted', 'submitted', 'completed']);
    expect(dispatched).toEqual([]);
  });

  it('keeps disabled control-plane delivery pending for restart replay', async () => {
    const { dataDir, turns } = fixture();
    const accepted = await turns.accept(input('om_disabled_callback'));
    const scheduled: Array<() => void> = [];
    const disabledReporter = new CandidateTurnReceiptReporter({
      dataDir,
      deliver: async () => 'disabled',
      schedule: (callback) => {
        scheduled.push(callback);
        return { unref() {} } as NodeJS.Timeout;
      },
    });

    disabledReporter.report(accepted.receipt);
    await disabledReporter.flush();

    expect(turns.get('cand_alarm_42', 'om_disabled_callback')?.controlPlaneDelivery)
      .toMatchObject({ acknowledgedTransitions: 0, attempts: 1 });
    expect(scheduled).toHaveLength(1);

    let replayed = 0;
    const restartedReporter = new CandidateTurnReceiptReporter({
      dataDir,
      deliver: async () => {
        replayed += 1;
        return 'sent';
      },
    });
    restartedReporter.recoverPending();
    await restartedReporter.flush();

    expect(replayed).toBe(1);
    expect(turns.get('cand_alarm_42', 'om_disabled_callback')?.controlPlaneDelivery)
      .toMatchObject({ acknowledgedTransitions: 1, attempts: 2 });
  });

  it('retries a failed terminal callback in the same daemon from its durable pending marker', async () => {
    const { dataDir, turns } = fixture();
    await turns.accept(input('om_retry_callback'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 1 });
    const terminal = await turns.markTerminal({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_retry_callback',
      dispatchAttempt: 1, workerGeneration: 1, status: 'completed',
      evidence: {
        kind: 'cli_transcript_terminal', nativeSessionId: 'botmux-session-1', transcriptRef: 'events:20',
        output: 'retry conclusion',
      },
    });
    const scheduled: Array<() => void> = [];
    let attempts = 0;
    const reporter = new CandidateTurnReceiptReporter({
      dataDir,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Search RCA temporarily unavailable');
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return { unref() {} } as NodeJS.Timeout;
      },
    });

    reporter.report(terminal);
    await reporter.flush();
    expect(turns.get('cand_alarm_42', 'om_retry_callback')?.controlPlaneDelivery)
      .toMatchObject({ acknowledgedTransitions: 0, attempts: 1 });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await reporter.flush();

    expect(attempts).toBe(2);
    expect(turns.get('cand_alarm_42', 'om_retry_callback')?.controlPlaneDelivery)
      .toMatchObject({ acknowledgedTransitions: 3, attempts: 2 });
  });

  it('records a control-plane identity rejection once instead of retrying forever', async () => {
    const { dataDir, turns } = fixture();
    await turns.accept(input('om_terminal_reject'));
    const scheduled: Array<() => void> = [];
    const errors: unknown[] = [];
    const reporter = new CandidateTurnReceiptReporter({
      dataDir,
      deliver: async () => {
        throw new CandidateTurnReceiptDeliveryError('RCA Server returned HTTP 409', false);
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return { unref() {} } as NodeJS.Timeout;
      },
      onError(error) { errors.push(error); },
    });

    reporter.report(turns.get('cand_alarm_42', 'om_terminal_reject')!);
    await reporter.flush();

    expect(scheduled).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(turns.get('cand_alarm_42', 'om_terminal_reject')?.controlPlaneDelivery)
      .toMatchObject({
        acknowledgedTransitions: 0,
        terminalRejectedTransitions: 1,
        attempts: 1,
        terminalRejection: expect.stringContaining('409'),
      });
  });

  it('uses one durable output UUID so recovery skips an answer already posted by the worker', async () => {
    const { dataDir, turns } = fixture();
    await turns.accept(input('om_output'));
    await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 1 });
    await turns.markSubmitted({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_output',
      dispatchAttempt: 1, workerGeneration: 1,
      evidence: { kind: 'cli_transcript', nativeSessionId: 'botmux-session-1', transcriptRef: 'events:10' },
    });
    const uuid = candidateTurnOutputUuid('botmux-session-1', 'om_output');
    registerBot({
      larkAppId: 'cli_candidate', larkAppSecret: 'test', cliId: 'coco',
      allowedUsers: ['ou_owner'],
    });
    const worker = new EventEmitter() as any;
    worker.killed = false;
    worker.send = vi.fn();
    worker.kill = vi.fn();
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();
    const ds = {
      session: {
        sessionId: 'botmux-session-1', rootMessageId: 'om_candidate_root', chatId: 'oc_shadow',
        title: 'Candidate', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
        pid: null, chatType: 'group', cliId: 'coco', candidateRuntimeContract: {},
      },
      worker, workerPort: null, workerToken: null, larkAppId: 'cli_candidate', chatId: 'oc_shadow',
      chatType: 'group', scope: 'thread', spawnedAt: Date.now(), cliVersion: 'test',
      lastMessageAt: Date.now(), hasHistory: true, displayMode: 'hidden',
      lastScreenContent: '', lastScreenStatus: 'working', currentTurnTitle: 'Candidate',
      workingDir: dataDir,
    } as DaemonSession;
    const sessionReply = vi.fn(async () => 'om_answer');
    let terminalDone!: () => void;
    const terminalSignal = new Promise<void>(resolve => { terminalDone = resolve; });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => dataDir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      beforeTurnOutputDelivery: async (_ds, output, context) => {
        const claim = await turns.claimOutputDelivery({
          candidateDispatchId: 'cand_alarm_42', turnId: output.turnId,
          dispatchAttempt: output.dispatchAttempt!, workerGeneration: context.workerGeneration, uuid,
        });
        return claim.kind === 'send'
          ? { kind: 'send', uuid }
          : { kind: 'skip', ...(claim.kind === 'already_delivered' ? { messageId: claim.messageId } : {}) };
      },
      onTurnOutputDelivered: (_ds, output, delivery, context) => turns.markOutputDelivered({
        candidateDispatchId: 'cand_alarm_42', turnId: output.turnId,
        dispatchAttempt: output.dispatchAttempt!, workerGeneration: context.workerGeneration,
        uuid: delivery.uuid, messageId: delivery.messageId, output: output.content,
      }),
      onTurnTerminal() { terminalDone(); },
    });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'final_output', sessionId: 'botmux-session-1', turnId: 'om_output',
      dispatchAttempt: 1, content: 'durable answer', lastUuid: 'assistant-output-1',
    });
    worker.emit('message', {
      type: 'turn_terminal', sessionId: 'botmux-session-1', turnId: 'om_output',
      dispatchAttempt: 1, status: 'completed', nativeSessionId: 'botmux-session-1',
      transcriptRef: 'events:20',
    });
    await terminalSignal;

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0]?.[5]).toMatchObject({ uuid });

    expect(await turns.claimOutputDelivery({
      candidateDispatchId: 'cand_alarm_42', turnId: 'om_output',
      dispatchAttempt: 1, workerGeneration: 1, uuid,
    })).toMatchObject({ kind: 'already_delivered', messageId: 'om_answer' });
    expect(candidateTurnOutputUuid('botmux-session-1', 'om_output')).toBe(uuid);
  });
});
