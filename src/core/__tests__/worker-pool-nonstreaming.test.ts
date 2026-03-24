import { describe, it, expect } from 'vitest';
import { sessionKey } from '../types.js';
import type { DaemonSession } from '../types.js';

describe('DaemonSession nonStreamingIm flag logic', () => {
  function makeSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
    return {
      session: {
        sessionId: 'test-sess',
        rootMessageId: 'om_root',
        chatId: 'oc_chat',
        title: 'Test',
        status: 'active' as any,
        createdAt: new Date().toISOString(),
        pid: undefined,
        chatType: 'group',
      },
      worker: null,
      workerPort: null,
      workerToken: null,
      imBotId: 'app_test',
      chatId: 'oc_chat',
      chatType: 'group',
      spawnedAt: Date.now(),
      cliVersion: '1.0',
      lastMessageAt: Date.now(),
      hasHistory: false,
      ...overrides,
    };
  }

  it('initial state: nonStreamingIm true, finalOutputSent false', () => {
    const ds = makeSession({ nonStreamingIm: true, finalOutputSent: false });
    expect(ds.nonStreamingIm).toBe(true);
    expect(ds.finalOutputSent).toBe(false);
  });

  it('after setting finalOutputSent to true, flag reflects sent state', () => {
    const ds = makeSession({ nonStreamingIm: true, finalOutputSent: false });
    ds.finalOutputSent = true;
    expect(ds.finalOutputSent).toBe(true);
  });

  it('resetting finalOutputSent to false allows sending again', () => {
    const ds = makeSession({ nonStreamingIm: true, finalOutputSent: true });
    ds.finalOutputSent = false;
    expect(ds.finalOutputSent).toBe(false);
  });

  it('nonStreamingIm defaults to undefined when not set', () => {
    const ds = makeSession();
    expect(ds.nonStreamingIm).toBeUndefined();
    expect(ds.finalOutputSent).toBeUndefined();
  });
});

describe('sessionKey', () => {
  it('creates composite key from rootId and imBotId', () => {
    expect(sessionKey('om_root_1', 'app_123')).toBe('om_root_1::app_123');
  });

  it('different rootIds produce different keys', () => {
    expect(sessionKey('om_a', 'app_1')).not.toBe(sessionKey('om_b', 'app_1'));
  });

  it('different imBotIds produce different keys', () => {
    expect(sessionKey('om_a', 'app_1')).not.toBe(sessionKey('om_a', 'app_2'));
  });
});
