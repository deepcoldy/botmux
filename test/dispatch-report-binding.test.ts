import { describe, expect, it } from 'vitest';

import {
  createDispatchReportBinding,
  dispatchSeedOwnedBy,
  resolveVerifiedDispatchReportTarget,
} from '../src/core/dispatch-report-binding.js';

const SECRET = 'host-only-binding-secret';

function binding(dispatchRoot = 'om_seed') {
  return createDispatchReportBinding(SECRET, {
    dispatchRoot,
    targetLarkAppId: 'cli_orchestrator',
    targetSessionId: 'session-orchestrator',
    sourceName: '支付页修复',
    issuedAt: '2026-08-10T00:00:00.000Z',
  });
}

describe('dispatch report binding', () => {
  it('derives the target only from the host signature, never mutable entry fields', () => {
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET,
      dispatchRoot: 'om_seed',
      registry: {
        om_seed: {
          orchAppId: 'cli_victim',
          orchSessionId: 'session-victim',
          reportBinding: binding(),
        },
      },
    })).toMatchObject({
      ok: true,
      binding: {
        targetLarkAppId: 'cli_orchestrator',
        targetSessionId: 'session-orchestrator',
      },
    });
  });

  it('rejects target mutation and copying a valid binding under another root', () => {
    const signed = binding();
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET,
      dispatchRoot: 'om_seed',
      registry: {
        om_seed: {
          reportBinding: {
            ...signed,
            payload: { ...signed.payload, targetSessionId: 'session-victim' },
          },
        },
      },
    })).toEqual({ ok: false, error: 'dispatch_binding_unproven' });
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET,
      dispatchRoot: 'om_other',
      registry: { om_other: { reportBinding: signed } },
    })).toEqual({ ok: false, error: 'dispatch_binding_unproven' });
  });

  it('accepts only a seed sent by the registering bot into the exact chat', () => {
    const owned = {
      message_id: 'om_seed',
      chat_id: 'oc_target',
      sender: { id: 'cli_orchestrator', id_type: 'app_id', sender_type: 'app' },
    };
    const input = {
      message: owned,
      dispatchRoot: 'om_seed',
      targetChatId: 'oc_target',
      larkAppId: 'cli_orchestrator',
      botOpenId: 'ou_orchestrator',
    };
    expect(dispatchSeedOwnedBy(input)).toBe(true);
    expect(dispatchSeedOwnedBy({
      ...input,
      message: { ...owned, chat_id: 'oc_victim' },
    })).toBe(false);
    expect(dispatchSeedOwnedBy({
      ...input,
      message: { ...owned, sender: { id: 'cli_victim', id_type: 'app_id', sender_type: 'app' } },
    })).toBe(false);
    expect(dispatchSeedOwnedBy({
      ...input,
      message: { ...owned, sender: { id: 'cli_orchestrator', id_type: 'app_id', sender_type: 'user' } },
    })).toBe(false);
  });
});
