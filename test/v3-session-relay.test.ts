import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authorizeV3SessionRunMutationRequest,
  V3_SESSION_RUN_MUTATIONS,
  type V3SessionRelaySessionView,
} from '../src/workflows/v3/session-relay.js';
import type { RunChatBinding } from '../src/workflows/v3/grill-state.js';
import {
  makeManualCliRunEnvelope,
  serializeRunEnvelope,
  type Sha256Digest,
} from '../src/workflows/v3/run-envelope.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const CAPABILITY = 'c'.repeat(64);
const BINDING: RunChatBinding = {
  larkAppId: 'cli_owner',
  chatId: 'oc_owner',
  rootMessageId: 'om_root',
  sessionId: 'sess-1',
  ownerOpenId: 'ou_caller',
};

describe('v3 session relay authorization', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'v3-session-relay-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function writeEnvelope(runId: string, binding?: RunChatBinding): void {
    const runDir = join(baseDir, runId);
    mkdirSync(runDir, { recursive: true });
    const envelope = makeManualCliRunEnvelope({
      runId,
      createdAt: '2026-07-10T10:00:00.000Z',
      authorizedAt: '2026-07-10T10:00:00.000Z',
      ...(binding ? { chatBinding: binding } : {}),
      artifacts: {
        dag: { path: 'dag.json', sha256: DIGEST },
        botSnapshots: { path: 'bots.snapshot.json', sha256: DIGEST },
      },
    });
    writeFileSync(join(runDir, 'run.json'), serializeRunEnvelope(envelope));
  }

  function sessionView(
    overrides: Partial<V3SessionRelaySessionView> = {},
  ): V3SessionRelaySessionView {
    return {
      receiver: false,
      liveOrigin: { capability: CAPABILITY, turnId: 'turn-1', dispatchAttempt: 1 },
      callerOpenId: 'ou_caller',
      chatId: 'oc_owner',
      larkAppId: 'cli_owner',
      quoteTargetId: 'turn-1',
      ...overrides,
    };
  }

  function authorize(
    overrides: Partial<Parameters<typeof authorizeV3SessionRunMutationRequest>[0]> = {},
  ) {
    return authorizeV3SessionRunMutationRequest({
      runId: 'bound-ok',
      mutation: 'start',
      raw: { sessionId: 'sess-1', originCapability: CAPABILITY },
      trustedHost: false,
      session: sessionView(),
      selfLarkAppId: 'cli_owner',
      baseDir,
      ...overrides,
    });
  }

  it('authorizes a capability-proven session against its bound run', () => {
    writeEnvelope('bound-ok', BINDING);
    expect(authorize()).toEqual({
      ok: true,
      body: {},
      runDir: join(baseDir, 'bound-ok'),
      larkAppId: 'cli_owner',
    });
  });

  it('accepts a capability-only claim (sandbox relay files carry no turn tuple)', () => {
    writeEnvelope('bound-ok', BINDING);
    const decision = authorize({
      raw: { sessionId: 'sess-1', originCapability: CAPABILITY },
      session: sessionView({
        liveOrigin: { capability: CAPABILITY, turnId: 'turn-9', dispatchAttempt: 3 },
        quoteTargetId: 'turn-9',
      }),
    });
    expect(decision.ok).toBe(true);
  });

  it('rejects unknown mutations and malformed run ids before any run read', () => {
    expect(authorize({ mutation: 'approve' })).toEqual({
      ok: false, status: 404, error: 'unknown_mutation',
    });
    expect(authorize({ runId: '../escape' })).toEqual({
      ok: false, status: 400, error: 'bad_run_id',
    });
  });

  it('fails closed when the daemon identity is not yet available', () => {
    expect(authorize({ selfLarkAppId: undefined })).toEqual({
      ok: false, status: 503, error: 'workflow_ipc_identity_unavailable',
    });
  });

  it('rejects non-object bodies and a missing session id', () => {
    expect(authorize({ raw: 'nope' })).toEqual({ ok: false, status: 400, error: 'bad_json' });
    expect(authorize({ raw: ['x'] })).toEqual({ ok: false, status: 400, error: 'bad_json' });
    expect(authorize({ raw: { originCapability: CAPABILITY } })).toEqual({
      ok: false, status: 400, error: 'missing_session_id',
    });
  });

  it('rejects a wrong, missing, or unmatchable capability', () => {
    writeEnvelope('bound-ok', BINDING);
    expect(authorize({
      raw: { sessionId: 'sess-1', originCapability: 'd'.repeat(64) },
    })).toEqual({ ok: false, status: 403, error: 'origin_unproven' });
    expect(authorize({
      raw: { sessionId: 'sess-1' },
    })).toEqual({ ok: false, status: 403, error: 'origin_unproven' });
    // No live origin published for the session (e.g. between turns).
    expect(authorize({
      session: sessionView({ liveOrigin: undefined }),
    })).toEqual({ ok: false, status: 403, error: 'origin_unproven' });
    // Claimed session has no live record on this daemon at all.
    expect(authorize({ session: undefined })).toEqual({
      ok: false, status: 403, error: 'origin_unproven',
    });
  });

  it('rejects a capability whose turn is no longer the session current turn', () => {
    // Reviewer repro: turn A still running (capability/turn = A) while user
    // B's message is already queued — the daemon has advanced quoteTargetId /
    // lastCallerOpenId to B, and A must NOT be able to borrow B's identity to
    // mutate B's run.
    writeEnvelope('bound-b', {
      ...BINDING,
      ownerOpenId: 'ou_caller_b',
      sessionId: 'sess-1',
    });
    const decision = authorize({
      runId: 'bound-b',
      session: sessionView({
        liveOrigin: { capability: CAPABILITY, turnId: 'turn-a' },
        callerOpenId: 'ou_caller_b',
        quoteTargetId: 'turn-b',
      }),
    });
    expect(decision).toEqual({ ok: false, status: 403, error: 'turn_provenance_stale' });

    // The reverse direction is fail-closed too: A mutating A's own run is
    // denied while B is queued (same posture as the host marker join).
    writeEnvelope('bound-ok', BINDING);
    expect(authorize({
      session: sessionView({ quoteTargetId: 'turn-b' }),
    })).toEqual({ ok: false, status: 403, error: 'turn_provenance_stale' });
  });

  it('requires both current-turn pointers to be the capability generation', () => {
    writeEnvelope('bound-ok', BINDING);
    // Missing liveOrigin.turnId (e.g. pre-turn publish) proves no generation.
    expect(authorize({
      session: sessionView({ liveOrigin: { capability: CAPABILITY } }),
    })).toEqual({ ok: false, status: 403, error: 'turn_provenance_stale' });
    // Session without a current inbound turn pointer cannot be joined.
    expect(authorize({
      session: sessionView({ quoteTargetId: undefined }),
    })).toEqual({ ok: false, status: 403, error: 'turn_provenance_stale' });
    // Chat-scope fold-back pointer must agree as well when present…
    expect(authorize({
      session: sessionView({ currentReplyTargetTurnId: 'turn-b' }),
    })).toEqual({ ok: false, status: 403, error: 'turn_provenance_stale' });
    // …and passes when it names the same generation.
    expect(authorize({
      session: sessionView({ currentReplyTargetTurnId: 'turn-1' }),
    }).ok).toBe(true);
  });

  it('denies meeting receiver sessions even with a valid capability', () => {
    writeEnvelope('bound-ok', BINDING);
    expect(authorize({ session: sessionView({ receiver: true }) })).toEqual({
      ok: false, status: 403, error: 'managed_action_required',
    });
  });

  it('requires a complete live identity tuple owned by this daemon', () => {
    writeEnvelope('bound-ok', BINDING);
    for (const gap of [
      { callerOpenId: undefined },
      { chatId: undefined },
      { larkAppId: undefined },
      { larkAppId: 'cli_other' },
    ]) {
      expect(authorize({ session: sessionView(gap) })).toEqual({
        ok: false, status: 403, error: 'session_identity_incomplete',
      });
    }
  });

  it('trusted host requests still bind to a real live session, never body claims', () => {
    writeEnvelope('bound-ok', BINDING);
    expect(authorize({ trustedHost: true, raw: { sessionId: 'sess-1' } }).ok).toBe(true);
    expect(authorize({ trustedHost: true, session: undefined, raw: { sessionId: 'ghost' } }))
      .toEqual({ ok: false, status: 403, error: 'session_identity_incomplete' });
  });

  it('rejects a run bound to a different chat tuple, with the mismatch detail', () => {
    writeEnvelope('bound-ok', BINDING);
    const decision = authorize({ session: sessionView({ chatId: 'oc_other' }) });
    expect(decision).toMatchObject({ ok: false, status: 403, error: 'run_binding_mismatch' });
    expect((decision as { detail?: string }).detail).toContain('chatId');
  });

  it('rejects unbound and missing runs through the same fail-closed error', () => {
    writeEnvelope('unbound-run');
    expect(authorize({ runId: 'unbound-run' })).toMatchObject({
      ok: false, status: 403, error: 'run_binding_mismatch',
    });
    expect(authorize({ runId: 'no-such-run' })).toMatchObject({
      ok: false, status: 403, error: 'run_binding_mismatch',
    });
  });

  it('forwards only the allowlisted payload keys per mutation', () => {
    writeEnvelope('bound-ok', BINDING);
    const cancel = authorize({
      mutation: 'cancel',
      raw: {
        sessionId: 'sess-1',
        originCapability: CAPABILITY,
        reason: 'stop it',
        nodeId: 'smuggled',
        larkAppId: 'cli_attacker',
      },
    });
    expect(cancel).toMatchObject({ ok: true, body: { reason: 'stop it' } });

    const retry = authorize({
      mutation: 'retry',
      raw: { sessionId: 'sess-1', originCapability: CAPABILITY, nodeId: 'n1', reason: 'x' },
    });
    expect(retry).toMatchObject({ ok: true, body: { nodeId: 'n1' } });

    const grant = authorize({
      mutation: 'grant',
      raw: { sessionId: 'sess-1', originCapability: CAPABILITY, loopId: 'loop-1' },
    });
    expect(grant).toMatchObject({ ok: true, body: { loopId: 'loop-1' } });

    const start = authorize({
      mutation: 'start',
      raw: { sessionId: 'sess-1', originCapability: CAPABILITY, anything: 'else' },
    });
    expect(start).toMatchObject({ ok: true, body: {} });
  });

  it('re-validates the forwarded payload with the shared body parser', () => {
    writeEnvelope('bound-ok', BINDING);
    const decision = authorize({
      mutation: 'cancel',
      raw: { sessionId: 'sess-1', originCapability: CAPABILITY, reason: 42 },
    });
    expect(decision.ok).toBe(false);
    expect((decision as { status?: number }).status).toBe(400);
  });

  it('covers every relayable mutation with a green path', () => {
    writeEnvelope('bound-ok', BINDING);
    for (const mutation of V3_SESSION_RUN_MUTATIONS) {
      expect(authorize({ mutation }).ok, mutation).toBe(true);
    }
  });
});
