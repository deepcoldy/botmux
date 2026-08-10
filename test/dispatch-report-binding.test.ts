import { describe, expect, it } from 'vitest';

import {
  createDispatchReportBinding,
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

});
