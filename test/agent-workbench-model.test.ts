import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_RAIL_DEFAULT,
  attentionSummary,
  buildWorkbenchHash,
  classifyWorkbenchSession,
  computeVirtualWindow,
  defaultWorkbenchLayout,
  deriveResponsiveWorkbenchLayout,
  flattenWorkbenchGroups,
  formatWorkbenchRelativeTime,
  groupWorkbenchSessions,
  isValidPaneTree,
  normalizeWorkbenchLayout,
  paneTreeForLayout,
  parseWorkbenchHash,
  safeWorkbenchReturnTo,
  workbenchExternalTerminalHref,
  workbenchPreviewHref,
  workbenchTerminalHref,
  type WorkbenchSessionRow,
} from '../src/dashboard/web/agent-workbench-model.js';

function session(index: number, patch: Partial<WorkbenchSessionRow> = {}): WorkbenchSessionRow {
  return {
    sessionId: `session-${index}`,
    status: 'working',
    title: `Complete searchable title ${index}`,
    botName: index % 2 ? 'Reviewer' : 'Builder',
    cliId: 'codex',
    lastMessageAt: 1_700_000_000_000 + index,
    ...patch,
  };
}

describe('Agent Workbench pure model', () => {
  it('builds and parses independent main/Dock routes without catching malformed ids', () => {
    expect(buildWorkbenchHash('main', 'a/b c')).toBe('#/agent-workbench/a%2Fb%20c');
    expect(buildWorkbenchHash('dock', 'a/b c')).toBe('#/agent-workbench-dock/a%2Fb%20c');
    expect(parseWorkbenchHash('#/agent-workbench/a%2Fb%20c')).toEqual({ surface: 'main', sessionId: 'a/b c' });
    expect(parseWorkbenchHash('#/agent-workbench-dock/a%2Fb%20c')).toEqual({ surface: 'dock', sessionId: 'a/b c' });
    expect(parseWorkbenchHash('#/agent-workbench/%E0%A4%A')).toBeNull();
    expect(safeWorkbenchReturnTo('/#/agent-workbench-dock/a%2Fb')).toBe('/#/agent-workbench-dock/a%2Fb');
    expect(safeWorkbenchReturnTo('/#/settings')).toBe('/');
  });

  it('keeps a 200px default rail, clamps persistence, and limits the pane tree to Terminal/Web', () => {
    const defaults = defaultWorkbenchLayout();
    expect(defaults.railWidth).toBe(WORKBENCH_RAIL_DEFAULT);
    expect(normalizeWorkbenchLayout({ railWidth: 2, splitRatio: 99, focus: 'chat', paneMode: 'split' })).toMatchObject({
      railWidth: 176,
      splitRatio: 0.72,
      focus: 'terminal',
      paneMode: 'split',
    });
    const tree = paneTreeForLayout({ ...defaults, paneMode: 'split', splitAxis: 'vertical' });
    expect(isValidPaneTree(tree)).toBe(true);
    expect(JSON.stringify(tree)).toContain('terminal');
    expect(JSON.stringify(tree)).toContain('web');
    expect(JSON.stringify(tree)).not.toContain('chat');
    expect(JSON.stringify(tree)).not.toContain('info');
    expect(isValidPaneTree({ type: 'pane', pane: 'chat' })).toBe(false);
    expect(isValidPaneTree({ type: 'pane', pane: 'info' })).toBe(false);
  });

  it('applies the ordered 1280px degradation and fixed mobile stack', () => {
    const requested = { ...defaultWorkbenchLayout(), paneMode: 'split' as const, chatRequested: true };
    expect(deriveResponsiveWorkbenchLayout(1440, requested)).toMatchObject({ step: 'full', railCollapsed: false, paneMode: 'split', chatMode: 'native-split' });
    expect(deriveResponsiveWorkbenchLayout(1279, requested)).toMatchObject({ step: 'rail-collapsed', railCollapsed: true, paneMode: 'split', chatMode: 'native-split' });
    expect(deriveResponsiveWorkbenchLayout(1119, requested)).toMatchObject({ step: 'focus', railCollapsed: true, paneMode: 'focus', chatMode: 'native-split' });
    expect(deriveResponsiveWorkbenchLayout(959, requested)).toMatchObject({ step: 'chat-jump', railCollapsed: true, paneMode: 'focus', chatMode: 'jump' });
    expect(deriveResponsiveWorkbenchLayout(600, requested)).toEqual({ mode: 'mobile', step: 'mobile-stack', railCollapsed: true, paneMode: 'focus', chatMode: 'jump' });
  });

  it('groups NEEDS YOU / ACTIVE / RECENT with reason summaries and full-text search', () => {
    const rows = [
      session(1, { agentAttention: { reason: 'Approve migration', at: 1_800_000_000_030 } }),
      session(2, { pendingRepo: true }),
      session(3),
      session(4, { status: 'dormant' }),
      session(5, { status: 'closed' }),
    ];
    const groups = groupWorkbenchSessions(rows);
    expect(groups['needs-you'].map(row => row.sessionId)).toEqual(['session-1', 'session-2']);
    expect(groups.active.map(row => row.sessionId)).toEqual(['session-3']);
    expect(groups.recent.map(row => row.sessionId)).toEqual(['session-5', 'session-4']);
    expect(attentionSummary(rows[0])).toBe('Approve migration');
    expect(classifyWorkbenchSession(rows[4])).toBe('recent');
    expect(groupWorkbenchSessions(rows, 'searchable title 4').recent.map(row => row.sessionId)).toEqual(['session-4']);
    expect(flattenWorkbenchGroups(groups).filter(item => item.kind === 'header')).toHaveLength(3);
  });

  it('windows 300+ sessions to a bounded render slice', () => {
    const rows = Array.from({ length: 320 }, (_, index) => session(index));
    const items = flattenWorkbenchGroups(groupWorkbenchSessions(rows));
    const window = computeVirtualWindow(items, 8_000, 640);
    expect(items.length).toBe(323);
    expect(window.totalHeight).toBeGreaterThan(19_000);
    expect(window.end - window.start).toBeLessThan(24);
    expect(window.start).toBeGreaterThan(100);
  });

  it('formats relative times and keeps terminal URLs on the signed same-origin front proxy', () => {
    const now = 10_000_000;
    expect(formatWorkbenchRelativeTime(now, now + 10, 'en')).toBe('just now');
    expect(formatWorkbenchRelativeTime(now - 3_600_000, now, 'en')).toContain('hr');
    expect(workbenchTerminalHref(
      session(1, { webPort: 9000, proxyPort: 8080 }),
      { protocol: 'https:', origin: 'https://dashboard.example', hostname: 'dashboard.example' },
    )).toBe('https://dashboard.example/s/session-1');
    expect(workbenchTerminalHref(
      session(1, { webPort: 9000, proxyPort: 8080 }),
      { protocol: 'http:', origin: 'http://dashboard.local:24000', hostname: 'dashboard.local' },
    )).toBe('http://dashboard.local:24000/s/session-1');
    expect(workbenchTerminalHref(
      session(1, { webPort: 9000 }),
      { protocol: 'http:', origin: 'http://dashboard.local:24000', hostname: 'dashboard.local' },
    )).toBeNull();
    expect(workbenchExternalTerminalHref(session(1, { riffAccessUrl: 'javascript:alert(1)' }))).toBeNull();
    expect(workbenchPreviewHref(session(1, {
      preview: { path: '/preview/session-2/', registeredAt: new Date().toISOString() },
    }))).toBeNull();
    expect(workbenchPreviewHref(session(1, {
      preview: { path: '/preview/session-1/', registeredAt: new Date().toISOString() },
    }))).toBe('/preview/session-1/');
  });
});
