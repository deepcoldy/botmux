import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { effectiveSessionCliId, requestAgentSessionRename } from '../src/core/session-rename.js';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'session-rename-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'Old title',
      status: 'active',
      createdAt: '2026-07-15T00:00:00.000Z',
      cliId: 'codex',
      cliPathOverride: '/bin/codex',
      backendType: 'tmux',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: true,
    ...overrides,
  };
}

function liveWorker(send = vi.fn()): any {
  return { killed: false, connected: true, send };
}

describe('requestAgentSessionRename', () => {
  it.each([
    ['codex', '/bin/codex'],
    ['claude-code', '/bin/claude'],
  ] as const)('sends the dedicated IPC for live %s sessions', (cliId, cliPathOverride) => {
    const send = vi.fn();
    const ds = makeDs({
      session: { ...makeDs().session, cliId, cliPathOverride },
      worker: liveWorker(send),
    });

    expect(requestAgentSessionRename(ds, '统一标题')).toEqual({ status: 'requested', cliId });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: 'rename_session', title: '统一标题' });
  });

  it('uses adopted CLI metadata ahead of a stale persisted session CLI', () => {
    const send = vi.fn();
    const ds = makeDs({
      session: { ...makeDs().session, cliId: 'claude-code', cliPathOverride: '/bin/claude' },
      adoptedFrom: { cliId: 'codex', cwd: '/repo' },
      worker: liveWorker(send),
    });

    expect(effectiveSessionCliId(ds)).toBe('codex');
    expect(requestAgentSessionRename(ds, 'Adopt title')).toEqual({ status: 'requested', cliId: 'codex' });
    expect(send).toHaveBeenCalledWith({ type: 'rename_session', title: 'Adopt title' });
  });

  it.each([
    ['seed', '/bin/true'],
    ['codex-app', '/bin/codex'],
    ['coco', '/bin/coco'],
  ] as const)('does not leak native rename to unsupported %s adapters', (cliId, cliPathOverride) => {
    const send = vi.fn();
    const ds = makeDs({
      session: { ...makeDs().session, cliId, cliPathOverride },
      worker: liveWorker(send),
    });

    expect(requestAgentSessionRename(ds, 'No leak')).toEqual({ status: 'unsupported', cliId });
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends a TUI command through the riff backend', () => {
    const send = vi.fn();
    const ds = makeDs({
      session: { ...makeDs().session, backendType: 'riff' },
      worker: liveWorker(send),
    });

    expect(requestAgentSessionRename(ds, 'Remote')).toEqual({ status: 'unsupported', cliId: 'codex' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['killed', { killed: true, connected: true, send: vi.fn() }],
    ['disconnected', { killed: false, connected: false, send: vi.fn() }],
  ])('reports not_running for a %s worker', (_label, worker) => {
    expect(requestAgentSessionRename(makeDs({ worker: worker as any }), 'Local only'))
      .toEqual({ status: 'not_running', cliId: 'codex' });
  });

  it('keeps the local rename successful when worker IPC throws', () => {
    const ds = makeDs({
      worker: liveWorker(vi.fn(() => { throw new Error('channel closed'); })),
    });

    expect(requestAgentSessionRename(ds, 'Still local')).toEqual({
      status: 'failed',
      cliId: 'codex',
      error: 'channel closed',
    });
  });
});
