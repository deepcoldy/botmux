import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approveAndClaimVcMeetingAction,
  beginVcMeetingAction,
  claimVcMeetingActionAttempt,
  claimVcMeetingApprovalCardAttempt,
  deriveVcMeetingApprovalCardKey,
  deriveVcMeetingActionId,
  deriveVcMeetingProviderKey,
  findVcMeetingAction,
  finishVcMeetingAction,
  finishVcMeetingApprovalCard,
  isVcMeetingActionTerminal,
  listVcMeetingActions,
  listVcMeetingActionScopes,
  markVcMeetingActionPendingApproval,
  reconcileVcMeetingActionsOnBoot,
  rejectVcMeetingAction,
  resolveVcMeetingActionApproval,
  type VcMeetingActionBeginInput,
  type VcMeetingActionRecord,
  type VcMeetingActionRef,
} from '../src/services/vc-meeting-action-store.js';

const LISTENER = 'cli_listener';
const MEETING = 'meeting-1';

function action(overrides: Partial<VcMeetingActionBeginInput> = {}): VcMeetingActionBeginInput {
  return {
    listenerAppId: LISTENER,
    meetingId: MEETING,
    memberId: 'member-speaker',
    memberEpoch: 2,
    agentAppId: 'cli_agent',
    ownerGeneration: 7,
    source: { kind: 'delivery', key: 'vc_delivery_123', deliverySeq: 9 },
    sink: 'meeting_text',
    actionSlot: 'primary',
    canonicalInput: { content: 'hello', format: 'text' },
    ...overrides,
  };
}

function expectRecord(result: ReturnType<typeof beginVcMeetingAction>): VcMeetingActionRecord {
  expect(result.kind).not.toBe('conflict');
  return (result as Extract<typeof result, { record: unknown }>).record;
}

function ref(record: VcMeetingActionRecord, overrides: Partial<VcMeetingActionRef> = {}): VcMeetingActionRef {
  return {
    listenerAppId: record.listenerAppId,
    meetingId: record.meetingId,
    actionId: record.actionId,
    inputHash: record.inputHash,
    ...overrides,
  };
}

describe('vc meeting action store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-vc-action-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives a bounded deterministic identity from the protocol tuple only', () => {
    const base = action();
    const id1 = expectRecord(beginVcMeetingAction(dir, base, 100)).actionId;
    const id2 = deriveVcMeetingActionId({
      meetingId: base.meetingId,
      memberId: base.memberId,
      memberEpoch: base.memberEpoch,
      source: base.source,
      sink: base.sink,
      actionSlot: 'primary',
    });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^vca_[0-9a-f]{46}$/);
    expect(id1).toHaveLength(50);

    // The sink-owner-generation snapshot (`ownerGeneration`), agentAppId,
    // listenerAppId, content and deliverySeq are metadata, not effect identity.
    const replay = expectRecord(beginVcMeetingAction(dir, action({
      ownerGeneration: 99,
      agentAppId: 'stale-agent-snapshot',
      listenerAppId: LISTENER,
      source: { kind: 'delivery', key: 'vc_delivery_123', deliverySeq: 999 },
      canonicalInput: { format: 'text', content: 'hello' },
    }), 200));
    expect(replay.actionId).toBe(id1);
    expect(replay.ownerGeneration).toBe(7);

    const differentKind = expectRecord(beginVcMeetingAction(dir, action({
      source: { kind: 'im_turn', key: 'vc_delivery_123', larkMessageId: 'om_1' },
    }), 300));
    expect(differentKind.actionId).not.toBe(id1);
  });

  it('derives a stable provider key independent of payload', () => {
    const first = expectRecord(beginVcMeetingAction(dir, action(), 100));
    expect(first.providerKey).toBe(deriveVcMeetingProviderKey(first.actionId));
    expect(first.providerKey).toMatch(/^vcp_[0-9a-f]{46}$/);
    expect(first.providerKey).toHaveLength(50);
    expect(expectRecord(beginVcMeetingAction(dir, action(), 200)).providerKey).toBe(first.providerKey);
  });

  it('canonicalizes input and returns exact replays without mutating the original record', () => {
    const first = beginVcMeetingAction(dir, action({
      canonicalInput: { z: 1, omitted: undefined, nested: { b: 2, a: 1 } },
    }), 100);
    expect(first.kind).toBe('created');
    const firstRecord = expectRecord(first);
    expect(firstRecord.canonicalInput).toEqual({ nested: { a: 1, b: 2 }, z: 1 });

    const replay = beginVcMeetingAction(dir, action({
      ownerGeneration: 1,
      canonicalInput: { nested: { a: 1, b: 2 }, z: 1 },
    }), 200);
    expect(replay.kind).toBe('existing');
    expect(expectRecord(replay)).toMatchObject({
      createdAt: 100,
      updatedAt: 100,
      ownerGeneration: 7,
      status: 'requested',
    });
  });

  it('rejects same identity with changed canonical input', () => {
    const first = expectRecord(beginVcMeetingAction(dir, action(), 100));
    const conflict = beginVcMeetingAction(dir, action({
      canonicalInput: { content: 'different', format: 'text' },
    }), 200);
    expect(conflict).toMatchObject({
      kind: 'conflict',
      reason: 'input_mismatch',
      actionId: first.actionId,
    });
    expect((conflict as Extract<typeof conflict, { kind: 'conflict' }>).record?.inputHash).toBe(first.inputHash);
  });

  it('rejects free-form slots and malformed canonical inputs', () => {
    const unsupported = beginVcMeetingAction(dir, {
      ...action(),
      actionSlot: 'retry' as 'primary',
    });
    expect(unsupported).toMatchObject({ kind: 'conflict', reason: 'unsupported_slot' });

    expect(beginVcMeetingAction(dir, action({ canonicalInput: new Date() }))).toMatchObject({
      kind: 'conflict',
      reason: 'invalid',
    });
    expect(beginVcMeetingAction(dir, action({ memberEpoch: 0 }))).toMatchObject({
      kind: 'conflict',
      reason: 'invalid',
    });
    expect(beginVcMeetingAction(dir, action({
      source: {
        kind: 'delivery', key: 'delivery-key', deliverySeq: 3, extra: 'poison',
      } as unknown as VcMeetingActionBeginInput['source'],
    }))).toMatchObject({ kind: 'conflict', reason: 'invalid' });
  });

  it('persists one 0600 snapshot per listener/meeting binding', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    const actionDir = join(dir, 'vc-meeting-actions');
    const files = readdirSync(actionDir).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const fp = join(actionDir, files[0]!);
    expect(statSync(fp).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(fp, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      listenerAppId: LISTENER,
      meetingId: MEETING,
    });

    expect(findVcMeetingAction(dir, { listenerAppId: 'another-listener', meetingId: MEETING }, record.actionId))
      .toBeUndefined();
  });

  it('keeps identical action ids isolated by listener scope', () => {
    const first = expectRecord(beginVcMeetingAction(dir, action({ listenerAppId: 'listener-a' }), 100));
    const second = expectRecord(beginVcMeetingAction(dir, action({ listenerAppId: 'listener-b' }), 100));
    expect(second.actionId).toBe(first.actionId);
    expect(second.listenerAppId).toBe('listener-b');
    expect(listVcMeetingActions(dir, { listenerAppId: 'listener-a', meetingId: MEETING })).toHaveLength(1);
    expect(listVcMeetingActions(dir, { listenerAppId: 'listener-b', meetingId: MEETING })).toHaveLength(1);
    expect(listVcMeetingActionScopes(dir)).toEqual([
      { listenerAppId: 'listener-a', meetingId: MEETING },
      { listenerAppId: 'listener-b', meetingId: MEETING },
    ]);
  });

  it('claims provider execution exactly once after the attempting write-ahead', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    const claimed = claimVcMeetingActionAttempt(dir, ref(record), 200);
    expect(claimed).toMatchObject({
      kind: 'claimed',
      record: { status: 'attempting', attemptCount: 1, attemptedAt: 200 },
    });
    expect(findVcMeetingAction(dir, { listenerAppId: LISTENER, meetingId: MEETING }, record.actionId))
      .toMatchObject({ status: 'attempting', attemptCount: 1 });

    const concurrent = claimVcMeetingActionAttempt(dir, ref(record), 201);
    expect(concurrent).toMatchObject({ kind: 'existing', record: { status: 'attempting', attemptCount: 1 } });
  });

  it('terminally rejects a requested action without manufacturing an approval card', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    const rejected = rejectVcMeetingAction(dir, ref(record), { errorCode: 'not_sink_owner' }, 110);
    expect(rejected).toMatchObject({
      kind: 'updated',
      record: {
        status: 'rejected',
        errorCode: 'not_sink_owner',
        finishedAt: 110,
      },
    });
    expect((rejected as Extract<typeof rejected, { record: unknown }>).record).not.toHaveProperty('approvalCard');
    expect(rejectVcMeetingAction(dir, ref(record), { errorCode: 'changed' }, 120)).toMatchObject({
      kind: 'existing',
      record: { status: 'rejected', errorCode: 'not_sink_owner', finishedAt: 110 },
    });
    expect(claimVcMeetingActionAttempt(dir, ref(record), 130)).toMatchObject({
      kind: 'existing',
      record: { status: 'rejected' },
    });
  });

  it('does not claim pending approval and claims after approval', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    const pending = markVcMeetingActionPendingApproval(dir, ref(record), 110);
    expect(pending).toMatchObject({
      kind: 'updated',
      record: {
        status: 'pendingApproval',
        approvalCard: { status: 'requested', attemptCount: 0 },
      },
    });
    const approvalKey = deriveVcMeetingApprovalCardKey(record.actionId);
    expect((pending as Extract<typeof pending, { record: unknown }>).record.approvalCard?.providerKey)
      .toBe(approvalKey);
    expect(claimVcMeetingActionAttempt(dir, ref(record), 120)).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_transition',
    });

    expect(claimVcMeetingApprovalCardAttempt(dir, ref(record), 121)).toMatchObject({
      kind: 'claimed',
      record: {
        approvalCard: { providerKey: approvalKey, status: 'attempting', attemptCount: 1, attemptedAt: 121 },
      },
    });
    expect(claimVcMeetingApprovalCardAttempt(dir, ref(record), 122)).toMatchObject({
      kind: 'existing',
      record: { approvalCard: { status: 'attempting', attemptCount: 1 } },
    });
    expect(finishVcMeetingApprovalCard(dir, ref(record), {
      status: 'presented',
      externalRefs: { approvalMessageId: 'om_approval' },
    }, 123)).toMatchObject({
      kind: 'updated',
      record: { approvalCard: { status: 'presented', finishedAt: 123 } },
    });
    // Terminal card replay may enrich provider evidence without changing state.
    expect(finishVcMeetingApprovalCard(dir, ref(record), {
      status: 'presented',
      externalRefs: {
        approvalMessageId: 'om_late_duplicate_must_not_win',
        approvalCardId: 'card_1',
      },
    }, 124)).toMatchObject({
      kind: 'updated',
      record: {
        approvalCard: {
          status: 'presented',
          externalRefs: { approvalMessageId: 'om_approval', approvalCardId: 'card_1' },
        },
      },
    });
    expect(resolveVcMeetingActionApproval(dir, ref(record), 'approved', {
      externalRefs: { approvalMessageId: 'om_approval' },
    }, 130)).toMatchObject({ kind: 'updated', record: { status: 'approved' } });
    expect(claimVcMeetingActionAttempt(dir, ref(record), 140)).toMatchObject({
      kind: 'claimed',
      record: { status: 'attempting' },
    });
  });

  it('atomically approves and write-ahead claims without exposing approved state', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    markVcMeetingActionPendingApproval(dir, ref(record), 110);
    expect(approveAndClaimVcMeetingAction(dir, ref(record), {
      externalRefs: { operatorOpenId: 'ou_operator' },
    }, 120)).toMatchObject({
      kind: 'claimed',
      record: {
        status: 'attempting',
        attemptCount: 1,
        attemptedAt: 120,
        externalRefs: { operatorOpenId: 'ou_operator' },
      },
    });
    expect(approveAndClaimVcMeetingAction(dir, ref(record), {}, 130)).toMatchObject({
      kind: 'existing',
      record: { status: 'attempting', attemptCount: 1 },
    });
  });

  it.each(['rejected', 'expired'] as const)('terminalizes approval as %s', (decision) => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    markVcMeetingActionPendingApproval(dir, ref(record), 110);
    const terminal = resolveVcMeetingActionApproval(
      dir,
      ref(record),
      decision,
      { errorCode: `approval_${decision}` },
      120,
    );
    expect(terminal).toMatchObject({
      kind: 'updated',
      record: { status: decision, finishedAt: 120, errorCode: `approval_${decision}` },
    });
    expect(claimVcMeetingActionAttempt(dir, ref(record), 130)).toMatchObject({
      kind: 'existing',
      record: { status: decision },
    });
  });

  it.each(['succeeded', 'failed', 'unknown'] as const)('finishes an attempt as %s and preserves terminal state', (status) => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    claimVcMeetingActionAttempt(dir, ref(record), 110);
    const finished = finishVcMeetingAction(dir, ref(record), {
      status,
      externalRefs: { providerMessageId: 'provider-1' },
      errorCode: status === 'succeeded' ? undefined : `provider_${status}`,
    }, 120);
    expect(finished).toMatchObject({
      kind: 'updated',
      record: {
        status,
        finishedAt: 120,
        externalRefs: { providerMessageId: 'provider-1' },
      },
    });
    expect(isVcMeetingActionTerminal(status)).toBe(true);

    // A late contradictory callback cannot rewrite a terminal audit result.
    expect(finishVcMeetingAction(dir, ref(record), { status: 'succeeded' }, 130)).toMatchObject({
      kind: 'existing',
      record: { status },
    });

    // Ledger lookup precedes current fencing: an exact replay carrying a stale
    // sink-owner generation receives the terminal result instead of minting a
    // new effect.
    expect(beginVcMeetingAction(dir, action({ ownerGeneration: 1 }), 140)).toMatchObject({
      kind: 'existing',
      record: { actionId: record.actionId, status, ownerGeneration: 7 },
    });
  });

  it('preserves and merges approval/provider external refs across finish replay', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    markVcMeetingActionPendingApproval(dir, ref(record), 110);
    resolveVcMeetingActionApproval(dir, ref(record), 'approved', {
      externalRefs: { approvalMessageId: 'om_approval' },
    }, 120);
    claimVcMeetingActionAttempt(dir, ref(record), 130);
    expect(finishVcMeetingAction(dir, ref(record), {
      status: 'succeeded',
      externalRefs: { providerMessageId: 'om_output' },
    }, 140)).toMatchObject({
      kind: 'updated',
      record: {
        externalRefs: { approvalMessageId: 'om_approval', providerMessageId: 'om_output' },
      },
    });
    expect(finishVcMeetingAction(dir, ref(record), {
      status: 'succeeded',
      externalRefs: {
        providerMessageId: 'om_late_duplicate_must_not_win',
        lookupEvidence: 'confirmed',
      },
    }, 150)).toMatchObject({
      kind: 'updated',
      record: {
        status: 'succeeded',
        finishedAt: 140,
        externalRefs: {
          approvalMessageId: 'om_approval',
          providerMessageId: 'om_output',
          lookupEvidence: 'confirmed',
        },
      },
    });
  });

  it('expires a legacy approved crash residue instead of executing it on boot', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    markVcMeetingActionPendingApproval(dir, ref(record), 110);
    expect(resolveVcMeetingActionApproval(dir, ref(record), 'approved', {}, 120)).toMatchObject({
      kind: 'updated',
      record: { status: 'approved', attemptCount: 0 },
    });

    const reconciled = reconcileVcMeetingActionsOnBoot(
      dir,
      { listenerAppId: LISTENER, meetingId: MEETING },
      130,
    );
    expect(reconciled.providerAttempts).toEqual([]);
    expect(reconciled.terminalizedExpired).toMatchObject([{
      actionId: record.actionId,
      status: 'expired',
      attemptCount: 0,
      errorCode: 'approval_revalidation_required_after_restart',
      finishedAt: 130,
    }]);
  });

  it('guards transitions with the immutable input hash', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    expect(claimVcMeetingActionAttempt(dir, ref(record, { inputHash: 'sha256:wrong' }), 110)).toMatchObject({
      kind: 'conflict',
      reason: 'input_mismatch',
      record: { status: 'requested' },
    });
    expect(finishVcMeetingAction(dir, ref(record), { status: 'succeeded' }, 120)).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_transition',
    });
  });

  it('lists deterministically and filters by status, member, and sink', () => {
    const a = expectRecord(beginVcMeetingAction(dir, action(), 200));
    const b = expectRecord(beginVcMeetingAction(dir, action({
      memberId: 'member-task',
      source: { kind: 'delivery', key: 'delivery-task', deliverySeq: 1 },
      sink: 'task',
      canonicalInput: { mode: 'sync', items: [] },
    }), 100));
    claimVcMeetingActionAttempt(dir, ref(a), 210);

    const scope = { listenerAppId: LISTENER, meetingId: MEETING };
    expect(listVcMeetingActions(dir, scope).map((record) => record.actionId)).toEqual([b.actionId, a.actionId]);
    expect(listVcMeetingActions(dir, scope, { status: 'attempting' })).toMatchObject([{ actionId: a.actionId }]);
    expect(listVcMeetingActions(dir, scope, { memberId: 'member-task', sink: 'task' }))
      .toMatchObject([{ actionId: b.actionId }]);
  });

  it('reconciles voice as unknown but returns stable work for retryable/lookup-capable providers', () => {
    const voice = expectRecord(beginVcMeetingAction(dir, action({ sink: 'meeting_voice' }), 100));
    const reconcilableSinks = ['meeting_text', 'listener_chat', 'task', 'attention_dm'] as const;
    const reconcilable = reconcilableSinks.map((sink, index) => expectRecord(beginVcMeetingAction(dir, action({
      sink,
      source: { kind: 'delivery', key: `delivery-${sink}`, deliverySeq: 10 + index },
    }), 101 + index)));
    const untouched = expectRecord(beginVcMeetingAction(dir, action({
      source: { kind: 'delivery', key: 'delivery-requested', deliverySeq: 11 },
    }), 110));
    claimVcMeetingActionAttempt(dir, ref(voice), 110);
    reconcilable.forEach((record, index) => claimVcMeetingActionAttempt(dir, ref(record), 120 + index));

    const reconciled = reconcileVcMeetingActionsOnBoot(
      dir,
      { listenerAppId: LISTENER, meetingId: MEETING },
      500,
    );
    expect(reconciled.terminalizedUnknown).toMatchObject([{ actionId: voice.actionId, status: 'unknown' }]);
    expect(reconciled.providerAttempts).toHaveLength(reconcilable.length);
    expect(reconciled.providerAttempts.map((work) => work.sink).sort()).toEqual([...reconcilableSinks].sort());
    for (const work of reconciled.providerAttempts) {
      expect(work).toMatchObject({
        mode: 'lookup_or_idempotent_retry',
        providerKey: deriveVcMeetingProviderKey(work.actionId),
      });
    }
    expect(findVcMeetingAction(dir, { listenerAppId: LISTENER, meetingId: MEETING }, voice.actionId))
      .toMatchObject({
        status: 'unknown',
        finishedAt: 500,
        errorCode: 'provider_result_unknown_manual_review',
      });
    for (const record of reconcilable) {
      expect(findVcMeetingAction(dir, { listenerAppId: LISTENER, meetingId: MEETING }, record.actionId))
        .toMatchObject({ status: 'attempting' });
    }
    expect(findVcMeetingAction(dir, { listenerAppId: LISTENER, meetingId: MEETING }, untouched.actionId))
      .toMatchObject({ status: 'requested' });

    const repeated = reconcileVcMeetingActionsOnBoot(
      dir,
      { listenerAppId: LISTENER, meetingId: MEETING },
      600,
    );
    expect(repeated.terminalizedUnknown).toEqual([]);
    expect(repeated.providerAttempts).toHaveLength(reconcilable.length);
  });

  it('rebuilds approval card work before claim and reconciles ambiguous card attempts', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    markVcMeetingActionPendingApproval(dir, ref(record), 110);

    const beforeClaim = reconcileVcMeetingActionsOnBoot(
      dir,
      { listenerAppId: LISTENER, meetingId: MEETING },
      200,
    );
    expect(beforeClaim.approvalCards).toEqual([expect.objectContaining({
      actionId: record.actionId,
      approvalProviderKey: deriveVcMeetingApprovalCardKey(record.actionId),
      status: 'requested',
      mode: 'claim_then_send',
    })]);

    claimVcMeetingApprovalCardAttempt(dir, ref(record), 210);
    const afterAmbiguousSend = reconcileVcMeetingActionsOnBoot(
      dir,
      { listenerAppId: LISTENER, meetingId: MEETING },
      220,
    );
    expect(afterAmbiguousSend.approvalCards).toEqual([expect.objectContaining({
      actionId: record.actionId,
      approvalProviderKey: deriveVcMeetingApprovalCardKey(record.actionId),
      status: 'attempting',
      attemptedAt: 210,
      mode: 'lookup_or_idempotent_retry',
    })]);
    expect(findVcMeetingAction(dir, { listenerAppId: LISTENER, meetingId: MEETING }, record.actionId))
      .toMatchObject({ status: 'pendingApproval', approvalCard: { status: 'attempting' } });
  });

  it.each([
    ['map key', (state: any, key: string) => {
      state.actions.not_the_action_id = state.actions[key];
      delete state.actions[key];
    }],
    ['record scope', (state: any, key: string) => { state.actions[key].listenerAppId = 'wrong-listener'; }],
    ['record actionId', (state: any, key: string) => { state.actions[key].actionId = 'vca_tampered'; }],
    ['derived actionId tuple', (state: any, key: string) => { state.actions[key].memberId = 'other-member'; }],
    ['inputHash', (state: any, key: string) => { state.actions[key].inputHash = 'sha256:tampered'; }],
    ['canonical input', (state: any, key: string) => { state.actions[key].canonicalInput.content = 'tampered'; }],
    ['providerKey', (state: any, key: string) => { state.actions[key].providerKey = 'vcp_tampered'; }],
    ['slot enum', (state: any, key: string) => { state.actions[key].actionSlot = 'retry'; }],
    ['sink enum', (state: any, key: string) => { state.actions[key].sink = 'email'; }],
    ['status enum', (state: any, key: string) => { state.actions[key].status = 'done'; }],
    ['source shape', (state: any, key: string) => { state.actions[key].source.extra = 'smuggled'; }],
  ])('fails closed on strict record validation: %s', (_label, corrupt) => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    const actionDir = join(dir, 'vc-meeting-actions');
    const fp = join(actionDir, readdirSync(actionDir).find((name) => name.endsWith('.json'))!);
    const state = JSON.parse(readFileSync(fp, 'utf8'));
    corrupt(state, record.actionId);
    writeFileSync(fp, JSON.stringify(state), 'utf8');

    expect(() => listVcMeetingActions(dir, { listenerAppId: LISTENER, meetingId: MEETING }))
      .toThrow(/action|ledger|mismatch|invalid/);
  });

  it('strictly validates the nested approval-card provider identity', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    markVcMeetingActionPendingApproval(dir, ref(record), 110);
    const actionDir = join(dir, 'vc-meeting-actions');
    const fp = join(actionDir, readdirSync(actionDir).find((name) => name.endsWith('.json'))!);
    const state = JSON.parse(readFileSync(fp, 'utf8'));
    state.actions[record.actionId].approvalCard.providerKey = 'vcc_tampered';
    writeFileSync(fp, JSON.stringify(state), 'utf8');

    expect(() => reconcileVcMeetingActionsOnBoot(dir, { listenerAppId: LISTENER, meetingId: MEETING }))
      .toThrow(/approval card/);
  });

  it('fails closed when the durable ledger is corrupt', () => {
    const record = expectRecord(beginVcMeetingAction(dir, action(), 100));
    const actionDir = join(dir, 'vc-meeting-actions');
    const fp = join(actionDir, readdirSync(actionDir).find((name) => name.endsWith('.json'))!);
    writeFileSync(fp, '{not-json', 'utf8');

    expect(() => findVcMeetingAction(
      dir,
      { listenerAppId: LISTENER, meetingId: MEETING },
      record.actionId,
    )).toThrow(/ledger is unreadable/);
    expect(() => beginVcMeetingAction(dir, action(), 200)).toThrow(/ledger is unreadable/);
  });
});
