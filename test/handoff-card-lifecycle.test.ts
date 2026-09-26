import { describe, expect, it, vi } from 'vitest';
import { applyHandoffCardEvent, handoffCardClosed, parseHandoffCardEvent } from '../src/core/handoff-card-lifecycle.js';
import type { DaemonSession } from '../src/core/types.js';
const session = () => ({ session: { status: 'active', handoffLiveCard: { turnId: 'dev', sequence: 0 } },
  currentTurnId: 'dev', streamCardId: 'om_dev', streamCardNonce: 'n', currentTurnTitle: '开发中',
}) as unknown as DaemonSession;
const io = () => ({ persist: vi.fn(), patch: vi.fn(), remove: vi.fn(async () => {}), clear: vi.fn() });

describe('parallel handoff lifecycle', () => {
  it.each(['stage', 'complete'] as const)('keeps a failed %s persistence retryable without card effects', async kind => {
    const ds = session(), effects = io();
    const previous = structuredClone(ds.session.handoffLiveCard);
    const previousTitle = ds.currentTurnTitle;
    const event = kind === 'stage'
      ? { turnId: 'dev', sequence: 1, kind, title: 'Inventory reconciliation' }
      : { turnId: 'dev', sequence: 1, kind, resultMessageId: 'om_result' };
    effects.persist.mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(applyHandoffCardEvent(ds, event, effects)).rejects.toThrow('disk full');
    expect(ds.session.handoffLiveCard).toEqual(previous);
    expect(ds.currentTurnTitle).toBe(previousTitle);
    expect(effects.patch).not.toHaveBeenCalled();
    expect(effects.remove).not.toHaveBeenCalled();
    await applyHandoffCardEvent(ds, event, effects);
    expect(ds.session.handoffLiveCard?.sequence).toBe(1);
    expect(effects.persist).toHaveBeenCalledTimes(2);
    if (kind === 'stage') expect(effects.patch).toHaveBeenCalledOnce();
    else expect(effects.remove).toHaveBeenCalledExactlyOnceWith('om_dev');
  });
  it('accepts caller-defined stages without requiring a development workflow', async () => {
    const ds = session(), effects = io();
    for (const [index, title] of ['翻译 · 校对', 'Inventory reconciliation', '自由阶段 🍃'].entries()) {
      const event = parseHandoffCardEvent({ turnId: 'dev', sequence: index + 1, kind: 'stage', title });
      await applyHandoffCardEvent(ds, event, effects);
      expect(ds.currentTurnTitle).toBe(title);
    }
    expect(effects.remove).not.toHaveBeenCalled();
  });
  it('keeps the developer card in place during parallel review and deployment, removes only after result', async () => {
    const dev = session(), review = session(), effects = io(); review.streamCardId = 'om_review';
    await applyHandoffCardEvent(dev, { turnId: 'dev', sequence: 1, kind: 'stage', title: '开发机器人 · 部署中' }, effects);
    expect(dev.streamCardId).toBe('om_dev'); expect(review.streamCardId).toBe('om_review');
    expect(dev.currentTurnTitle).toContain('部署中'); expect(effects.remove).not.toHaveBeenCalled();
    await applyHandoffCardEvent(dev, { turnId: 'dev', sequence: 2, kind: 'stage', title: '开发机器人 · 等待部署结果' }, effects);
    await applyHandoffCardEvent(dev, { turnId: 'dev', sequence: 3, kind: 'complete', resultMessageId: 'om_result' }, effects);
    expect(effects.remove).toHaveBeenCalledExactlyOnceWith('om_dev');
    expect(review.streamCardId).toBe('om_review'); expect(handoffCardClosed(dev)).toBe(true);
    expect(dev.streamCardId).toBeUndefined();
  });
  it('rejects unconfirmed results and a stale return after a new handoff', async () => {
    expect(() => parseHandoffCardEvent({ turnId: 'dev', sequence: 1, kind: 'complete' })).toThrow();
    const ds = session(); ds.currentTurnId = 'next';
    const effects = io();
    await expect(applyHandoffCardEvent(ds, { turnId: 'dev', sequence: 3, kind: 'complete', resultMessageId: 'om_result' }, effects)).rejects.toThrow('stale');
    expect(effects.remove).not.toHaveBeenCalled();
    expect(handoffCardClosed(ds, 'next')).toBe(false);
  });
  it('persists closure before delete and allows retry after transport failure', async () => {
    const ds = session(), effects = io(); effects.remove.mockRejectedValueOnce(new Error('network'));
    const event = { turnId: 'dev', sequence: 1, kind: 'complete', resultMessageId: 'om_result' } as const;
    await expect(applyHandoffCardEvent(ds, event, effects)).rejects.toThrow('network');
    expect(handoffCardClosed(ds)).toBe(true); expect(ds.streamCardId).toBe('om_dev');
    await applyHandoffCardEvent(ds, event, effects); expect(ds.streamCardId).toBeUndefined();
    expect(effects.persist.mock.invocationCallOrder[0]).toBeLessThan(effects.remove.mock.invocationCallOrder[0]);
  });
  it('does not clear the successor card when delete returns late', async () => {
    const ds = session(), effects = io();
    effects.remove.mockImplementationOnce(async () => {
      ds.session.handoffLiveCard = { turnId: 'next', sequence: 0 };
      ds.currentTurnId = 'next'; ds.streamCardId = 'om_next';
    });
    await applyHandoffCardEvent(ds, { turnId: 'dev', sequence: 1, kind: 'complete', resultMessageId: 'om_result' }, effects);
    expect(ds.streamCardId).toBe('om_next'); expect(effects.clear).not.toHaveBeenCalled();
  });
  it('does not revive a closed card or regress stage on a reordered event', async () => {
    const ds = session(), effects = io();
    await applyHandoffCardEvent(ds, { turnId: 'dev', sequence: 2, kind: 'stage', title: '部署中' }, effects);
    await applyHandoffCardEvent(ds, { turnId: 'dev', sequence: 1, kind: 'stage', title: '开发中' }, effects);
    expect(ds.currentTurnTitle).toBe('部署中');
    await applyHandoffCardEvent(ds, { turnId: 'dev', sequence: 3, kind: 'complete', resultMessageId: 'om_result' }, effects);
    await expect(applyHandoffCardEvent(ds, { turnId: 'dev', sequence: 4, kind: 'stage', title: '开发中' }, effects)).rejects.toThrow('completed');
    const restored = { ...ds, currentTurnId: undefined };
    expect(handoffCardClosed(restored)).toBe(true);
  });
  it('invalidates pending POST without sending a delete for the sentinel', async () => {
    const ds = session(), effects = io(); ds.streamCardId = '__posting__';
    await applyHandoffCardEvent(ds, { turnId: 'dev', sequence: 1, kind: 'complete', resultMessageId: 'om_result' }, effects);
    expect(effects.remove).not.toHaveBeenCalled(); expect(ds.streamCardId).toBeUndefined();
  });
});
