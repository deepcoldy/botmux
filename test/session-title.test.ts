import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
}));

import * as sessionStore from '../src/services/session-store.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import { buildBotmuxLarkNativeSessionTitle, updateSessionTitle } from '../src/core/session-title.js';

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

describe('buildBotmuxLarkNativeSessionTitle', () => {
  it('brands the title and strips consecutive leading mentions', () => {
    expect(buildBotmuxLarkNativeSessionTitle('@Botmux Oncall @CoCo  排查这个 logid', [
      { name: 'Botmux' },
      { name: 'Botmux Oncall' },
      { name: 'CoCo' },
    ])).toBe('[BotMux·Lark] 排查这个 logid');
  });

  it('keeps ambiguous unstructured text intact instead of splitting a multi-word mention', () => {
    expect(buildBotmuxLarkNativeSessionTitle('@Botmux Oncall 看下这个问题'))
      .toBe('[BotMux·Lark] @Botmux Oncall 看下这个问题');
  });

  it('flattens whitespace and control characters', () => {
    expect(buildBotmuxLarkNativeSessionTitle('  第一行\n\t第二行\u0000  结论')).toBe('[BotMux·Lark] 第一行 第二行 结论');
  });

  it('falls back for empty topic content', () => {
    expect(buildBotmuxLarkNativeSessionTitle('@Botmux', [{ name: 'Botmux' }])).toBe('[BotMux·Lark] 新话题');
    expect(buildBotmuxLarkNativeSessionTitle(undefined)).toBe('[BotMux·Lark] 新话题');
  });

  it('limits the complete title to 100 characters with an ellipsis', () => {
    const title = buildBotmuxLarkNativeSessionTitle('话'.repeat(200));

    expect(Array.from(title)).toHaveLength(100);
    expect(title.startsWith('[BotMux·Lark] ')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('updateSessionTitle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes, persists, and publishes one dashboard patch', () => {
    const session = makeSession();
    const events: DashboardEvent[] = [];
    const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));

    try {
      expect(updateSessionTitle(session, '  First line\n  Second line  ')).toEqual({
        ok: true,
        title: 'First line Second line',
      });
    } finally {
      unsubscribe();
    }

    expect(session.title).toBe('First line Second line');
    expect(session.nativeSessionTitle).toBe('First line Second line');
    expect(session.nativeSessionTitleUserDefined).toBe(true);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(session);
    expect(events).toEqual([{
      type: 'session.update',
      body: { sessionId: 'session-1', patch: { title: 'First line Second line' } },
    }]);
  });

  it('rejects an empty title without mutating or publishing', () => {
    const session = makeSession();
    const events: DashboardEvent[] = [];
    const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));

    try {
      expect(updateSessionTitle(session, '   ')).toEqual({ ok: false, error: 'bad_title' });
    } finally {
      unsubscribe();
    }

    expect(session.title).toBe('Old title');
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
    expect(events).toEqual([]);
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
