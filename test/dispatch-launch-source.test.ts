import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION, DISPATCH_LAUNCH_SCHEMA_VERSION,
  canonicalizeDispatchLaunchKickoff, dispatchLaunchPolicyDigest, type DispatchLaunchIdentityV1,
  type DispatchLaunchPrepareRequestV1,
} from '../src/core/dispatch-launch-contract.js';
import { createDispatchLaunchOperationStore } from '../src/core/dispatch-launch-operation-store.js';
import { createDispatchLaunchSourceCoordinator } from '../src/core/dispatch-launch-source.js';

const dispatchId = `dl_${'2'.repeat(32)}`;
const policy = { schemaVersion: 1 as const, enabled: true, allowedSourceAppIds: ['cli_source'], allowedModels: ['gpt'], allowedReasoningEfforts: ['high' as const] };
const identity: DispatchLaunchIdentityV1 = {
  cliId: 'codex', cliRuntimeDigest: `sha256:${'a'.repeat(64)}`, executable: 'codex', backendType: 'pty',
  codexRpcInput: false, existingAppServer: false, botConfigDigest: `sha256:${'b'.repeat(64)}`,
  policyDigest: dispatchLaunchPolicyDigest(policy),
};
const prepareRequest: DispatchLaunchPrepareRequestV1 = {
  schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION, protocol: 'v1', dispatchId,
  source: { larkAppId: 'cli_source', sessionId: 'source-session', turnId: 'source-turn' },
  targetLarkAppId: 'cli_target', chatId: 'oc_chat',
  kickoff: canonicalizeDispatchLaunchKickoff({ title: 'Task', brief: 'Brief', sourceDisplay: 'Source', targetLarkAppId: 'cli_target' }),
  requestedOverride: { model: 'gpt', reasoningEffort: 'high' }, expiresAt: '2026-09-03T11:00:00.000Z',
};

describe('dispatch launch source coordinator', () => {
  it('persists source-owned prepare/start observations and recovers through query-safe calls', async () => {
    const store = createDispatchLaunchOperationStore({
      dataDir: mkdtempSync(join(tmpdir(), 'dispatch-source-')), ownerLarkAppId: 'cli_source',
    });
    const request = vi.fn(async (input: any) => {
      const source = store.get(dispatchId)!;
      const operation = input.action === 'prepare'
        ? { ...source, owner: 'target' as const, state: 'prepared' as const, effectiveOverride: { model: 'gpt', reasoningEffort: 'high' as const }, launchIdentity: identity }
        : { ...source, owner: 'target' as const, state: 'awaiting_proof' as const, effectiveOverride: { model: 'gpt', reasoningEffort: 'high' as const }, launchIdentity: identity, rootMessageId: 'om_root', targetSessionId: 'target-session', kickoffTurnId: 'source-turn', workerGeneration: 1 };
      return { ok: true, status: 200, bodyRaw: JSON.stringify({ ok: true, operation: { ...operation, schemaVersion: DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION } }) };
    });
    const coordinator = createDispatchLaunchSourceCoordinator({
      sourceLarkAppId: 'cli_source', store, targetDaemon: { larkAppId: 'cli_target', ipcPort: 9000, bootInstanceId: 'A'.repeat(43), dispatchLaunchIpcProtocol: 'v1' },
      now: () => new Date('2026-09-03T10:00:00.000Z'), request,
    });
    expect(await coordinator.prepare(prepareRequest)).toMatchObject({ ok: true, operation: { owner: 'source', state: 'prepared' } });
    expect(await coordinator.start(dispatchId)).toMatchObject({ ok: true, operation: { owner: 'source', state: 'awaiting_proof' } });
    expect(store.get(dispatchId)).toMatchObject({ state: 'awaiting_proof', rootMessageId: 'om_root' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps preparing durable when transport fails so recovery can retry', async () => {
    const store = createDispatchLaunchOperationStore({
      dataDir: mkdtempSync(join(tmpdir(), 'dispatch-source-')), ownerLarkAppId: 'cli_source',
    });
    const coordinator = createDispatchLaunchSourceCoordinator({
      sourceLarkAppId: 'cli_source', store, targetDaemon: { larkAppId: 'cli_target', ipcPort: 9000, bootInstanceId: 'A'.repeat(43), dispatchLaunchIpcProtocol: 'v1' },
      now: () => new Date('2026-09-03T10:00:00.000Z'), request: async () => { throw new Error('connection lost'); },
    });
    await expect(coordinator.prepare(prepareRequest)).rejects.toThrow('connection lost');
    expect(store.get(dispatchId)?.state).toBe('preparing');
  });

  it('rejects requests that do not belong to the source daemon or target descriptor', async () => {
    const store = createDispatchLaunchOperationStore({
      dataDir: mkdtempSync(join(tmpdir(), 'dispatch-source-')), ownerLarkAppId: 'cli_source',
    });
    const request = vi.fn();
    const coordinator = createDispatchLaunchSourceCoordinator({
      sourceLarkAppId: 'cli_source', store,
      targetDaemon: { larkAppId: 'cli_target', ipcPort: 9000, bootInstanceId: 'A'.repeat(43), dispatchLaunchIpcProtocol: 'v1' },
      now: () => new Date('2026-09-03T10:00:00.000Z'), request,
    });
    expect(() => coordinator.create({
      ...prepareRequest, source: { ...prepareRequest.source, larkAppId: 'cli_other' },
    })).toThrow('source app id mismatch');
    await expect(coordinator.prepare({
      ...prepareRequest, targetLarkAppId: 'cli_other',
    })).rejects.toThrow('target descriptor mismatch');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a query response whose target-owned identity does not match the source record', async () => {
    const store = createDispatchLaunchOperationStore({
      dataDir: mkdtempSync(join(tmpdir(), 'dispatch-source-')), ownerLarkAppId: 'cli_source',
    });
    const coordinator = createDispatchLaunchSourceCoordinator({
      sourceLarkAppId: 'cli_source', store,
      targetDaemon: { larkAppId: 'cli_target', ipcPort: 9000, bootInstanceId: 'A'.repeat(43), dispatchLaunchIpcProtocol: 'v1' },
      now: () => new Date('2026-09-03T10:00:00.000Z'),
      request: async () => ({
        ok: true, status: 200, bodyRaw: JSON.stringify({
          ok: true, operation: { ...store.get(dispatchId), owner: 'target', chatId: 'oc_other' },
        }),
      }),
    });
    coordinator.create(prepareRequest);
    await expect(coordinator.query(dispatchId)).rejects.toThrow('target operation identity mismatch');
  });
});
