import { describe, expect, it } from 'vitest';
import {
  buildDispatchTaskTree, safeRequirementUrl, taskTreeDisplayTitle, recordDispatchLastReport, renderDispatchTaskTreeCard, renderDispatchTaskTreeText,
} from '../src/core/dispatch-task-tree.js';
import type { DispatchRegistry } from '../src/core/dispatch-registry.js';

const ORCH = 'orch-session';
const LOCAL = new Set(['cli_local']);

function entry(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    orchSessionId: ORCH, targetChatId: 'oc_chat', targetAppIds: ['cli_local'],
    title: '子任务', status: 'accepted', createdAt: '2026-11-03T01:00:00.000Z', ...extra,
  };
}

function tree(registry: DispatchRegistry, sessions: Array<Record<string, unknown>> = []) {
  return buildDispatchTaskTree({
    registry, orchSessionId: ORCH, title: '主任务', sessions: sessions as never, localAppIds: LOCAL,
  });
}

describe('buildDispatchTaskTree', () => {
  it('lists only this session\'s dispatches, oldest first', () => {
    const t = tree({
      om_b: entry({ title: 'B', createdAt: '2026-11-03T02:00:00.000Z' }),
      om_a: entry({ title: 'A', createdAt: '2026-11-03T01:00:00.000Z' }),
      om_other: entry({ orchSessionId: 'someone-else' }),
    });
    expect(t.nodes.map(n => n.title)).toEqual(['A', 'B']);
  });

  it('maps report status, receipt and child session to a node state', () => {
    const t = tree({
      om_done: entry({ lastReport: { status: 'completed', at: 'x' } }),
      om_blocked: entry({ lastReport: { status: 'blocked', at: 'x' } }),
      om_failed: entry({ status: 'failed', errorCode: 'TRANSPORT_FAILED' }),
      om_live: entry({ status: 'dispatched' }),
      om_closed: entry({ status: 'dispatched' }),
      om_sent: entry({ status: 'dispatched' }),
    }, [
      { sessionId: 'c1', larkAppId: 'cli_local', rootMessageId: 'om_live', status: 'active' },
      { sessionId: 'c2', larkAppId: 'cli_local', rootMessageId: 'om_closed', status: 'closed' },
    ]);
    const state = Object.fromEntries(t.nodes.map(n => [n.dispatchRoot, n.state]));
    expect(state).toEqual({
      om_done: 'done', om_blocked: 'waiting', om_failed: 'failed',
      om_live: 'running', om_closed: 'closed', om_sent: 'dispatched',
    });
  });

  it('a child that reports after its acceptance timed out shows its reported state', () => {
    const t = tree({ om_late: entry({ status: 'timed_out', lastReport: { status: 'in_progress', line: '开始了', at: 'x' } }) });
    expect(t.nodes[0]).toMatchObject({ state: 'running', lastLine: '开始了' });
    expect(tree({ om_late: entry({ status: 'timed_out' }) }).nodes[0]!.state).toBe('failed');
  });

  it('a re-dispatch into the topic supersedes the earlier completed report', () => {
    const reported = entry({ attemptAt: '2026-11-03T01:00:00.000Z', lastReport: { status: 'completed', line: '做完了', at: '2026-11-03T02:00:00.000Z' } });
    expect(tree({ om_a: reported }).nodes[0]).toMatchObject({ state: 'done', lastLine: '做完了' });
    const redispatched = { ...reported, status: 'accepted', attemptAt: '2026-11-03T03:00:00.000Z' };
    expect(tree({ om_a: redispatched }, [
      { sessionId: 'c', larkAppId: 'cli_local', rootMessageId: 'om_a', status: 'active' },
    ]).nodes[0]).toMatchObject({ state: 'running', lastLine: '已接单' });
  });

  it('a status-less report after a re-dispatch does not revive the earlier status', () => {
    const registry: DispatchRegistry = { om_a: entry({
      attemptAt: '2026-11-03T03:00:00.000Z',
      lastReport: { status: 'completed', line: '做完了', at: '2026-11-03T02:00:00.000Z' },
    }) };
    recordDispatchLastReport(registry, 'om_a', { content: '新任务进展', at: '2026-11-03T04:00:00.000Z' });
    expect(tree(registry, [
      { sessionId: 'c', larkAppId: 'cli_local', rootMessageId: 'om_a', status: 'active' },
    ]).nodes[0]).toMatchObject({ state: 'running', lastLine: '新任务进展' });
  });

  it('a report sent while the dispatcher was still waiting for acceptance counts', () => {
    // attemptAt is taken before the kickoff; the receipt lands after the report.
    const t = tree({ om_a: entry({
      status: 'timed_out', attemptAt: '2026-11-03T01:00:00.000Z', updatedAt: '2026-11-03T01:00:15.000Z',
      lastReport: { status: 'completed', line: '好了', at: '2026-11-03T01:00:05.000Z' },
    }) });
    expect(t.nodes[0]).toMatchObject({ state: 'done', lastLine: '好了' });
  });

  it('a child closed after reporting progress shows as closed; a finished one stays done', () => {
    const closed = [{ sessionId: 'c', larkAppId: 'cli_local', rootMessageId: 'om_a', status: 'closed' }];
    expect(tree({ om_a: entry({ lastReport: { status: 'in_progress', at: 'x' } }) }, closed).nodes[0]!.state).toBe('closed');
    expect(tree({ om_a: entry({ lastReport: { status: 'completed', at: 'x' } }) }, closed).nodes[0]!.state).toBe('done');
  });

  it('ignores a session of another bot in the same topic', () => {
    const t = tree({ om_x: entry({ status: 'dispatched' }) }, [
      { sessionId: 'c', larkAppId: 'cli_other', rootMessageId: 'om_x', status: 'active' },
    ]);
    expect(t.nodes[0]!.state).toBe('dispatched');
  });

  it('marks a child on bots this machine does not host and keeps its receipt state', () => {
    const t = tree({ om_r: entry({ targetAppIds: ['cli_remote'], status: 'accepted' }) }, [
      { sessionId: 'c', larkAppId: 'cli_remote', rootMessageId: 'om_r', status: 'closed' },
    ]);
    expect(t.nodes[0]).toMatchObject({ otherMachine: true, state: 'running', lastLine: '已接单' });
  });

  it('labels review dispatches', () => {
    expect(tree({ om_r: entry({ kind: 'review' }) }).nodes[0]!.kind).toBe('review');
  });
});

describe('recordDispatchLastReport', () => {
  it('records the first line and returns the orchestrator; a status-less report keeps the status', () => {
    const registry: DispatchRegistry = { om_a: entry({}) };
    expect(recordDispatchLastReport(registry, 'om_a', { status: 'blocked', content: '\n  等你确认方案 \n细节', at: 't1' })).toBe(ORCH);
    recordDispatchLastReport(registry, 'om_a', { content: '补充一句', at: 't2' });
    expect((registry.om_a as Record<string, unknown>).lastReport).toEqual({ status: 'blocked', line: '补充一句', at: 't2' });
  });

  it('ignores unknown roots and invalid statuses', () => {
    const registry: DispatchRegistry = { om_a: entry({}) };
    expect(recordDispatchLastReport(registry, 'om_missing', { content: 'x', at: 't' })).toBeUndefined();
    recordDispatchLastReport(registry, 'om_a', { status: 'bogus', content: 'x', at: 't' });
    expect((registry.om_a as Record<string, unknown>).lastReport).toEqual({ line: 'x', at: 't' });
  });

  it('cuts a long line to phone width', () => {
    const registry: DispatchRegistry = { om_a: entry({}) };
    recordDispatchLastReport(registry, 'om_a', { content: '长'.repeat(200), at: 't' });
    const line = ((registry.om_a as Record<string, unknown>).lastReport as { line: string }).line;
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('renderDispatchTaskTreeCard', () => {
  const t = buildDispatchTaskTree({
    registry: {
      om_a: entry({ title: 'fix *bold* [x](y)', lastReport: { status: 'failed', line: '<at id=all></at>', at: '2026-11-03T03:04:00.000Z' } }),
    },
    orchSessionId: ORCH, title: '主任务', requirement: { id: 'REQ-1', url: 'https://example.com/req/1' },
    sessions: [], localAppIds: LOCAL, threadIds: { om_a: 'omt_1' },
  });
  const card = renderDispatchTaskTreeCard(t, { now: new Date('2026-11-03T03:05:00.000Z') });
  const text = JSON.stringify(card);

  it('is a display-only schema 2.0 card that can be patched in place', () => {
    expect(card).toMatchObject({ schema: '2.0', config: { update_multi: true }, header: { template: 'red' } });
    const tags = new Set((card.body as { elements: Array<{ tag: string }> }).elements.map(e => e.tag));
    expect([...tags].every(tag => tag === 'markdown' || tag === 'hr')).toBe(true);
  });

  it('escapes user text so a title or report cannot inject markup or mentions', () => {
    expect(text).not.toMatch(/<at\b/);
    expect(text).not.toMatch(/<\/at>/);
    expect(text).not.toContain('[x](y)');
  });

  it('links the requirement and the child topic', () => {
    expect(text).toContain('https://example.com/req/1');
    expect(text).toContain('omt_1');
  });

  it('a requirement url cannot close its link and add markup', () => {
    const evil = 'https://x.com/a) <at id=all></at> [phish](https://evil.example)';
    const rendered = JSON.stringify(renderDispatchTaskTreeCard({ ...t, requirement: { id: 'R', url: evil } }));
    expect(rendered).not.toMatch(/<at\b/);
    expect(rendered).not.toContain('](https://evil.example)');
    expect(safeRequirementUrl('http://x.com')).toBeUndefined();
    expect(safeRequirementUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeRequirementUrl('https://x.com/req/1')).toBe('https://x.com/req/1');
  });

  it('text rendering lists every node', () => {
    expect(renderDispatchTaskTreeText(t)).toContain('om_a');
  });

  it('cuts long or multi-line titles to one short line for display', () => {
    const long = '长'.repeat(500);
    const wide = buildDispatchTaskTree({
      registry: { om_a: entry({ title: `第一行\n${long}` }) },
      orchSessionId: ORCH, title: long, sessions: [], localAppIds: LOCAL,
    });
    const rendered = JSON.stringify(renderDispatchTaskTreeCard(wide));
    expect(rendered).not.toContain('长'.repeat(40));
    expect(rendered).not.toContain('\\n长');
    expect(renderDispatchTaskTreeText(wide)).not.toContain('长'.repeat(40));
    expect(wide.nodes[0]!.title).toContain(long);
    expect(taskTreeDisplayTitle('a\n b')).toBe('a b');
    expect(taskTreeDisplayTitle('😀'.repeat(41))).toBe(`${'😀'.repeat(39)}…`);
    expect(taskTreeDisplayTitle('短标题')).toBe('短标题');
    expect(taskTreeDisplayTitle('  x  ')).toBe('x');
    expect(taskTreeDisplayTitle('👨‍👩‍👧'.repeat(41))).toBe(`${'👨‍👩‍👧'.repeat(39)}…`);
    const escaped = buildDispatchTaskTree({
      registry: { om_a: entry({ title: `${'a'.repeat(38)}&bc` }), om_b: entry({ title: ' \n ' }) },
      orchSessionId: ORCH, title: 't', sessions: [], localAppIds: LOCAL,
    });
    const card = JSON.stringify(renderDispatchTaskTreeCard(escaped));
    expect(card).toContain(`${'a'.repeat(38)}&amp;…`);
    expect(card).not.toContain('****');
    expect(renderDispatchTaskTreeText(escaped)).toContain('子任务');
  });
});
