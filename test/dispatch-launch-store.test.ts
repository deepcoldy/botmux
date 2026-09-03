import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION,
  DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION,
  canonicalizeDispatchLaunchKickoff,
  type DispatchLaunchAdmissionReceiptV1,
  type DispatchLaunchOperationV1,
} from '../src/core/dispatch-launch-contract.js';
import {
  DispatchLaunchAdmissionConflictError,
  createDispatchLaunchAdmissionStore,
} from '../src/core/dispatch-launch-admission-store.js';
import {
  DispatchLaunchOperationConflictError,
  createDispatchLaunchOperationStore,
} from '../src/core/dispatch-launch-operation-store.js';

const NOW = '2026-09-03T10:00:00.000Z';
const LATER = '2026-09-03T10:05:00.000Z';
const SHA = `sha256:${'a'.repeat(64)}`;
const DISPATCH_ID = `dl_${'b'.repeat(32)}`;

function operation(state: DispatchLaunchOperationV1['state'] = 'created'): DispatchLaunchOperationV1 {
  const base = {
    schemaVersion: DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION,
    dispatchId: DISPATCH_ID,
    owner: 'source' as const,
    sourceLarkAppId: 'cli_source',
    sourceSessionId: 'source-session',
    sourceTurnId: 'source-turn',
    targetLarkAppId: 'cli_target',
    chatId: 'oc_chat',
    kickoff: canonicalizeDispatchLaunchKickoff({
      title: 'Task', brief: 'Do it', sourceDisplay: 'Source', targetLarkAppId: 'cli_target',
    }),
    requestedOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' as const },
    createdAt: NOW, updatedAt: NOW, expiresAt: LATER,
  };
  if (state === 'created' || state === 'preparing') return { ...base, state };
  const admitted = {
    ...base, state,
    effectiveOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' as const },
    launchIdentity: {
      cliId: 'codex' as const, cliRuntimeDigest: SHA, executable: 'codex',
      backendType: 'pty' as const, codexRpcInput: false as const, existingAppServer: false as const,
      botConfigDigest: SHA, policyDigest: SHA,
    },
  };
  if (state === 'prepared' || state === 'starting') return admitted;
  if (state === 'failed') return { ...admitted, state, errorCode: 'INTERNAL_ERROR' };
  throw new Error(`unsupported test state ${state}`);
}

function receipt(): DispatchLaunchAdmissionReceiptV1 {
  return {
    schemaVersion: DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION,
    dispatchId: DISPATCH_ID, state: 'authorized', sourceLarkAppId: 'cli_source',
    sourceSessionId: 'source-session', sourceTurnId: 'source-turn', callerUnionId: 'on_caller',
    sourceOpenId: 'ou_source', chatType: 'group', talkReason: 'chatGrant',
    chatId: 'oc_chat', targetLarkAppId: 'cli_target', policyDigest: SHA,
    effectiveOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    launchIdentity: operation('prepared').launchIdentity,
    talkAuthorizationReceiptId: 'talk-receipt', quotaReceiptId: 'quota-receipt',
    workingDir: '/repo', capacityReservationId: 'capacity-receipt', createdAt: NOW,
  };
}

describe('dispatch launch operation store', () => {
  it('creates idempotently, persists CAS transitions, and enumerates only recoverable operations', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-operation-'));
    const store = createDispatchLaunchOperationStore({ dataDir, ownerLarkAppId: 'cli_source' });
    expect(store.create(operation())).toMatchObject({ created: true });
    expect(store.create(operation())).toMatchObject({ created: false });
    const preparing = { ...operation(), state: 'preparing' as const, updatedAt: '2026-09-03T10:00:01.000Z' };
    store.transition({ dispatchId: DISPATCH_ID, expectedState: 'created', next: preparing });
    expect(store.listRecoverable()).toEqual([preparing]);
    const failed = {
      ...preparing, state: 'failed' as const, errorCode: 'INTERNAL_ERROR' as const,
      updatedAt: '2026-09-03T10:00:02.000Z',
    };
    store.transition({ dispatchId: DISPATCH_ID, expectedState: 'preparing', next: failed });
    expect(store.listRecoverable()).toEqual([]);
  });

  it('rejects owner, identity, illegal transition, stale state, and post-prepare tuple changes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-operation-'));
    const store = createDispatchLaunchOperationStore({ dataDir, ownerLarkAppId: 'cli_source' });
    expect(() => store.create({ ...operation(), sourceLarkAppId: 'cli_other' }))
      .toThrow(DispatchLaunchOperationConflictError);
    store.create(operation());
    expect(() => store.create({ ...operation(), chatId: 'oc_other' }))
      .toThrow(DispatchLaunchOperationConflictError);
    expect(() => store.transition({ dispatchId: DISPATCH_ID, expectedState: 'prepared', next: operation('preparing') }))
      .toThrow(DispatchLaunchOperationConflictError);

    const preparing = { ...operation(), state: 'preparing' as const, updatedAt: '2026-09-03T10:00:01.000Z' };
    store.transition({ dispatchId: DISPATCH_ID, expectedState: 'created', next: preparing });
    const prepared = { ...operation('prepared'), updatedAt: '2026-09-03T10:00:02.000Z' };
    store.transition({ dispatchId: DISPATCH_ID, expectedState: 'preparing', next: prepared });
    const changed = {
      ...operation('starting'),
      launchIdentity: {
        ...operation('starting').launchIdentity,
        executable: '/other/codex',
      },
      updatedAt: '2026-09-03T10:00:03.000Z',
    };
    expect(() => store.transition({ dispatchId: DISPATCH_ID, expectedState: 'prepared', next: changed }))
      .toThrow(/prepared launch identity/);
  });

  it('fails closed when a persisted record is corrupt', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-operation-'));
    const store = createDispatchLaunchOperationStore({ dataDir, ownerLarkAppId: 'cli_source' });
    store.create(operation());
    const ownerDir = join(
      dataDir, 'dispatch-launch', 'operations',
      createHash('sha256').update('cli_source').digest('hex'),
    );
    writeFileSync(join(ownerDir, `${DISPATCH_ID}.json`), '{broken');
    expect(() => store.get(DISPATCH_ID)).toThrow();
  });
});

describe('dispatch launch admission store', () => {
  it('authorizes and settles exactly once while preserving immutable identity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-admission-'));
    const store = createDispatchLaunchAdmissionStore({ dataDir, targetLarkAppId: 'cli_target' });
    expect(store.authorize(receipt())).toMatchObject({ created: true });
    expect(store.authorize(receipt())).toMatchObject({ created: false });
    expect(store.listAuthorized()).toHaveLength(1);
    const committed = store.commit(DISPATCH_ID, '2026-09-03T10:00:01.000Z');
    expect(committed).toMatchObject({ state: 'committed', committedAt: '2026-09-03T10:00:01.000Z' });
    expect(store.commit(DISPATCH_ID, '2026-09-03T10:00:02.000Z')).toEqual(committed);
    expect(store.listAuthorized()).toEqual([]);
    expect(() => store.release(DISPATCH_ID, '2026-09-03T10:00:03.000Z'))
      .toThrow(DispatchLaunchAdmissionConflictError);
  });

  it('rejects foreign targets and dispatch-id reuse with different admission data', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-admission-'));
    const store = createDispatchLaunchAdmissionStore({ dataDir, targetLarkAppId: 'cli_target' });
    expect(() => store.authorize({ ...receipt(), targetLarkAppId: 'cli_other' }))
      .toThrow(DispatchLaunchAdmissionConflictError);
    store.authorize(receipt());
    expect(() => store.authorize({ ...receipt(), workingDir: '/other' }))
      .toThrow(DispatchLaunchAdmissionConflictError);
  });
});
