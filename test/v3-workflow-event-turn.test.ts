/**
 * M1 turn class (b): a main-session turn the run-owning daemon opened for
 * THIS run's own events (`workflow-event:<runId>:<seq>`). Driven through the
 * real process-marker + session-store resolver with a fake daemon-minted
 * turn: it authenticates only through the run-bound verifier of a
 * status/edit of that very run; every other command — and every other
 * synthetic turn id — stays refused.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CurrentTurnProvenanceError,
  resolveCurrentTurnProvenance,
} from '../src/core/current-turn-provenance.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import {
  mintWorkflowEventTurnId,
  parseWorkflowEventTurnId,
} from '../src/core/workflow-event-turn.js';
import {
  authorizeV3DaemonCommand,
  authorizeV3RunEditCommand,
  V3DaemonCommandAuthorityError,
} from '../src/workflows/v3/cli-daemon-command-authority.js';
import {
  artifactRef,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { authorizeV3SessionRunMutationRequest } from '../src/workflows/v3/session-relay.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { recordV3MainWakeIssued } from '../src/workflows/v3/main-wake-ledger.js';

const RUN = 'wf-event-run';
const BINDING = { larkAppId: 'cli_real', chatId: 'oc_real', rootMessageId: 'om_real_root', ownerOpenId: 'ou_initiator' };

let root: string;
let dataDir: string;
let baseDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v3-wf-event-turn-'));
  dataDir = join(root, 'sessions');
  baseDir = join(root, 'v3-runs');
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeMarker(turnId: string): void {
  const procStart = readProcessStartIdentity(process.pid);
  if (!procStart) throw new Error('test process start identity unavailable');
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'sess-main', turnId, procStart }));
}

function writeSession(overrides: Record<string, unknown> = {}): void {
  const session = {
    sessionId: 'sess-main',
    status: 'active',
    scope: 'thread',
    larkAppId: BINDING.larkAppId,
    chatId: BINDING.chatId,
    chatType: 'group',
    rootMessageId: BINDING.rootMessageId,
    lastCallerOpenId: 'ou_last_human',
    quoteTargetId: 'om_last_human_msg',
    ...overrides,
  };
  seedPersistedSessionRows(dataDir, BINDING.larkAppId, { [session.sessionId]: session });
}

function seedRun(runId = RUN): void {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('dag.json', { schemaVersion: 2, runId, nodes: [{ id: 'a', type: 'goal', goal: 'a', bot: 'cli_w', depends: [], inputs: [] }] });
  write('spec.json', {
    schemaVersion: 1, runId, title: 't', requirement: 'r',
    nodes: [{ sketchId: 'a', goal: 'a', input_needs: [], expected_outputs: ['o'], acceptance: 'x', risk_gate: false, unknowns: [] }],
  });
  write('bots.snapshot.json', { cli_w: { larkAppId: 'cli_w', cliId: 'claude-code', workingDir: '/w' } });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-11-03T08:00:00.000Z',
    authorizedAt: '2026-11-03T08:01:00.000Z',
    authorizedByOpenId: 'ou_initiator',
    chatBinding: BINDING,
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'workerError',
  });
}

/** Fake issuer: what the run-owning daemon records before opening a wake turn. */
function issueWake(runId: string, eventSeq: number, overrides: Record<string, unknown> = {}): string {
  const turnId = mintWorkflowEventTurnId(runId, eventSeq);
  recordV3MainWakeIssued(join(baseDir, runId), {
    runId, eventSeq, turnId, sessionId: 'sess-main', larkAppId: BINDING.larkAppId, chatId: BINDING.chatId,
    rootMessageId: BINDING.rootMessageId, issuedAt: Date.now() - 1_000, ...overrides,
  } as never);
  return turnId;
}

const editAs = (runId = RUN) => authorizeV3RunEditCommand({ runId, baseDir, dataDir, envSessionId: 'sess-main', startPid: process.pid });

describe('workflow event turn ids', () => {
  it('round-trips and refuses anything that is not exactly one run id plus a positive event position', () => {
    expect(parseWorkflowEventTurnId(mintWorkflowEventTurnId(RUN, 7))).toEqual({ runId: RUN, eventSeq: 7 });
    for (const bad of ['workflow-event:run:0', 'workflow-event:../x:1', 'workflow-event:a:b:1', 'trg_1', 'schedule:x:1']) {
      expect(parseWorkflowEventTurnId(bad)).toBeNull();
    }
  });
});

describe('event-woken turn of THIS run', () => {
  it('may run status/edit for its own run as the main bot, acting for the initiator', () => {
    seedRun();
    writeSession();
    writeMarker(issueWake(RUN, 2));
    expect(editAs()).toMatchObject({ origin: 'runEvent', callerOpenId: 'ou_initiator' });
  });

  it('is recognised only when the run-owning daemon recorded issuing it to this session', () => {
    seedRun();
    writeSession();
    writeMarker(mintWorkflowEventTurnId(RUN, 2)); // well-formed, never issued
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);
    issueWake(RUN, 2, { sessionId: 'sess-another' });
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);
  });

  it('is refused for another run, outside the main session, for a missing event, or after the run ended', () => {
    seedRun();
    seedRun('other-run');
    writeSession();
    writeMarker(issueWake('other-run', 2));
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);

    writeMarker(issueWake(RUN, 99));
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);

    writeSession({ rootMessageId: 'om_some_other_topic' });
    writeMarker(issueWake(RUN, 2));
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);

    writeSession();
    appendEvent(join(baseDir, RUN, 'journal.ndjson'), { type: 'runFailed', failedNodeId: 'a' });
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);
  });

  it('acts as the frozen initiator, so retry/grant/cancel keep their unchanged owner-tuple check', () => {
    seedRun();
    seedRun('other-run');
    writeSession();
    writeMarker(issueWake(RUN, 2));
    expect(authorizeV3DaemonCommand({ runId: RUN, baseDir, dataDir, envSessionId: 'sess-main', startPid: process.pid }))
      .toMatchObject({ mode: 'chat', larkAppId: BINDING.larkAppId });
    // Never for another run, and never for a command without a run-bound verifier.
    expect(() => authorizeV3DaemonCommand({ runId: 'other-run', baseDir, dataDir, envSessionId: 'sess-main', startPid: process.pid }))
      .toThrow(CurrentTurnProvenanceError);
    expect(() => resolveCurrentTurnProvenance({ dataDir, envSessionId: 'sess-main', startPid: process.pid }))
      .toThrow(CurrentTurnProvenanceError);
  });

  it('the sandbox relay recognises it the same way and still refuses other synthetic turns', () => {
    seedRun();
    seedRun('other-run');
    issueWake(RUN, 2);
    const capability = 'c'.repeat(64);
    const relay = (runId: string, turnId: string, rootMessageId = BINDING.rootMessageId) => authorizeV3SessionRunMutationRequest({
      runId,
      mutation: 'retry',
      raw: { sessionId: 'sess-main', originCapability: capability },
      trustedHost: false,
      session: {
        receiver: false,
        liveOrigin: { capability, turnId, dispatchAttempt: 1 },
        callerOpenId: 'ou_last_human',
        chatId: BINDING.chatId,
        larkAppId: BINDING.larkAppId,
        quoteTargetId: 'om_last_human_msg',
        rootMessageId,
      },
      selfLarkAppId: BINDING.larkAppId,
      baseDir,
    });
    expect(relay(RUN, mintWorkflowEventTurnId(RUN, 2))).toMatchObject({ ok: true, larkAppId: BINDING.larkAppId });
    expect(relay('other-run', mintWorkflowEventTurnId(RUN, 2))).toMatchObject({ ok: false, error: 'workflow_event_turn_unauthorized' });
    expect(relay(RUN, mintWorkflowEventTurnId(RUN, 2), 'om_other_topic')).toMatchObject({ ok: false, error: 'workflow_event_turn_unauthorized' });
    expect(relay(RUN, 'trg_9f2b1caa-0000-4000-8000-000000000000')).toMatchObject({ ok: false, error: 'turn_provenance_stale' });
  });

  it('a human turn in the main session is a human edit, whoever the human is', () => {
    seedRun();
    writeSession();
    writeMarker('om_last_human_msg');
    expect(editAs()).toMatchObject({ origin: 'human', callerOpenId: 'ou_last_human' });
    writeSession({ rootMessageId: 'om_unrelated_topic' });
    expect(() => editAs()).toThrow(V3DaemonCommandAuthorityError);
  });
});
