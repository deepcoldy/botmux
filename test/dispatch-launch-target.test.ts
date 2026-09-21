import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  DISPATCH_LAUNCH_SCHEMA_VERSION,
  canonicalizeDispatchLaunchKickoff,
  dispatchLaunchIdentityDigest,
  dispatchLaunchPolicyDigest,
  type DispatchLaunchIdentityV1,
  type DispatchLaunchPrepareRequestV1,
} from '../src/core/dispatch-launch-contract.js';
import { createDispatchLaunchAdmissionStore } from '../src/core/dispatch-launch-admission-store.js';
import { createDispatchLaunchOperationStore } from '../src/core/dispatch-launch-operation-store.js';
import { createDispatchLaunchTargetCoordinator } from '../src/core/dispatch-launch-target.js';

const DISPATCH_ID = `dl_${'1'.repeat(32)}`;
const SHA = `sha256:${'a'.repeat(64)}`;
const policy = {
  schemaVersion: 1 as const, enabled: true, allowedSourceAppIds: ['cli_source'],
  allowedModels: ['gpt-5.6-sol'], allowedReasoningEfforts: ['high' as const],
};
const identity: DispatchLaunchIdentityV1 = {
  cliId: 'codex', cliRuntimeDigest: SHA, executable: 'codex', backendType: 'pty',
  codexRpcInput: false, existingAppServer: false, botConfigDigest: SHA,
  policyDigest: dispatchLaunchPolicyDigest(policy),
};

function request(expiresAt = '2026-09-03T11:00:00.000Z'): DispatchLaunchPrepareRequestV1 {
  return {
    schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION, protocol: 'v1', dispatchId: DISPATCH_ID,
    source: { larkAppId: 'cli_source', sessionId: 'source-session', turnId: 'source-turn' },
    targetLarkAppId: 'cli_target', chatId: 'oc_chat',
    kickoff: canonicalizeDispatchLaunchKickoff({
      title: 'Task', brief: 'Implement it', sourceDisplay: 'Source', targetLarkAppId: 'cli_target',
    }),
    requestedOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' }, expiresAt,
  };
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-target-'));
  const operationStore = createDispatchLaunchOperationStore({ dataDir, ownerLarkAppId: 'cli_target' });
  const admissionStore = createDispatchLaunchAdmissionStore({ dataDir, targetLarkAppId: 'cli_target' });
  const effects = {
    quota: vi.fn(async () => ({ allow: true })),
    root: vi.fn(async () => 'om_root'),
    session: vi.fn(async () => ({ sessionId: 'target-session' })),
    worker: vi.fn(async () => ({ kickoffTurnId: 'source-turn', workerGeneration: 1 })),
  };
  const now = vi.fn(() => new Date('2026-09-03T10:00:00.000Z'));
  const coordinator = createDispatchLaunchTargetCoordinator({
    target: { larkAppId: 'cli_target', cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', policy },
    operationStore, admissionStore, now, resolveIdentity: () => identity,
    resolveWorkingDir: () => '/repo', resolveChatType: async () => 'group', capacityAvailable: () => true,
    resolveSourceOpenId: async () => 'ou_source',
    authorizeTalk: () => ({ allowed: true, reason: 'chatGrant', quotaKey: 'chat:oc_chat:ou_source', grantChatId: 'oc_chat' }),
    consumeQuotaOnce: effects.quota, ensureRoot: effects.root, ensureSession: effects.session, ensureWorker: effects.worker,
  });
  return { coordinator, operationStore, admissionStore, effects, now };
}

describe('dispatch launch target coordinator', () => {
  it('prepares and starts idempotently through durable side-effect checkpoints', async () => {
    const { coordinator, admissionStore, effects } = setup();
    const prepared = await coordinator.prepare(request());
    expect(prepared).toMatchObject({ ok: true, operation: { state: 'prepared' } });
    expect(await coordinator.prepare(request())).toEqual(prepared);
    const operation = prepared.ok ? prepared.operation : undefined;
    expect(operation && 'launchIdentity' in operation).toBe(true);
    const started = await coordinator.start({
      schemaVersion: 1, protocol: 'v1', dispatchId: DISPATCH_ID,
      kickoffDigest: request().kickoff.digest, policyDigest: identity.policyDigest,
      launchIdentityDigest: dispatchLaunchIdentityDigest(identity),
    });
    expect(started).toMatchObject({
      ok: true, operation: { state: 'awaiting_proof', rootMessageId: 'om_root', targetSessionId: 'target-session', workerGeneration: 1 },
    });
    expect(admissionStore.get(DISPATCH_ID)?.state).toBe('committed');
    expect(await coordinator.start({
      schemaVersion: 1, protocol: 'v1', dispatchId: DISPATCH_ID,
      kickoffDigest: request().kickoff.digest, policyDigest: identity.policyDigest,
      launchIdentityDigest: dispatchLaunchIdentityDigest(identity),
    })).toEqual(started);
    expect(effects.quota).toHaveBeenCalledTimes(1);
    expect(effects.root).toHaveBeenCalledTimes(1);
    expect(effects.session).toHaveBeenCalledTimes(1);
    expect(effects.worker).toHaveBeenCalledTimes(1);
  });

  it('fails closed before admission when target policy denies the source', async () => {
    const { coordinator, admissionStore, operationStore } = setup();
    const denied = request();
    denied.source.larkAppId = 'cli_other';
    expect(await coordinator.prepare(denied)).toMatchObject({ ok: false, errorCode: 'UNAUTHORIZED_SOURCE' });
    expect(operationStore.get(DISPATCH_ID)?.state).toBe('failed');
    expect(admissionStore.get(DISPATCH_ID)).toBeUndefined();
  });

  it('expires a prepared operation without running side effects', async () => {
    const { coordinator, effects, now } = setup();
    const prepared = await coordinator.prepare(request('2026-09-03T10:01:00.000Z'));
    expect(prepared.ok).toBe(true);
    now.mockReturnValue(new Date('2026-09-03T10:02:00.000Z'));
    const started = await coordinator.start({
      schemaVersion: 1, protocol: 'v1', dispatchId: DISPATCH_ID, kickoffDigest: request().kickoff.digest,
      policyDigest: identity.policyDigest, launchIdentityDigest: dispatchLaunchIdentityDigest(identity),
    });
    expect(started).toMatchObject({ ok: true, operation: { state: 'failed', errorCode: 'OPERATION_EXPIRED' } });
    expect(effects.root).not.toHaveBeenCalled();
  });

  it('recovers a crash between durable admission and prepared transition', async () => {
    const { coordinator, admissionStore, operationStore } = setup();
    const base = request();
    operationStore.create({
      schemaVersion: 1, dispatchId: DISPATCH_ID, owner: 'target', sourceLarkAppId: 'cli_source',
      sourceSessionId: 'source-session', sourceTurnId: 'source-turn', targetLarkAppId: 'cli_target',
      chatId: 'oc_chat', kickoff: base.kickoff, requestedOverride: base.requestedOverride,
      createdAt: '2026-09-03T10:00:00.000Z', updatedAt: '2026-09-03T10:00:00.000Z',
      expiresAt: base.expiresAt, state: 'preparing',
    });
    admissionStore.authorize({
      schemaVersion: 1, dispatchId: DISPATCH_ID, state: 'authorized', sourceLarkAppId: 'cli_source',
      sourceSessionId: 'source-session', sourceTurnId: 'source-turn', sourceOpenId: 'ou_source',
      chatType: 'group', talkReason: 'chatGrant', chatId: 'oc_chat', targetLarkAppId: 'cli_target',
      policyDigest: identity.policyDigest, effectiveOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      launchIdentity: identity, talkAuthorizationReceiptId: 'talk-receipt', quotaReceiptId: 'quota-receipt',
      workingDir: '/repo', capacityReservationId: 'capacity-receipt', createdAt: '2026-09-03T10:00:00.000Z',
    });
    expect(await coordinator.prepare(base)).toMatchObject({ ok: true, operation: { state: 'prepared' } });
  });

  it('fails closed when a recovery receipt does not match the current frozen launch identity', async () => {
    const { coordinator, admissionStore, operationStore } = setup();
    const base = request();
    operationStore.create({
      schemaVersion: 1, dispatchId: DISPATCH_ID, owner: 'target', sourceLarkAppId: 'cli_source',
      sourceSessionId: 'source-session', sourceTurnId: 'source-turn', targetLarkAppId: 'cli_target',
      chatId: 'oc_chat', kickoff: base.kickoff, requestedOverride: base.requestedOverride,
      createdAt: '2026-09-03T10:00:00.000Z', updatedAt: '2026-09-03T10:00:00.000Z',
      expiresAt: base.expiresAt, state: 'preparing',
    });
    admissionStore.authorize({
      schemaVersion: 1, dispatchId: DISPATCH_ID, state: 'authorized', sourceLarkAppId: 'cli_source',
      sourceSessionId: 'source-session', sourceTurnId: 'source-turn', sourceOpenId: 'ou_source',
      chatType: 'group', talkReason: 'chatGrant', chatId: 'oc_chat', targetLarkAppId: 'cli_target',
      policyDigest: identity.policyDigest, effectiveOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      launchIdentity: { ...identity, executable: '/stale/codex' },
      talkAuthorizationReceiptId: 'talk-receipt', quotaReceiptId: 'quota-receipt',
      workingDir: '/repo', capacityReservationId: 'capacity-receipt', createdAt: '2026-09-03T10:00:00.000Z',
    });
    expect(await coordinator.prepare(base)).toMatchObject({ ok: false, errorCode: 'OPERATION_CONFLICT' });
    expect(operationStore.get(DISPATCH_ID)).toMatchObject({ state: 'failed', errorCode: 'OPERATION_CONFLICT' });
  });
});
