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
import {
  authorizeV3SessionRunEditRequest,
  authorizeV3SessionRunMutationRequest,
} from '../src/workflows/v3/session-relay.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { recordV3MainWakeIssued } from '../src/workflows/v3/main-wake-ledger.js';
import { applyV3RunEdit } from '../src/workflows/v3/run-edit.js';

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
    rootMessageId: BINDING.rootMessageId, issuedAt: Date.now() - 1_000,
    // The issuer snapshots the session's turn pointers as they were when it
    // opened the wake turn (the seeded session's last human message).
    turnPointersAtIssue: { quoteTargetId: 'om_last_human_msg' }, ...overrides,
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

describe('a human message arrives while the main bot handles a wake turn', () => {
  // The run's initiator and another member of the group.
  const INITIATOR = 'ou_initiator';
  const MEMBER = 'ou_member';
  const capability = 'c'.repeat(64);
  const patch = [{ op: 'updateNode', nodeId: 'a', set: { goal: 'as discussed in the topic' } }];
  const apply = (caller: { openId: string; origin: 'human' | 'runEvent' }) => applyV3RunEdit({
    baseDir, runId: RUN, patch, baseRevision: 1, caller,
    resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
  });
  /** The session after a message from `sender` landed in the main topic. */
  const messageFrom = (sender: string, messageId: string) => ({
    quoteTargetId: messageId,
    lastCallerOpenId: sender,
    currentReplyTarget: { turnId: messageId, rootMessageId: BINDING.rootMessageId },
  });
  const hostEdit = (sender: string, messageId: string, markerTurnId: string) => {
    writeSession(messageFrom(sender, messageId));
    writeMarker(markerTurnId);
    const authority = editAs();
    return { authority, outcome: apply({ openId: authority.callerOpenId, origin: authority.origin }) };
  };
  const relayEdit = (sender: string, messageId: string, liveTurnId: string) => {
    const decision = authorizeV3SessionRunEditRequest({
      runId: RUN,
      mutation: 'edit',
      raw: { sessionId: 'sess-main', originCapability: capability, patch, base: 1 },
      trustedHost: false,
      session: {
        receiver: false,
        liveOrigin: { capability, turnId: liveTurnId, dispatchAttempt: 1 },
        callerOpenId: sender,
        chatId: BINDING.chatId,
        larkAppId: BINDING.larkAppId,
        quoteTargetId: messageId,
        currentReplyTargetTurnId: messageId,
        rootMessageId: BINDING.rootMessageId,
      },
      selfLarkAppId: BINDING.larkAppId,
      baseDir,
    });
    if (!decision.ok || !decision.edit) return { decision, outcome: undefined };
    return { decision, outcome: apply(decision.edit.caller) };
  };

  it('host: the initiator\'s message absorbed into the wake turn → the edit is the initiator\'s own (M1 direct)', () => {
    seedRun();
    const wake = issueWake(RUN, 2);
    const { authority, outcome } = hostEdit(INITIATOR, 'om_initiator_says', wake);
    expect(authority).toMatchObject({ origin: 'human', callerOpenId: INITIATOR });
    expect(outcome).toMatchObject({ kind: 'applied' });
  });

  it('host: the initiator\'s message opened a new turn → the same', () => {
    seedRun();
    issueWake(RUN, 2);
    const { authority, outcome } = hostEdit(INITIATOR, 'om_initiator_says', 'om_initiator_says');
    expect(authority).toMatchObject({ origin: 'human', callerOpenId: INITIATOR });
    expect(outcome).toMatchObject({ kind: 'applied' });
  });

  it('host: another member\'s message (absorbed or as a new turn) → a proposal for the initiator, not an error', () => {
    seedRun();
    const wake = issueWake(RUN, 2);
    for (const markerTurnId of [wake, 'om_member_says']) {
      const { authority, outcome } = hostEdit(MEMBER, 'om_member_says', markerTurnId);
      expect(authority).toMatchObject({ origin: 'human', callerOpenId: MEMBER });
      expect(outcome).toMatchObject({ kind: 'proposed', reasons: ['callerNotInitiator'] });
      // Leave the next case a run without a pending proposal.
      rmSync(join(baseDir, RUN), { recursive: true, force: true });
      seedRun();
      issueWake(RUN, 2);
    }
  });

  it('relay: the same three cases', () => {
    seedRun();
    const wake = issueWake(RUN, 2);
    expect(relayEdit(INITIATOR, 'om_initiator_says', wake)).toMatchObject({
      decision: { ok: true, edit: { caller: { openId: INITIATOR, origin: 'human' } } }, outcome: { kind: 'applied' },
    });
    rmSync(join(baseDir, RUN), { recursive: true, force: true });
    seedRun();
    issueWake(RUN, 2);
    expect(relayEdit(INITIATOR, 'om_initiator_says', 'om_initiator_says')).toMatchObject({ outcome: { kind: 'applied' } });
    rmSync(join(baseDir, RUN), { recursive: true, force: true });
    seedRun();
    const wake2 = issueWake(RUN, 2);
    for (const liveTurnId of [wake2, 'om_member_says']) {
      expect(relayEdit(MEMBER, 'om_member_says', liveTurnId)).toMatchObject({
        decision: { ok: true, edit: { caller: { openId: MEMBER, origin: 'human' } } },
        outcome: { kind: 'proposed', reasons: ['callerNotInitiator'] },
      });
      rmSync(join(baseDir, RUN), { recursive: true, force: true });
      seedRun();
      issueWake(RUN, 2);
    }
  });

  it('the overtaken wake turn never keeps acting as the initiator (generation join)', () => {
    seedRun();
    const wake = issueWake(RUN, 2);
    // Not overtaken: the wake turn acts for the initiator.
    writeSession();
    writeMarker(wake);
    expect(editAs()).toMatchObject({ origin: 'runEvent', callerOpenId: INITIATOR });
    // Overtaken by a member: it is the member's edit now, not the initiator's.
    writeSession(messageFrom(MEMBER, 'om_member_says'));
    expect(editAs()).toMatchObject({ origin: 'human', callerOpenId: MEMBER });
    expect(relayEdit(MEMBER, 'om_member_says', wake).decision).toMatchObject({ ok: true, edit: { caller: { openId: MEMBER } } });
  });

  it('when the newer turn names no human sender, the request is refused as stale', () => {
    seedRun();
    const wake = issueWake(RUN, 2);
    writeSession({ quoteTargetId: 'om_unattributed', lastCallerOpenId: undefined });
    writeMarker(wake);
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);
    writeSession({ quoteTargetId: mintWorkflowEventTurnId(RUN, 3) });
    expect(() => editAs()).toThrow(CurrentTurnProvenanceError);
  });
});
