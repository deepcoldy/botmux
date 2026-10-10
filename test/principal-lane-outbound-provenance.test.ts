import { describe, expect, it, vi } from 'vitest';
import type { MessageProvenance } from '../src/types.js';
import { settlePrincipalLaneOutboundProvenance } from '../src/core/principal-lane-outbound-provenance.js';

const now = new Date().toISOString();
const provenance: MessageProvenance = {
  messageId: 'om_out', larkAppId: 'app', chatId: 'oc_group',
  sourceSessionId: 'source-a', laneId: 'lane-b', sessionId: 'child-b',
  turnId: 'om_in', principalKey: 'user:union:b', workerGeneration: 7,
  direction: 'outbound', trustState: 'trusted', createdAt: now, updatedAt: now,
};

describe('principal lane outbound provenance', () => {
  it('keeps the deny fence until the trusted write returns', () => {
    const order: string[] = [];
    settlePrincipalLaneOutboundProvenance(provenance, {
      beginTrustAttempt: () => { order.push('deny'); return 'attempt-1'; },
      recordTrusted: () => { order.push('trusted-write'); },
      completeTrustAttempt: () => { order.push('complete'); },
      abortTrustAttempt: () => { order.push('abort'); },
      markUntrusted: () => { order.push('downgrade'); },
      warn: () => { order.push('warn'); },
    });
    expect(order).toEqual(['deny', 'trusted-write', 'complete']);
  });

  it('keeps an already-delivered send successful and downgrades reference authority', () => {
    const markUntrusted = vi.fn();
    const warn = vi.fn();
    expect(() => settlePrincipalLaneOutboundProvenance(provenance, {
      beginTrustAttempt: vi.fn(() => 'attempt-1'),
      recordTrusted: () => { throw new Error('sqlite busy'); },
      completeTrustAttempt: vi.fn(),
      abortTrustAttempt: vi.fn(),
      markUntrusted,
      warn,
    })).not.toThrow();
    expect(markUntrusted).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_out', trustState: 'untrusted',
    }));
    expect(warn).toHaveBeenCalled();
  });

  it('does not run the downgrade path for an unresolved trust fence', () => {
    const fenced = Object.assign(new Error('commit unknown'), { code: 'trust_commit_unknown' });
    const markUntrusted = vi.fn();
    const warn = vi.fn();
    settlePrincipalLaneOutboundProvenance(provenance, {
      beginTrustAttempt: () => { throw fenced; },
      recordTrusted: vi.fn(),
      completeTrustAttempt: vi.fn(),
      abortTrustAttempt: vi.fn(),
      markUntrusted,
      warn,
    });
    expect(markUntrusted).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fenced'));
  });

  it('releases the exact fence after a proven pre-commit busy failure', () => {
    const busy = Object.assign(new Error('sqlite busy'), { code: 'session_store_busy' });
    const abortTrustAttempt = vi.fn();
    const markUntrusted = vi.fn();
    settlePrincipalLaneOutboundProvenance(provenance, {
      beginTrustAttempt: () => 'attempt-1',
      recordTrusted: () => { throw busy; },
      completeTrustAttempt: vi.fn(),
      abortTrustAttempt,
      markUntrusted,
      warn: vi.fn(),
    });
    expect(abortTrustAttempt).toHaveBeenCalledWith(provenance, 'attempt-1');
    expect(markUntrusted).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_out', trustState: 'untrusted',
    }));
  });

  it('treats exact fence release as completion when the trusted write succeeded', () => {
    const busy = Object.assign(new Error('sqlite busy'), { code: 'session_store_busy' });
    const abortTrustAttempt = vi.fn();
    const markUntrusted = vi.fn();
    const warn = vi.fn();
    settlePrincipalLaneOutboundProvenance(provenance, {
      beginTrustAttempt: () => 'attempt-1',
      recordTrusted: vi.fn(),
      completeTrustAttempt: () => { throw busy; },
      abortTrustAttempt,
      markUntrusted,
      warn,
    });
    expect(abortTrustAttempt).toHaveBeenCalledWith(provenance, 'attempt-1');
    expect(markUntrusted).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
