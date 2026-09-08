/**
 * Stage 2 单一 apply：会话行命令的变换语义。daemon（session-store.closeSession、
 * /whiteboard 路由）与宿主（CLI 离线 delete/prune/whiteboard、dashboard 删板）
 * 都只经这一份实现改行，这里钉住每条命令对行的确切影响与幂等/拒绝规则。
 *
 * Run:  bunx vitest run test/session-commands.test.ts
 */
import { describe, it, expect } from 'vitest';
import { applySessionRowCommand } from '../src/services/session-commands.js';
import type { Session } from '../src/types.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');

function row(extra: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', chatId: 'oc_chat', rootMessageId: 'om_s1', title: 's1',
    status: 'active', createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  } as Session;
}

describe('close', () => {
  it('closes the row and drops runtime-only fields, keeping the token snapshot untouched when none is supplied', () => {
    const r = row({
      dashboardAttachments: [{ type: 'image', path: '/d/attachments/app/dashboard-1/a.png', name: 'a.png' }],
      queuedAttachments: [{ type: 'image', path: '/d/q.png', name: 'q.png' }],
      previewTarget: { host: '127.0.0.1', port: 4173, registeredAt: '2026-08-11T12:00:00.000Z', owner: 'agent', workerGeneration: 1 } as Session['previewTarget'],
      mojoCloseJournal: { phase: 'prepared' } as Session['mojoCloseJournal'],
      codexAppDispatchLedger: [],
      workerGeneration: 3,
    });
    const result = applySessionRowCommand(r, { type: 'close' }, { now: NOW });
    expect(result).toEqual({
      outcome: 'applied',
      released: { dashboardAttachments: [{ type: 'image', path: '/d/attachments/app/dashboard-1/a.png', name: 'a.png' }] },
    });
    expect(r.status).toBe('closed');
    expect(r.closedAt).toBe(NOW.toISOString());
    expect(r.dashboardAttachments).toBeUndefined();
    expect(r.queuedAttachments).toBeUndefined();
    expect(r.previewTarget).toBeUndefined();
    // Not a snapshot the caller sampled → not written (a host that cannot
    // resolve the transcript must not pin a permanent null).
    expect('tokenUsage' in r && r.tokenUsage !== undefined).toBe(false);
    // The mojo fence survives unless the caller names the wipe.
    expect(r.mojoCloseJournal).toEqual({ phase: 'prepared' });
    // Ledger/generation fields are not the close's business.
    expect(r.codexAppDispatchLedger).toEqual([]);
    expect(r.workerGeneration).toBe(3);
  });

  it('is a noop on a clean already-closed row and keeps its closedAt', () => {
    const r = row({ status: 'closed', closedAt: '2026-08-13T00:00:00.000Z' });
    expect(applySessionRowCommand(r, { type: 'close' }, { now: NOW })).toEqual({ outcome: 'noop' });
    expect(r.closedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('re-close of a legacy closed row still drops leftover attachments without refreshing closedAt', () => {
    // Older offline close left queuedAttachments / dashboardAttachments on the
    // closed row. Re-close must release the images and clear the queue, but
    // must not rewrite closedAt.
    const images = [{ type: 'image' as const, path: '/d/attachments/app/dashboard-1/a.png', name: 'a.png' }];
    const r = row({
      status: 'closed',
      closedAt: '2026-08-13T00:00:00.000Z',
      dashboardAttachments: images,
      queuedAttachments: [{ type: 'image', path: '/d/q.png', name: 'q.png' }],
    });
    expect(applySessionRowCommand(r, { type: 'close' }, { now: NOW })).toEqual({
      outcome: 'applied',
      released: { dashboardAttachments: images },
    });
    expect(r.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(r.dashboardAttachments).toBeUndefined();
    expect(r.queuedAttachments).toBeUndefined();
  });

  it('still parks / wipes daemon-only fields on an already-closed row without refreshing closedAt', () => {
    const r = row({
      status: 'closed',
      closedAt: '2026-08-13T00:00:00.000Z',
      previewTarget: { host: '127.0.0.1', port: 1, registeredAt: 'x', owner: 'agent', workerGeneration: 1 } as Session['previewTarget'],
      mojoCloseJournal: { phase: 'prepared' } as Session['mojoCloseJournal'],
      riffParentTaskId: 'riff-stale',
    });
    expect(applySessionRowCommand(r, {
      type: 'close',
      parkMojoLineage: 'm1',
      parkLocalResidual: 'local_subtree_boundary_unproven',
      clearMojoCloseJournal: true,
      clearRiffParentTaskId: true,
    }, { now: NOW })).toEqual({ outcome: 'applied', released: {} });
    expect(r.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(r.mojoQuarantinedLineage).toBe('m1');
    expect(r.mojoQuarantineNoticePending).toBe(true);
    expect(r.mojoLocalResidual).toBe('local_subtree_boundary_unproven');
    expect(r.mojoCloseJournal).toBeUndefined();
    expect(r.riffParentTaskId).toBeUndefined();
    expect(r.previewTarget).toBeUndefined();
    // Same park again is a noop — the first close already merged the handle.
    expect(applySessionRowCommand(r, { type: 'close', parkMojoLineage: 'm1' }, { now: NOW })).toEqual({ outcome: 'noop' });
    expect(r.mojoQuarantinedLineage).toBe('m1');
  });

  it('writes a sampled token snapshot, and null only when the row has none yet', () => {
    const snapshot = { in: 1, out: 2, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 1 } as NonNullable<Session['tokenUsage']>;
    const a = row();
    applySessionRowCommand(a, { type: 'close', tokenUsage: snapshot }, { now: NOW });
    expect(a.tokenUsage).toEqual(snapshot);

    const b = row();
    applySessionRowCommand(b, { type: 'close', tokenUsage: null }, { now: NOW });
    expect(b.tokenUsage).toBeNull();

    const c = row({ tokenUsage: snapshot });
    applySessionRowCommand(c, { type: 'close', tokenUsage: null }, { now: NOW });
    expect(c.tokenUsage).toEqual(snapshot);
  });

  it('applies the daemon-only options: journal wipe, parks, riff handle', () => {
    const r = row({
      mojoCloseJournal: { phase: 'prepared' } as Session['mojoCloseJournal'],
      mojoQuarantinedLineage: 'old',
      riffParentTaskId: 'riff-1',
    });
    applySessionRowCommand(r, {
      type: 'close',
      clearMojoCloseJournal: true,
      parkMojoLineage: 'new',
      parkLocalResidual: 'local_subtree_boundary_unproven',
      clearRiffParentTaskId: true,
    }, { now: NOW });
    expect(r.mojoCloseJournal).toBeUndefined();
    expect(r.mojoQuarantinedLineage).toBe('old,new');
    expect(r.mojoQuarantineNoticePending).toBe(true);
    expect(r.mojoLocalResidual).toBe('local_subtree_boundary_unproven');
    expect(r.riffParentTaskId).toBeUndefined();

    // Same id parked twice stays a single handle.
    const again = row({ mojoQuarantinedLineage: 'new' });
    applySessionRowCommand(again, { type: 'close', parkMojoLineage: 'new' }, { now: NOW });
    expect(again.mojoQuarantinedLineage).toBe('new');
  });
});

describe('prune', () => {
  it('closes a row that owns no protected work', () => {
    const r = row({ previewTarget: { host: '127.0.0.1', port: 1, registeredAt: 'x', owner: 'agent', workerGeneration: 1 } as Session['previewTarget'] });
    expect(applySessionRowCommand(r, { type: 'prune' }, { now: NOW })).toEqual({ outcome: 'applied', released: {} });
    expect(r.status).toBe('closed');
    expect(r.previewTarget).toBeUndefined();
  });

  it('refuses while the row owns a queued todo / activation / repo setup', () => {
    for (const extra of [
      { queued: true },
      { queuedActivationPending: true },
      { queuedActivationTail: [{}] as Session['queuedActivationTail'] },
      { pendingRepoSetup: {} as Session['pendingRepoSetup'] },
    ]) {
      const r = row(extra as Partial<Session>);
      expect(applySessionRowCommand(r, { type: 'prune' }, { now: NOW })).toEqual({ outcome: 'refused', reason: 'protected_ownership' });
      expect(r.status).toBe('active');
    }
  });

  it('is a noop on a closed row even when it still carries protected fields', () => {
    const r = row({ status: 'closed', closedAt: 'c', queued: true });
    expect(applySessionRowCommand(r, { type: 'prune' }, { now: NOW })).toEqual({ outcome: 'noop' });
  });
});

describe('whiteboard', () => {
  it('binds, unbinds, and reports noop for an identical binding', () => {
    const r = row();
    expect(applySessionRowCommand(r, { type: 'whiteboard', whiteboardId: 'wb1' }, { now: NOW })).toEqual({ outcome: 'applied', released: {} });
    expect(r.whiteboardId).toBe('wb1');
    expect(applySessionRowCommand(r, { type: 'whiteboard', whiteboardId: 'wb1' }, { now: NOW })).toEqual({ outcome: 'noop' });
    expect(applySessionRowCommand(r, { type: 'whiteboard', whiteboardId: null }, { now: NOW })).toEqual({ outcome: 'applied', released: {} });
    expect(r.whiteboardId).toBeUndefined();
    expect(applySessionRowCommand(r, { type: 'whiteboard', whiteboardId: null }, { now: NOW })).toEqual({ outcome: 'noop' });
  });

  it('compare-and-set: refuses when the observed binding moved on', () => {
    const r = row({ whiteboardId: 'wb_new' });
    expect(applySessionRowCommand(r, { type: 'whiteboard', whiteboardId: null, expectWhiteboardId: 'wb_deleted' }, { now: NOW }))
      .toEqual({ outcome: 'refused', reason: 'whiteboard_changed' });
    expect(r.whiteboardId).toBe('wb_new');
    expect(applySessionRowCommand(r, { type: 'whiteboard', whiteboardId: null, expectWhiteboardId: 'wb_new' }, { now: NOW }))
      .toEqual({ outcome: 'applied', released: {} });
    expect(r.whiteboardId).toBeUndefined();
  });
});

describe('worker-exited', () => {
  it('clears the pid only when it is the one that exited', () => {
    const r = row({ pid: 4242 });
    expect(applySessionRowCommand(r, { type: 'worker-exited', pid: 9 }, { now: NOW })).toEqual({ outcome: 'refused', reason: 'worker_changed' });
    expect(r.pid).toBe(4242);
    expect(applySessionRowCommand(r, { type: 'worker-exited', pid: 4242 }, { now: NOW })).toEqual({ outcome: 'applied', released: {} });
    expect(r.pid).toBeUndefined();
    expect(applySessionRowCommand(r, { type: 'worker-exited', pid: 4242 }, { now: NOW })).toEqual({ outcome: 'refused', reason: 'worker_changed' });
  });
});
