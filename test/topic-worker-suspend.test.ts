import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
const h = vi.hoisted(() => ({ suspend: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('../src/core/worker-pool.js', () => ({ suspendWorkerAsync: h.suspend }));
vi.mock('../src/utils/logger.js', () => ({ logger: { warn: h.warn, info: h.info } }));
import { suspendRecalledTopicWorkers } from '../src/core/topic-worker-suspend.js';
import { withBotTurnAdmission, __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';
const APP = 'cli_self';
const CHAT = 'oc_chat';
const ROOT = 'om_root';
const active = new Map<string, DaemonSession>();
const live = (id: string, changes: Partial<DaemonSession> = {}): DaemonSession => ({
  larkAppId: APP, chatId: CHAT, scope: 'thread', worker: { killed: false }, workerGeneration: 1,
  lastScreenStatus: 'working', session: { sessionId: id, status: 'active', rootMessageId: ROOT }, ...changes,
} as DaemonSession);
const fire = () => suspendRecalledTopicWorkers({ larkAppId: APP, chatId: CHAT, messageId: ROOT, activeSessions: active });
beforeEach(() => {
  vi.clearAllMocks(); active.clear(); __testOnly_resetBotTurnMutationGates();
  delete process.env.BOTMUX_COORDINATION_MODE;
  h.suspend.mockImplementation(async (ds, _reason, owned) => {
    if (!owned()) return false;
    ds.worker = null;
    ds.session.suspendedColdResume = true;
    return true;
  });
});
afterEach(() => { delete process.env.BOTMUX_COORDINATION_MODE; });
describe('topic root withdrawal suspension', () => {
  it('immediately suspends exact running workers once and preserves topic ownership and other sessions', async () => {
    const own = live('own');
    active.set('own', own); active.set('alias', own);
    active.set('peer', live('peer', { larkAppId: 'cli_peer' }));
    active.set('other-chat', live('other-chat', { chatId: 'oc_other' }));
    active.set('chat-scope', live('chat-scope', { scope: 'chat' }));
    const otherRoot = live('other-root'); otherRoot.session.rootMessageId = 'om_other'; active.set('other-root', otherRoot);
    await fire();
    expect(h.suspend).toHaveBeenCalledExactlyOnceWith(own, 'topic_recalled', expect.any(Function));
    expect(own.worker).toBeNull();
    expect(own.session.status).toBe('active');
    expect(own.session.rootMessageId).toBe(ROOT);
    expect(active.get('own')).toBe(own);
    expect(active.get('peer')!.worker).not.toBeNull();
    await fire();
    expect(h.suspend).toHaveBeenCalledTimes(1);
  });
  it('does not suspend a thread when a reply is recalled', async () => {
    const own = live('own'); own.session.rootMessageId = 'om_actual_root'; active.set('own', own);
    await fire(); expect(h.suspend).not.toHaveBeenCalled();
  });
  it('waits only for admitted creation, not the worker task to finish', async () => {
    let admit!: () => void;
    const admission = withBotTurnAdmission(APP, () => new Promise<void>(resolve => { admit = () => {
      active.set('new', live('new')); resolve();
    }; }));
    const pending = fire();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.suspend).not.toHaveBeenCalled();
    admit(); await admission; await pending;
    expect(h.suspend).toHaveBeenCalledTimes(1);
    expect(active.get('new')!.lastScreenStatus).toBe('working');
  });
  it.each(['binding', 'generation', 'worker', 'registration'])('rechecks %s before destructive suspension', async change => {
    const own = live('own'); const worker = own.worker; active.set('own', own);
    h.suspend.mockImplementation(async (ds, _reason, owned) => {
      if (change === 'binding') ds.session.rootMessageId = 'om_new';
      if (change === 'generation') ds.workerGeneration++;
      if (change === 'worker') ds.worker = { killed: false };
      if (change === 'registration') active.clear();
      expect(owned()).toBe(false);
      return false;
    });
    await fire();
    if (change !== 'worker') expect(own.worker).toBe(worker);
    expect(own.session.suspendedColdResume).toBeUndefined();
    expect(h.info).not.toHaveBeenCalled();
  });
  it('does not claim success after refusal and can retry the same worker', async () => {
    const own = live('own'); active.set('own', own);
    h.suspend.mockResolvedValueOnce(false);
    await fire();
    expect(own.worker).not.toBeNull(); expect(h.info).not.toHaveBeenCalled();
    await fire(); expect(own.worker).toBeNull();
  });
  it('continues suspending independent workers after a failure', async () => {
    active.set('a', live('a')); active.set('b', live('b'));
    h.suspend.mockRejectedValueOnce(new Error('teardown failed'));
    await fire();
    expect(active.get('a')!.worker).not.toBeNull(); expect(active.get('b')!.worker).toBeNull();
  });
  it('ignores absent workers and closed sessions', async () => {
    active.set('absent', live('absent', { worker: null }));
    const closed = live('closed'); closed.session.status = 'closed'; active.set('closed', closed);
    await fire(); expect(h.suspend).not.toHaveBeenCalled();
  });
  it('preserves durable primary lifecycle fencing', async () => {
    process.env.BOTMUX_COORDINATION_MODE = 'primary'; active.set('own', live('own'));
    await fire(); expect(h.suspend).not.toHaveBeenCalled();
  });
});
