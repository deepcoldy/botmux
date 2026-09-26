import { describe, expect, it, vi } from 'vitest';
import { armTriggerStreamingCard, commitTriggerStreamingCard, discardTriggerStreamingCard, hasPendingTriggerStreamingCard } from '../src/core/trigger-streaming-card.js';
import { validateTriggerRequest, type TriggerRequest } from '../src/services/trigger-types.js';
import type { DaemonSession } from '../src/core/types.js';

const request = (): TriggerRequest => ({ source: { type: 'ui', connectorId: 'handoff' },
  target: { kind: 'turn', sessionId: 'session-1' },
  envelope: { format: 'handoff.v1', sourceName: 'team', trusted: false },
  presentation: { liveCard: 'on-start', title: '审查上传取消修复' },
  options: { asyncReturnSessionId: true, suppressFinalOutput: true },
});
const session = () => ({ scope: 'chat', chatType: 'group', chatId: 'oc_group',
  session: { sessionId: 'session-1', status: 'active', title: 'old title' },
  streamCardId: 'om_old', currentTurnId: 'old-turn',
}) as unknown as DaemonSession;

describe('handoff live card starts with committed input', () => {
  it('does not move the card while the handoff is merely queued', () => {
    const ds = session(); armTriggerStreamingCard(ds, request(), 'next');
    expect(hasPendingTriggerStreamingCard(ds, 'next')).toBe(true);
    expect(ds.streamCardId).toBe('om_old'); expect(ds.currentTurnId).toBe('old-turn');
  });
  it('moves once on exact committed handoff, preserving the CLI session', () => {
    const ds = session(), start = vi.fn(); const original = ds.session;
    armTriggerStreamingCard(ds, request(), 'next');
    expect(commitTriggerStreamingCard(ds, 'other', start)).toBe(false);
    expect(commitTriggerStreamingCard(ds, 'next', start)).toBe(true);
    expect(commitTriggerStreamingCard(ds, 'next', start)).toBe(false);
    expect(start).toHaveBeenCalledExactlyOnceWith(ds, '审查上传取消修复', 'next');
    expect(ds.session).toBe(original);
  });
  it('handles return handoffs on the same long-lived session', () => {
    const ds = session(), start = vi.fn();
    for (const turn of ['review-1', 'review-2']) {
      armTriggerStreamingCard(ds, request(), turn); commitTriggerStreamingCard(ds, turn, start);
    }
    expect(start).toHaveBeenCalledTimes(2);
  });
  it('does not let ordinary inputs or opt-out connectors cause a move', () => {
    const ds = session(), start = vi.fn(); const req = request(); delete req.presentation;
    armTriggerStreamingCard(ds, req, 'normal');
    expect(commitTriggerStreamingCard(ds, 'normal', start)).toBe(false);
    expect(commitTriggerStreamingCard(ds, 'om_user-message', start)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  it('does not expose headless, private chat or topic traffic', () => {
    for (const patch of [{ chatId: 'http_async_x' }, { chatType: 'p2p' }, { scope: 'thread' }]) {
      const ds = Object.assign(session(), patch), start = vi.fn();
      armTriggerStreamingCard(ds, request(), 'next');
      expect(commitTriggerStreamingCard(ds, 'next', start)).toBe(false);
    }
  });
  it('discards rejected work without changing the card', () => {
    const ds = session(), start = vi.fn(); armTriggerStreamingCard(ds, request(), 'next');
    discardTriggerStreamingCard(ds, 'next');
    expect(commitTriggerStreamingCard(ds, 'next', start)).toBe(false);
    expect(ds.streamCardId).toBe('om_old');
  });
  it('does not publish after the session closed', () => {
    const ds = session(), start = vi.fn(); armTriggerStreamingCard(ds, request(), 'next');
    ds.session.status = 'closed';
    expect(commitTriggerStreamingCard(ds, 'next', start)).toBe(false);
    expect(hasPendingTriggerStreamingCard(ds, 'next')).toBe(false);
  });
  it('keeps simultaneous sessions independent', () => {
    const a = session(), b = session(), start = vi.fn();
    armTriggerStreamingCard(a, request(), 'a'); armTriggerStreamingCard(b, request(), 'b');
    commitTriggerStreamingCard(a, 'a', start);
    expect(hasPendingTriggerStreamingCard(b, 'b')).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('validates the connector-owned presentation option', () => {
    expect(validateTriggerRequest(request()).ok).toBe(true);
    expect(validateTriggerRequest({ ...request(), presentation: { liveCard: true } }).ok).toBe(false);
  });
});
