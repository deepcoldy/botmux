import { describe, expect, it } from 'vitest';

import {
  DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION,
  DISPATCH_LAUNCH_CONTROL_LIMITS,
  DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION,
  DISPATCH_LAUNCH_OVERRIDE_SCHEMA_VERSION,
  DISPATCH_LAUNCH_POLICY_SCHEMA_VERSION,
  DISPATCH_LAUNCH_KICKOFF_LIMITS,
  canonicalizeDispatchLaunchKickoff,
  dispatchLaunchIdentityDigest,
  dispatchLaunchPolicyDigest,
  evaluateDispatchLaunchPolicy,
  normalizeDispatchLaunchPolicy,
  parseDispatchLaunchAdmissionReceipt,
  parseDispatchLaunchOperation,
  parseDispatchLaunchOverrideSnapshot,
  parseDispatchLaunchPrepareRequest,
  resolveDispatchLaunchOverride,
  type DispatchLaunchIdentityV1,
  type DispatchLaunchOperationV1,
  type DispatchLaunchPolicyV1,
} from '../src/core/dispatch-launch-contract.js';
import { DISPATCH_LAUNCH_IPC_BODY_LIMIT_BYTES } from '../src/core/dispatch-launch-ipc-auth.js';

const SHA = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-09-02T12:00:00.000Z';
const LATER = '2026-09-02T12:05:00.000Z';

const identity: DispatchLaunchIdentityV1 = {
  cliId: 'codex',
  cliRuntimeDigest: SHA,
  executable: 'codex',
  backendType: 'pty',
  codexRpcInput: false,
  existingAppServer: false,
  botConfigDigest: SHA,
  policyDigest: SHA,
};

function policy(overrides: Partial<DispatchLaunchPolicyV1> = {}): DispatchLaunchPolicyV1 {
  return {
    schemaVersion: DISPATCH_LAUNCH_POLICY_SCHEMA_VERSION,
    enabled: true,
    allowedSourceAppIds: ['cli_source'],
    allowedModels: ['gpt-5.6-sol'],
    allowedReasoningEfforts: ['high'],
    ...overrides,
  };
}

function operation(): DispatchLaunchOperationV1 {
  return {
    schemaVersion: DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION,
    dispatchId: `dl_${'a'.repeat(32)}`,
    owner: 'source',
    state: 'prepared',
    sourceLarkAppId: 'cli_source',
    sourceSessionId: 'source-session',
    sourceTurnId: 'source-turn',
    targetLarkAppId: 'cli_target',
    chatId: 'oc_chat',
    kickoff: canonicalizeDispatchLaunchKickoff({
      title: 'Task',
      brief: 'Do the work',
      sourceDisplay: 'Coordinator',
      targetLarkAppId: 'cli_target',
    }),
    requestedOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    effectiveOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    launchIdentity: identity,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: LATER,
  };
}

describe('dispatch launch canonical kickoff', () => {
  it('normalizes newlines and produces stable canonical bytes', () => {
    const crlf = canonicalizeDispatchLaunchKickoff({
      title: 'Task\r\nOne',
      brief: 'A\rB\r\nC',
      role: ' coder ',
      sourceDisplay: 'Source',
      targetLarkAppId: 'cli_target',
    });
    const lf = canonicalizeDispatchLaunchKickoff({
      title: 'Task\nOne',
      brief: 'A\nB\nC',
      role: ' coder ',
      sourceDisplay: 'Source',
      targetLarkAppId: 'cli_target',
    });
    expect(crlf).toEqual(lf);
    expect(crlf.payload.title).not.toContain('\r');
    expect(crlf.payload.brief).not.toContain('\r');
    expect(crlf).not.toHaveProperty('canonicalJson');
  });

  it('rejects empty, NUL-containing and oversized semantic fields', () => {
    const base = { brief: 'Brief', sourceDisplay: 'Source', targetLarkAppId: 'cli_target' };
    expect(() => canonicalizeDispatchLaunchKickoff({ ...base, title: '  ' })).toThrow('must not be empty');
    expect(() => canonicalizeDispatchLaunchKickoff({ ...base, title: 'a\0b' })).toThrow('NUL');
    expect(() => canonicalizeDispatchLaunchKickoff({ ...base, title: 'x'.repeat(513) })).toThrow('512');
  });

  it('keeps a maximum legal prepare request below the IPC body limit', () => {
    const kickoff = canonicalizeDispatchLaunchKickoff({
      title: 't'.repeat(DISPATCH_LAUNCH_KICKOFF_LIMITS.titleBytes),
      brief: 'b'.repeat(DISPATCH_LAUNCH_KICKOFF_LIMITS.briefBytes),
      role: 'r'.repeat(DISPATCH_LAUNCH_KICKOFF_LIMITS.roleBytes),
      sourceDisplay: 's'.repeat(DISPATCH_LAUNCH_KICKOFF_LIMITS.sourceDisplayBytes),
      targetLarkAppId: `cli_${'a'.repeat(DISPATCH_LAUNCH_CONTROL_LIMITS.larkAppIdChars - 4)}`,
    });
    const prepare = {
      schemaVersion: 1,
      protocol: 'v1',
      dispatchId: `dl_${'a'.repeat(32)}`,
      source: {
        larkAppId: `cli_${'b'.repeat(DISPATCH_LAUNCH_CONTROL_LIMITS.larkAppIdChars - 4)}`,
        sessionId: 's'.repeat(DISPATCH_LAUNCH_CONTROL_LIMITS.identifierChars),
        turnId: 't'.repeat(DISPATCH_LAUNCH_CONTROL_LIMITS.identifierChars),
        callerUnionId: `on_${'u'.repeat(DISPATCH_LAUNCH_CONTROL_LIMITS.callerUnionIdChars - 3)}`,
      },
      targetLarkAppId: kickoff.payload.targetLarkAppId,
      chatId: 'c'.repeat(DISPATCH_LAUNCH_CONTROL_LIMITS.identifierChars),
      kickoff,
      requestedOverride: {
        model: 'm'.repeat(DISPATCH_LAUNCH_CONTROL_LIMITS.modelChars),
        reasoningEffort: 'ultra',
      },
      expiresAt: LATER,
    };
    expect(parseDispatchLaunchPrepareRequest(prepare)).toEqual(prepare);
    expect(Buffer.byteLength(JSON.stringify(prepare), 'utf8')).toBeLessThanOrEqual(
      DISPATCH_LAUNCH_IPC_BODY_LIMIT_BYTES,
    );
  });
});

describe('dispatch launch override and policy', () => {
  it('requires a concrete model for every override', () => {
    expect(resolveDispatchLaunchOverride({
      cliId: 'codex',
      requested: { reasoningEffort: 'high' },
    })).toMatchObject({ ok: false, errorCode: 'MODEL_REQUIRED_FOR_OVERRIDE' });

    expect(resolveDispatchLaunchOverride({
      cliId: 'codex',
      requested: { reasoningEffort: 'high' },
      targetModel: 'gpt-5.6-sol',
    })).toEqual({
      ok: true,
      effective: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    });
  });

  it('does not guess an effort and rejects unsupported v1 harnesses or tuples', () => {
    expect(resolveDispatchLaunchOverride({
      cliId: 'codex',
      requested: { model: 'gpt-5.6-sol' },
    })).toEqual({ ok: true, effective: { model: 'gpt-5.6-sol' } });
    expect(resolveDispatchLaunchOverride({
      cliId: 'codex-app',
      requested: { model: 'gpt-5.6-sol' },
    })).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_HARNESS' });
    expect(resolveDispatchLaunchOverride({
      cliId: 'codex',
      requested: { model: 'gpt-5.5', reasoningEffort: 'ultra' },
    })).toMatchObject({ ok: false, errorCode: 'INVALID_MODEL_EFFORT_COMBINATION' });
  });

  it('normalizes policy deterministically and defaults to explicit deny decisions', () => {
    const normalized = normalizeDispatchLaunchPolicy(policy({
      allowedSourceAppIds: ['cli_source', 'cli_source'],
      allowedModels: ['gpt-5.6-sol', 'gpt-5.6-sol'],
    }));
    expect(normalized.allowedSourceAppIds).toEqual(['cli_source']);
    expect(dispatchLaunchPolicyDigest(normalized)).toBe(dispatchLaunchPolicyDigest(normalized));
    expect(evaluateDispatchLaunchPolicy({
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-5.6-sol' },
    })).toMatchObject({ ok: false, errorCode: 'POLICY_DENIED' });
    expect(evaluateDispatchLaunchPolicy({
      policy: normalized,
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    })).toMatchObject({ ok: true, policyDigest: expect.stringMatching(/^sha256:/) });
    expect(evaluateDispatchLaunchPolicy({
      policy: normalized,
      sourceLarkAppId: 'cli_other',
      effective: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    })).toMatchObject({ ok: false, errorCode: 'UNAUTHORIZED_SOURCE' });
    expect(evaluateDispatchLaunchPolicy({
      policy: policy({ enabled: false }),
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-5.6-sol' },
    })).toMatchObject({ ok: false, errorCode: 'POLICY_DENIED' });
    expect(dispatchLaunchIdentityDigest(identity)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('dispatch launch versioned codecs', () => {
  it('rejects unknown fields and canonical kickoff tampering', () => {
    expect(() => parseDispatchLaunchOperation({ ...operation(), unknown: true })).toThrow('Unrecognized key');
    const tampered = operation();
    tampered.kickoff.digest = `sha256:${'b'.repeat(64)}`;
    expect(() => parseDispatchLaunchOperation(tampered)).toThrow('canonicalization mismatch');
  });

  it('requires same-turn, same-generation proof before success', () => {
    expect(() => parseDispatchLaunchOperation({ ...operation(), state: 'succeeded' })).toThrow('required in succeeded');
    const mismatched = {
      ...operation(),
      state: 'succeeded',
      rootMessageId: 'root',
      targetSessionId: 's',
      kickoffTurnId: 't',
      workerGeneration: 3,
      proof: {
        inputCommitted: { sessionId: 's', kickoffTurnId: 't', workerGeneration: 3, observedAt: NOW },
        runtimeObserved: {
          sessionId: 's', kickoffTurnId: 'other', workerGeneration: 3, observedAt: NOW, model: 'gpt-5.6-sol',
          reasoningEffort: 'high',
        },
      },
    };
    expect(() => parseDispatchLaunchOperation(mismatched)).toThrow('same session, kickoff turn and worker generation');

    const succeeded = {
      ...mismatched,
      proof: {
        ...mismatched.proof,
        runtimeObserved: {
          ...mismatched.proof.runtimeObserved,
          kickoffTurnId: 't',
        },
      },
    };
    expect(parseDispatchLaunchOperation(succeeded).state).toBe('succeeded');
    expect(() => parseDispatchLaunchOperation({ ...succeeded, kickoffTurnId: 'other' }))
      .toThrow('proof does not match operation launch identity');
  });

  it.each([
    ['model mismatch', { model: 'wrong-model', reasoningEffort: 'high' }],
    ['effort missing', { model: 'gpt-5.6-sol' }],
    ['effort mismatch', { model: 'gpt-5.6-sol', reasoningEffort: 'low' }],
  ])('rejects succeeded runtime proof with %s', (_label, runtime) => {
    const base = operation();
    expect(() => parseDispatchLaunchOperation({
      ...base,
      state: 'succeeded',
      rootMessageId: 'root', targetSessionId: 's', kickoffTurnId: 't', workerGeneration: 1,
      proof: {
        inputCommitted: { sessionId: 's', kickoffTurnId: 't', workerGeneration: 1, observedAt: NOW },
        runtimeObserved: {
          sessionId: 's', kickoffTurnId: 't', workerGeneration: 1, observedAt: NOW, ...runtime,
        },
      },
    })).toThrow('runtime proof does not match effective override');
  });

  it('rejects an observed effort when the effective tuple has none', () => {
    const base = operation();
    expect(() => parseDispatchLaunchOperation({
      ...base,
      requestedOverride: { model: 'gpt-5.6-sol' },
      effectiveOverride: { model: 'gpt-5.6-sol' },
      state: 'succeeded',
      rootMessageId: 'root', targetSessionId: 's', kickoffTurnId: 't', workerGeneration: 1,
      proof: {
        inputCommitted: { sessionId: 's', kickoffTurnId: 't', workerGeneration: 1, observedAt: NOW },
        runtimeObserved: {
          sessionId: 's', kickoffTurnId: 't', workerGeneration: 1, observedAt: NOW,
          model: 'gpt-5.6-sol', reasoningEffort: 'high',
        },
      },
    })).toThrow('runtime proof does not match effective override');
  });

  it('accepts a fully matching tuple with no explicit effort', () => {
    const base = operation();
    expect(parseDispatchLaunchOperation({
      ...base,
      requestedOverride: { model: 'gpt-5.6-sol' },
      effectiveOverride: { model: 'gpt-5.6-sol' },
      state: 'succeeded',
      rootMessageId: 'root', targetSessionId: 's', kickoffTurnId: 't', workerGeneration: 1,
      proof: {
        inputCommitted: { sessionId: 's', kickoffTurnId: 't', workerGeneration: 1, observedAt: NOW },
        runtimeObserved: {
          sessionId: 's', kickoffTurnId: 't', workerGeneration: 1, observedAt: NOW, model: 'gpt-5.6-sol',
        },
      },
    }).state).toBe('succeeded');
  });

  it('rejects requested/effective drift, unsupported identity, and invalid generations', () => {
    expect(() => parseDispatchLaunchOperation({
      ...operation(), effectiveOverride: { model: 'other', reasoningEffort: 'high' },
    })).toThrow('effective override does not satisfy requested override');
    expect(() => parseDispatchLaunchOperation({
      ...operation(), launchIdentity: { ...identity, cliId: 'traex' },
    })).toThrow('Invalid literal value');
    expect(() => parseDispatchLaunchOperation({
      ...operation(), launchIdentity: { ...identity, codexRpcInput: true },
    })).toThrow('Invalid literal value');
    expect(() => parseDispatchLaunchOperation({
      ...operation(), state: 'awaiting_proof', rootMessageId: 'r', targetSessionId: 's',
      kickoffTurnId: 't', workerGeneration: 0,
    })).toThrow('greater than 0');
    expect(() => parseDispatchLaunchOperation({
      ...operation(), state: 'awaiting_proof', rootMessageId: 'r', targetSessionId: 's',
      kickoffTurnId: 't', workerGeneration: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow('less than or equal');
  });

  it('enforces state-specific required and forbidden fields', () => {
    const prepared = operation();
    const common = {
      schemaVersion: prepared.schemaVersion, dispatchId: prepared.dispatchId, owner: prepared.owner,
      sourceLarkAppId: prepared.sourceLarkAppId, sourceSessionId: prepared.sourceSessionId,
      sourceTurnId: prepared.sourceTurnId, targetLarkAppId: prepared.targetLarkAppId, chatId: prepared.chatId,
      kickoff: prepared.kickoff, requestedOverride: prepared.requestedOverride,
      createdAt: prepared.createdAt, updatedAt: prepared.updatedAt, expiresAt: prepared.expiresAt,
    };
    expect(parseDispatchLaunchOperation({ ...common, state: 'created' }).state).toBe('created');
    expect(() => parseDispatchLaunchOperation({
      ...common, state: 'created', effectiveOverride: prepared.effectiveOverride,
    })).toThrow('forbidden in created');
    expect(() => parseDispatchLaunchOperation({ ...common, state: 'prepared' }))
      .toThrow('required in prepared');
    expect(() => parseDispatchLaunchOperation({
      ...prepared, state: 'prepared', rootMessageId: 'root',
    })).toThrow('forbidden in prepared');
    expect(() => parseDispatchLaunchOperation({ ...common, state: 'cancelled', errorCode: 'BAD_REQUEST' }))
      .toThrow('cancelled requires CANCELLED');
    expect(parseDispatchLaunchOperation({ ...common, state: 'cancelled', errorCode: 'CANCELLED' }).state)
      .toBe('cancelled');
    expect(() => parseDispatchLaunchOperation({
      ...common, state: 'delivery_unknown', errorCode: 'INTERNAL_ERROR',
    })).toThrow('delivery_unknown requires DELIVERY_UNKNOWN');
    expect(() => parseDispatchLaunchOperation({ ...common, state: 'failed', errorCode: 'CANCELLED' }))
      .toThrow('contradictory terminal error code');
    expect(() => parseDispatchLaunchOperation({
      ...common, state: 'failed', errorCode: 'INTERNAL_ERROR', effectiveOverride: prepared.effectiveOverride,
    })).toThrow('present or absent together');
    expect(() => parseDispatchLaunchOperation({
      ...common, state: 'failed', errorCode: 'INTERNAL_ERROR', targetSessionId: 'session',
    })).toThrow('rootMessageId is required');
  });

  it('uses cross-app union identity and rejects app-scoped caller open ids', () => {
    const base = operation();
    const request = {
      schemaVersion: 1, protocol: 'v1', dispatchId: base.dispatchId,
      source: { larkAppId: 'cli_source', sessionId: 's', turnId: 't', callerUnionId: 'on_user' },
      targetLarkAppId: 'cli_target', chatId: 'oc_chat', kickoff: base.kickoff,
      requestedOverride: base.requestedOverride, expiresAt: LATER,
    };
    expect(parseDispatchLaunchPrepareRequest(request).source.callerUnionId).toBe('on_user');
    expect(() => parseDispatchLaunchPrepareRequest({
      ...request, source: { larkAppId: 'cli_source', sessionId: 's', turnId: 't', callerOpenId: 'ou_user' },
    })).toThrow('Unrecognized key');
  });

  it('validates prepare target binding, admission settlement and fork provenance', () => {
    const base = operation();
    expect(parseDispatchLaunchPrepareRequest({
      schemaVersion: 1,
      protocol: 'v1',
      dispatchId: base.dispatchId,
      source: { larkAppId: 'cli_source', sessionId: 's', turnId: 't' },
      targetLarkAppId: 'cli_target',
      chatId: 'oc_chat',
      kickoff: base.kickoff,
      requestedOverride: base.requestedOverride,
      expiresAt: LATER,
    }).targetLarkAppId).toBe('cli_target');

    expect(() => parseDispatchLaunchAdmissionReceipt({
      schemaVersion: DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION,
      dispatchId: base.dispatchId,
      state: 'committed',
      sourceLarkAppId: 'cli_source', sourceSessionId: 's', sourceTurnId: 't',
      chatId: 'oc_chat', targetLarkAppId: 'cli_target', policyDigest: SHA,
      talkAuthorizationReceiptId: 'talk', quotaReceiptId: 'quota', workingDir: '/repo',
      capacityReservationId: 'slot', createdAt: NOW,
    })).toThrow('committedAt is required');

    expect(() => parseDispatchLaunchOverrideSnapshot({
      schemaVersion: DISPATCH_LAUNCH_OVERRIDE_SCHEMA_VERSION,
      provenanceId: 'provenance',
      dispatchId: base.dispatchId,
      inheritedFromDispatchId: base.dispatchId,
      effective: base.effectiveOverride,
      launchIdentity: identity,
      createdAt: NOW,
    })).toThrow('exactly one');
  });
});
