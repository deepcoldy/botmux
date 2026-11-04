/**
 * M1 turn class (b): a main-session turn the run-owning daemon opened for
 * THIS run's own events (`workflow-event:<runId>:<seq>`). Driven through the
 * real process-marker + session-store resolver with a fake daemon-minted
 * turn: it authenticates only through the run-bound verifier of a
 * status/edit of that very run; every other command — and every other
 * synthetic turn id — stays refused.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import {
  authorizeV3SessionRunEditRequest,
  authorizeV3SessionRunMutationRequest,
  v3RelayScheduleBotHasAllowlist,
  v3ScheduleTurnRelayAuth,
} from '../src/workflows/v3/session-relay.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { recordV3MainWakeIssued } from '../src/workflows/v3/main-wake-ledger.js';
import { applyV3RunEdit } from '../src/workflows/v3/run-edit.js';
import { botHomePath } from '../src/adapters/cli/read-isolation.js';

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

  it('host: the initiator\'s message overtakes the wake turn → accepted, but still the main bot\'s own decision', () => {
    seedRun();
    const wake = issueWake(RUN, 2);
    const { authority, outcome } = hostEdit(INITIATOR, 'om_initiator_says', wake);
    expect(authority).toMatchObject({ origin: 'runEvent', callerOpenId: INITIATOR });
    expect(outcome).toMatchObject({ kind: 'applied' });
    expect(readJournal(join(baseDir, RUN, 'journal.ndjson')).find((event) => event.type === 'dagRevised'))
      .toMatchObject({ by: 'main_bot', auto: expect.anything() });
  });

  it('host: the initiator\'s message opened a new turn → the initiator\'s own edit', () => {
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
      decision: { ok: true, edit: { caller: { openId: INITIATOR, origin: 'runEvent' } } }, outcome: { kind: 'applied' },
    });
    rmSync(join(baseDir, RUN), { recursive: true, force: true });
    seedRun();
    issueWake(RUN, 2);
    expect(relayEdit(INITIATOR, 'om_initiator_says', 'om_initiator_says')).toMatchObject({
      decision: { ok: true, edit: { caller: { openId: INITIATOR, origin: 'human' } } }, outcome: { kind: 'applied' },
    });
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
    // Relay: the session's fields must name one human generation.
    const relayStatus = (session: { callerOpenId?: string; quoteTargetId?: string; currentReplyTargetTurnId?: string }) =>
      authorizeV3SessionRunEditRequest({
        runId: RUN,
        mutation: 'status',
        raw: { sessionId: 'sess-main', originCapability: capability },
        trustedHost: false,
        session: {
          receiver: false,
          liveOrigin: { capability, turnId: wake, dispatchAttempt: 1 },
          chatId: BINDING.chatId,
          larkAppId: BINDING.larkAppId,
          rootMessageId: BINDING.rootMessageId,
          ...session,
        },
        selfLarkAppId: BINDING.larkAppId,
        baseDir,
      });
    expect(relayStatus({ callerOpenId: MEMBER, quoteTargetId: 'om_member_says' })).toMatchObject({ ok: true });
    for (const session of [
      { quoteTargetId: 'om_member_says' },
      { callerOpenId: MEMBER, quoteTargetId: mintWorkflowEventTurnId(RUN, 3) },
      { callerOpenId: MEMBER, quoteTargetId: 'om_member_says', currentReplyTargetTurnId: 'om_someone_else' },
    ]) {
      expect(relayStatus(session)).toMatchObject({ ok: false, error: 'turn_provenance_stale' });
    }
  });
});

/**
 * M2 乙 grades a runtime edit by who decided it. Only a turn the initiator's
 * own message opened is the initiator's decision; a wake turn a newer message
 * of the initiator overtook, and a scheduled turn of the initiator's task,
 * stay the main bot's own decision: the full §13.5 list, no automatic rerun
 * budget, recorded as `main_bot`. Real marker + session store + relay +
 * engine.
 */
describe('who decided the edit: an overtaken wake turn or a scheduled turn is the main bot\'s', () => {
  const INITIATOR = 'ou_initiator';
  const MEMBER = 'ou_member';
  const capability = 'c'.repeat(64);
  const SCHEDULE_TURN = 'schedule:task1:12345678-1234-1234-1234-123456789abc';

  /** a: blocked · g: gated, not started · d: done, its rerun budget spent. */
  function seedRiskRun(): void {
    const runDir = join(baseDir, RUN);
    mkdirSync(runDir, { recursive: true });
    const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
    write('dag.json', { schemaVersion: 2, runId: RUN, nodes: [
      { id: 'a', type: 'goal', goal: 'a', bot: 'cli_w', depends: [], inputs: [] },
      { id: 'g', type: 'goal', goal: 'g', bot: 'cli_w', depends: [], inputs: [], humanGate: { prompt: 'ok?' } },
      { id: 'd', type: 'goal', goal: 'd', bot: 'cli_w', depends: [], inputs: [] },
    ] });
    write('spec.json', {
      schemaVersion: 1, runId: RUN, title: 't', requirement: 'r',
      nodes: [{ sketchId: 'a', goal: 'a', input_needs: [], expected_outputs: ['o'], acceptance: 'x', risk_gate: false, unknowns: [] }],
    });
    write('bots.snapshot.json', { cli_w: { larkAppId: 'cli_w', cliId: 'claude-code', workingDir: '/w' } });
    publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
      runId: RUN, createdAt: '2026-11-03T08:00:00.000Z', authorizedAt: '2026-11-03T08:01:00.000Z',
      authorizedByOpenId: INITIATOR, chatBinding: BINDING,
      artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
    }));
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, { type: 'runStarted', runId: RUN });
    appendEvent(journalPath, { type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'workerError' });
    const finishD = (instanceId: string) => {
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'd', instanceId, attemptId: `${instanceId}/attempts/001` });
      appendEvent(journalPath, { type: 'nodeSucceeded', nodeId: 'd', instanceId, attemptId: `${instanceId}/attempts/001`, manifestPath: join(runDir, 'm.json') });
    };
    finishD('d#001');
    // The initiator's own earlier re-run spends d's one revisit.
    expect(applyEdit([{ op: 'rerunNode', nodeId: 'd' }], { openId: INITIATOR, origin: 'human' }, 1)).toMatchObject({ kind: 'applied', revision: 2 });
    finishD('d#002');
  }

  /** The main bot, on its own, brings in an unapproved bot and drops a gate. */
  const RISKY = [
    { op: 'reassign', nodeId: 'a', bot: 'cli_fresh' },
    { op: 'updateNode', nodeId: 'g', set: { humanGate: null } },
  ];
  const RERUN_SPENT = [{ op: 'rerunNode', nodeId: 'd' }];
  const BENIGN = [{ op: 'updateNode', nodeId: 'g', set: { goal: 'g, as discussed' } }];

  function applyEdit(patch: unknown, caller: { openId: string; origin: 'human' | 'runEvent' }, base = 2) {
    return applyV3RunEdit({
      baseDir, runId: RUN, patch, baseRevision: base, caller,
      resolveNewBotSnapshot: (selector) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never,
    });
  }
  const lastRevision = () => readJournal(join(baseDir, RUN, 'journal.ndjson')).filter((event) => event.type === 'dagRevised').at(-1);

  /** The three things only the initiator's own turn may do directly.
   *  `prepare` seeds a fresh run (and whatever the turn needs on it). */
  function expectMainBotGrade(caller: () => { openId: string; origin: 'human' | 'runEvent' }, prepare: () => void): void {
    prepare();
    expect(applyEdit(RISKY, caller())).toMatchObject({ kind: 'proposed', reasons: expect.arrayContaining(['newBot', 'gateRelaxed']) });
    rmSync(join(baseDir, RUN), { recursive: true, force: true });
    prepare();
    expect(applyEdit(RERUN_SPENT, caller())).toMatchObject({ kind: 'invalid', rerunBudget: { nodeId: 'd', tier: 'pair' } });
    expect(applyEdit(BENIGN, caller())).toMatchObject({ kind: 'applied', revision: 3 });
    expect(lastRevision()).toMatchObject({ revision: 3, by: 'main_bot', auto: expect.anything() });
  }

  const initiatorMessage = {
    quoteTargetId: 'om_initiator_ack', lastCallerOpenId: INITIATOR,
    currentReplyTarget: { turnId: 'om_initiator_ack', rootMessageId: BINDING.rootMessageId },
  };
  const relayAs = (liveTurnId: string, session: { callerOpenId?: string; quoteTargetId?: string; currentReplyTargetTurnId?: string }, extra: Record<string, unknown> = {}) => {
    const decision = authorizeV3SessionRunEditRequest({
      runId: RUN, mutation: 'edit',
      raw: { sessionId: 'sess-main', originCapability: capability, patch: BENIGN, base: 2 },
      trustedHost: false,
      session: {
        receiver: false, liveOrigin: { capability, turnId: liveTurnId, dispatchAttempt: 1 },
        chatId: BINDING.chatId, larkAppId: BINDING.larkAppId, rootMessageId: BINDING.rootMessageId, ...session,
      },
      selfLarkAppId: BINDING.larkAppId, baseDir, ...extra,
    });
    if (!decision.ok || !decision.edit) throw new Error(`relay refused: ${JSON.stringify(decision)}`);
    return decision.edit.caller;
  };

  const prepareWake = () => {
    seedRiskRun();
    issueWake(RUN, 2);
  };

  it('host: the initiator\'s queued message overtakes the wake turn — the wake turn still decides as the main bot', () => {
    writeSession(initiatorMessage);
    writeMarker(mintWorkflowEventTurnId(RUN, 2));
    const caller = () => {
      const authority = editAs();
      return { openId: authority.callerOpenId, origin: authority.origin };
    };
    prepareWake();
    expect(caller()).toEqual({ openId: INITIATOR, origin: 'runEvent' });
    rmSync(join(baseDir, RUN), { recursive: true, force: true });
    expectMainBotGrade(caller, prepareWake);
  });

  it('relay: the same', () => {
    const caller = () => relayAs(mintWorkflowEventTurnId(RUN, 2), {
      callerOpenId: INITIATOR, quoteTargetId: 'om_initiator_ack', currentReplyTargetTurnId: 'om_initiator_ack',
    });
    prepareWake();
    expect(caller()).toEqual({ openId: INITIATOR, origin: 'runEvent' });
    rmSync(join(baseDir, RUN), { recursive: true, force: true });
    expectMainBotGrade(caller, prepareWake);
  });

  it('the initiator\'s own message opening the turn is the one case that applies all of it directly', () => {
    seedRiskRun();
    issueWake(RUN, 2);
    writeSession(initiatorMessage);
    writeMarker('om_initiator_ack');
    const authority = editAs();
    expect(authority).toMatchObject({ origin: 'human', callerOpenId: INITIATOR });
    expect(applyEdit([...RISKY, ...RERUN_SPENT], { openId: authority.callerOpenId, origin: authority.origin }))
      .toMatchObject({ kind: 'applied', revision: 3 });
    expect(lastRevision()).toMatchObject({ by: INITIATOR, effects: { budgetGrants: [{ nodeId: 'd', tier: 'pair' }] } });
    expect(lastRevision()).not.toHaveProperty('auto');
  });

  describe('a scheduled turn', () => {
    const task = (ownerOpenId: string) => ({
      id: 'task1', larkAppId: BINDING.larkAppId, chatId: BINDING.chatId, rootMessageId: BINDING.rootMessageId,
      ownerOpenId, enabled: true, prompt: '每 30 分钟看一下 run，有失败就处理', schedule: '*/30 * * * *',
    });
    /** Host path: the CLI-side preflight reads the bot's schedules.json. */
    const writeTask = (ownerOpenId: string) => {
      const botHome = botHomePath(dirname(dataDir), BINDING.larkAppId);
      mkdirSync(botHome, { recursive: true });
      writeFileSync(join(botHome, 'schedules.json'), JSON.stringify({ task1: task(ownerOpenId) }));
    };
    /** The daemon wires BOTH relay verb families (start/cancel/retry/grant and
     *  status/edit) through the one schedule-auth factory — build the options
     *  exactly that way so the test fails if the factory stops carrying a
     *  primitive a scheduled turn needs. */
    const scheduleAuth = (ownerOpenId: string, isTurnLive = true) => v3ScheduleTurnRelayAuth({
      loadTask: () => task(ownerOpenId),
      isOwnerAllowed: () => true,
      isTurnLive: () => isTurnLive,
    });
    const relaySchedule = (ownerOpenId: string) => () => relayAs(SCHEDULE_TURN, {}, scheduleAuth(ownerOpenId));

    it('host: of the initiator\'s task — decided by the main bot, not the initiator', () => {
      writeTask(INITIATOR);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeMarker(SCHEDULE_TURN);
      const caller = () => {
        const authority = editAs();
        return { openId: authority.callerOpenId, origin: authority.origin };
      };
      seedRiskRun();
      expect(caller()).toEqual({ openId: INITIATOR, origin: 'runEvent' });
      rmSync(join(baseDir, RUN), { recursive: true, force: true });
      expectMainBotGrade(caller, seedRiskRun);
    });

    it('relay: the same', () => {
      seedRiskRun();
      expect(relaySchedule(INITIATOR)()).toEqual({ openId: INITIATOR, origin: 'runEvent' });
      rmSync(join(baseDir, RUN), { recursive: true, force: true });
      expectMainBotGrade(relaySchedule(INITIATOR), seedRiskRun);
    });

    it('of another member\'s task: that member\'s turn — every edit waits for the initiator', () => {
      seedRiskRun();
      writeTask(MEMBER);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeMarker(SCHEDULE_TURN);
      const authority = editAs();
      expect(authority).toMatchObject({ origin: 'human', callerOpenId: MEMBER });
      expect(applyEdit(BENIGN, { openId: authority.callerOpenId, origin: authority.origin }))
        .toMatchObject({ kind: 'proposed', reasons: ['callerNotInitiator'] });
      rmSync(join(baseDir, RUN), { recursive: true, force: true });
      seedRiskRun();
      expect(applyEdit(BENIGN, relaySchedule(MEMBER)())).toMatchObject({ kind: 'proposed', reasons: ['callerNotInitiator'] });
    });

    it('relay: status/edit and a mutation route authenticate the initiator\'s scheduled turn with the SAME factory primitives', () => {
      seedRiskRun();
      // status/edit over the relay (the verbs that initially shipped without
      // the scheduled-turn wiring).
      const statusDecision = authorizeV3SessionRunEditRequest({
        runId: RUN, mutation: 'status',
        raw: { sessionId: 'sess-main', originCapability: capability },
        trustedHost: false,
        session: {
          receiver: false, liveOrigin: { capability, turnId: SCHEDULE_TURN, dispatchAttempt: 1 },
          chatId: BINDING.chatId, larkAppId: BINDING.larkAppId, rootMessageId: BINDING.rootMessageId,
        },
        selfLarkAppId: BINDING.larkAppId, baseDir, ...scheduleAuth(INITIATOR),
      });
      expect(statusDecision).toMatchObject({ ok: true });
      // start/cancel/retry/grant through the mutation route with the same
      // factory output.
      const mutationDecision = authorizeV3SessionRunMutationRequest({
        runId: RUN, mutation: 'cancel',
        raw: { sessionId: 'sess-main', originCapability: capability },
        trustedHost: false,
        session: {
          receiver: false, liveOrigin: { capability, turnId: SCHEDULE_TURN, dispatchAttempt: 1 },
          chatId: BINDING.chatId, larkAppId: BINDING.larkAppId, rootMessageId: BINDING.rootMessageId,
        },
        selfLarkAppId: BINDING.larkAppId, baseDir, ...scheduleAuth(INITIATOR),
      });
      expect(mutationDecision).toMatchObject({ ok: true });
    });

    it('relay: without the factory primitives a scheduled turn fails closed for status/edit too', () => {
      seedRiskRun();
      const refused = authorizeV3SessionRunEditRequest({
        runId: RUN, mutation: 'edit',
        raw: { sessionId: 'sess-main', originCapability: capability, patch: BENIGN, base: 2 },
        trustedHost: false,
        session: {
          receiver: false, liveOrigin: { capability, turnId: SCHEDULE_TURN, dispatchAttempt: 1 },
          chatId: BINDING.chatId, larkAppId: BINDING.larkAppId, rootMessageId: BINDING.rootMessageId,
        },
        selfLarkAppId: BINDING.larkAppId, baseDir,
      });
      expect(refused).toMatchObject({ ok: false, status: 403, error: 'schedule_turn_unauthorized' });
    });

    it('the schedule owner gate: open bot admits everyone, a locked-down bot only its admins', () => {
      expect(v3RelayScheduleBotHasAllowlist({})).toBe(false);
      expect(v3RelayScheduleBotHasAllowlist({ p2pOpen: true })).toBe(true);
      expect(v3RelayScheduleBotHasAllowlist({ ownerOpenId: 'ou_owner' })).toBe(true);
      expect(v3RelayScheduleBotHasAllowlist({ allowedUsers: ['ou_owner'] })).toBe(true);
      expect(v3RelayScheduleBotHasAllowlist({ allowedChatGroups: ['oc_g'] })).toBe(true);
      expect(v3RelayScheduleBotHasAllowlist({ globalGrants: [{}] })).toBe(true);
      expect(v3RelayScheduleBotHasAllowlist({ allowedUsers: [], p2pOpen: false })).toBe(false);
    });

    // 源码结构护栏(K3)：status/edit relay 第一次上线就是漏了这三个定时回合
    // 依赖（沙盒主会话在发起人定时任务回合必 403）。两条 relay 路由都在
    // daemon.ts 闭包内、没有可起 daemon 的轻量行为 seam；钉死它们都必须经
    // 共享的 v3RelayScheduleAuth，不能各自手写一份。
    it('daemon wires BOTH relay verb families (mutations and status/edit) through the shared schedule-auth factory', () => {
      const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
      const spreadCount = source.match(/\.\.\.v3RelayScheduleAuth\(ds\)/g)?.length ?? 0;
      // One loop registers start/cancel/retry/grant, one loop registers
      // edit/status: exactly two call sites, zero ad-hoc copies.
      expect(spreadCount).toBe(2);
      expect(source).not.toContain('isScheduledTurnLive: turnId =>');
      expect(source).not.toContain('isScheduleOwnerAllowed: (larkAppId, ownerOpenId)');
      expect(source).not.toContain('loadScheduledTask: (appId, taskId)');
    });
  });
});
