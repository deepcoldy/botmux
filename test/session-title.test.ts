import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
}));

import * as sessionStore from '../src/services/session-store.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import {
  normalizeSessionTitleSource,
  updateSessionTitle,
} from '../src/core/session-title.js';

function makeSession(): Session {
  return {
    sessionId: 'session-1',
    chatId: 'chat-1',
    rootMessageId: 'root-1',
    title: 'Old title',
    status: 'active',
    createdAt: '2026-07-13T00:00:00.000Z',
  };
}

describe('updateSessionTitle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes, persists, and publishes one dashboard patch with title metadata', () => {
    const session = makeSession();
    const events: DashboardEvent[] = [];
    const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));
    let result;

    try {
      result = updateSessionTitle(session, '  First line\n  Second line  ', 'agent');
    } finally {
      unsubscribe();
    }

    expect(result).toMatchObject({
      ok: true,
      title: 'First line Second line',
      source: 'agent',
    });
    expect(session).toMatchObject({
      title: 'First line Second line',
      titleSource: 'agent',
      titleUpdatedAt: expect.any(String),
    });
    expect(sessionStore.updateSession).toHaveBeenCalledWith(session);
    expect(events).toEqual([{
      type: 'session.update',
      body: {
        sessionId: 'session-1',
        patch: {
          title: 'First line Second line',
          titleUpdatedAt: session.titleUpdatedAt,
          titleSource: 'agent',
        },
      },
    }]);
  });

  it('rejects an empty title without mutating or publishing', () => {
    const session = makeSession();
    const events: DashboardEvent[] = [];
    const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));

    try {
      expect(updateSessionTitle(session, '   ', 'dashboard')).toEqual({
        ok: false,
        error: 'bad_title',
      });
    } finally {
      unsubscribe();
    }

    expect(session.title).toBe('Old title');
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('normalizes untrusted source labels to the caller fallback', () => {
    expect(normalizeSessionTitleSource('agent', 'dashboard')).toBe('agent');
    expect(normalizeSessionTitleSource('spoofed', 'dashboard')).toBe('dashboard');
  });

  it('keeps the canonical dashboard title separate from temporary TUI prompt labels', async () => {
    const { readFileSync } = await import('node:fs');
    const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
    const start = workerPoolSource.indexOf("case 'tui_prompt':");
    const end = workerPoolSource.indexOf("case 'tui_prompt_resolved':", start);
    const region = workerPoolSource.slice(start, end);

    expect(region).toContain('ds.currentTurnTitle = msg.description');
    expect(region).not.toContain('patch: { title:');
    expect(region).not.toContain('patch: {\n                title:');
  });
});
