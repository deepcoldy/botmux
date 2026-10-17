import { describe, expect, it, vi } from 'vitest';
import { edgePath, layoutAgentGraph, type AgentGraphMetrics } from '../src/dashboard/web/agents-graph-layout.js';
import { syncAgentToBot, syncAgentToBots } from '../src/dashboard/web/agents-api.js';
import { hashQueryParam } from '../src/dashboard/web/dashboard-routes.js';
import type { AgentBotSnapshot, AgentSectionsConfig } from '../src/dashboard/agent-profiles-model.js';

const metrics: AgentGraphMetrics = { agentHeight: 100, botHeight: 40, rowGap: 10, groupGap: 20, unlinkedHeaderHeight: 30 };
const bots = ['b1', 'b2', 'b3', 'b4'].map(larkAppId => ({ larkAppId }));

describe('layoutAgentGraph', () => {
  it('stacks each agent with its own bots so edges never cross, standalone bots last', () => {
    const layout = layoutAgentGraph(
      [{ id: 'a1' }, { id: 'a2' }],
      bots,
      { b3: 'a1', b1: 'a1', b2: 'a2', b4: 'gone' },
      metrics,
    );
    expect(layout.agents).toEqual([
      { id: 'a1', y: 0, height: 100 },
      // a1 段高 = max(agent 100, 2×40+10=90) = 100，再加段间距 20。
      { id: 'a2', y: 120, height: 100 },
    ]);
    expect(layout.bots.map(node => [node.id, node.y, node.agentId])).toEqual([
      ['b1', 0, 'a1'],
      ['b3', 50, 'a1'],
      ['b2', 120, 'a2'],
      // 指向已不存在 Agent 的关联按独立配置处理。
      ['b4', 270, null],
    ]);
    expect(layout.unlinkedTop).toBe(240);
    expect(layout.height).toBe(310);
    expect(layout.edges).toEqual([
      { agentId: 'a1', botId: 'b1', y1: 50, y2: 20 },
      { agentId: 'a1', botId: 'b3', y1: 50, y2: 70 },
      { agentId: 'a2', botId: 'b2', y1: 170, y2: 140 },
    ]);
  });

  it('grows a group to fit many bots and handles the no-agent case', () => {
    const tall = layoutAgentGraph([{ id: 'a' }, { id: 'z' }], bots, { b1: 'a', b2: 'a', b3: 'a' }, metrics);
    expect(tall.agents[1]).toEqual({ id: 'z', y: 3 * 40 + 2 * 10 + 20, height: 100 });
    const none = layoutAgentGraph([], bots.slice(0, 1), {}, metrics);
    expect(none).toMatchObject({ unlinkedTop: 0, height: 70, edges: [] });
  });

  it('draws a horizontal-tangent cubic bezier in normalized coordinates', () => {
    expect(edgePath(10, 90)).toBe('M0,10 C50,10 50,90 100,90');
    expect(edgePath(10, 30, 40)).toBe('M0,10 C20,10 20,30 40,30');
  });
});

describe('syncAgentToBot', () => {
  const agent: AgentSectionsConfig = {
    exec: { cliId: 'codex', model: '', reasoningEffort: '', configDir: '' },
    sandbox: { mode: 'off' },
    startup: { commands: ['/a'] },
  };
  const bot: AgentBotSnapshot = { larkAppId: 'cli_a', online: true, cliId: 'claude-code', sandboxMode: 'off', startupCommands: '' };

  it('pushes only drifted sections and keeps going after a failure', async () => {
    const send = vi.fn(async (_method: string, url: string) => (url.endsWith('/agent')
      ? { ok: true, status: 200, body: { ok: true, closedMismatchedSessions: 2, closedMismatchedResidual: 1, availabilityWarning: 'not installed' } }
      : { ok: false, status: 400, body: { ok: false, error: 'invalid_startup' } }));
    const result = await syncAgentToBot(agent, bot, send as any);
    expect(send.mock.calls.map(call => call[1])).toEqual(['/api/bots/cli_a/agent', '/api/bots/cli_a/startup-commands']);
    expect(result).toEqual({
      larkAppId: 'cli_a',
      pushed: ['exec'],
      failures: [{ section: 'startup', error: 'invalid_startup' }],
      warnings: ['not installed'],
      closedSessions: 2,
      residualSessions: 1,
    });
  });

  it('does not call an offline daemon', async () => {
    const send = vi.fn();
    const result = await syncAgentToBot(agent, { ...bot, online: false }, send as any);
    expect(send).not.toHaveBeenCalled();
    expect(result.failures).toEqual([{ section: 'exec', error: 'offline' }]);
  });

  it('returns results in input order for an empty / synced fleet', async () => {
    expect(await syncAgentToBots(agent, [])).toEqual([]);
  });
});

describe('hashQueryParam', () => {
  it('reads query params from the hash route only', () => {
    expect(hashQueryParam('bot', '#/bot-defaults?bot=cli_a&x=1')).toBe('cli_a');
    expect(hashQueryParam('bot', '#/bot-defaults')).toBeNull();
    expect(hashQueryParam('bot', '#/bot-defaults?bot=')).toBeNull();
  });
});
