import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGraphLayout,
  buildRoundMiniDagLayout,
  isTerminalRunStatus,
  loopInstances,
  resolveLoopTerminalNode,
  v3RunIdFromHash,
} from '../src/dashboard/web/v3-model.js';
import {
  fetchV3RunDetail,
  fetchV3Runs,
  probeLegacyV2RunSnapshot,
  shouldProbeLegacyV2Fallback,
  type V3Fetch,
} from '../src/dashboard/web/v3-api.js';
import {
  buildNodeTerminalRender,
  buildReplayTerminalSrcdoc,
  liveTerminalUrl,
  nodeTerminalSignature,
} from '../src/dashboard/web/v3-terminal.js';
import type { RunNodeView, RunSummary, RunView } from '../src/workflows/v3/ops-projection.js';

function node(overrides: Partial<RunNodeView> = {}): RunNodeView {
  return {
    id: 'node-a',
    status: 'pending',
    depends: [],
    hasPtyLog: false,
    hasManifest: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function view(nodes: RunNodeView[], status: RunView['runStatus'] = 'running'): RunView {
  return {
    runId: 'run-1',
    runStatus: status,
    nodes,
  };
}

function response(ok: boolean, status: number, body: unknown = {}): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('v3 dashboard model', () => {
  it('stops detail polling only for succeeded/failed, not blocked', () => {
    expect(isTerminalRunStatus('succeeded')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('blocked')).toBe(false);
    expect(isTerminalRunStatus('running')).toBe(false);
  });

  it('parses v3 run ids from workflow hashes', () => {
    expect(v3RunIdFromHash('#/workflows/r-260602-0907')).toBe('r-260602-0907');
    expect(v3RunIdFromHash('#/workflows/run%20with%20space?tab=dag')).toBe('run with space');
    expect(v3RunIdFromHash('#/legacy-workflow/r-1')).toBeNull();
  });

  it('lays out the main DAG without loop body instances and marks live edges', () => {
    const a = node({ id: 'a', status: 'done' });
    const b = node({ id: 'b', status: 'running', depends: ['a'] });
    const loop = node({
      id: 'repairLoop',
      status: 'running',
      depends: ['b'],
      isLoop: true,
      loopState: {
        iteration: 2,
        maxIterations: 2,
        granted: 1,
        decisions: [{ iteration: 1, decision: 'continue' }],
        bodyTemplate: [{ id: 'code', depends: [] }],
      },
    });
    const inst = node({
      id: 'repairLoop.i002.code',
      status: 'running',
      loop: { loopId: 'repairLoop', iteration: 2, bodyNodeId: 'code' },
    });

    const layout = buildGraphLayout(view([a, b, loop, inst]));
    expect(layout.nodes.map((box) => box.node.id)).toEqual(['a', 'b', 'repairLoop']);
    expect(layout.edges.map((edge) => `${edge.fromId}->${edge.toId}:${edge.live}`)).toEqual([
      'a->b:true',
      'b->repairLoop:true',
    ]);
  });

  it('resolves loop terminal target from pinned instance or live frontier', () => {
    const first = node({
      id: 'loop.i001.code',
      status: 'done',
      loop: { loopId: 'loop', iteration: 1, bodyNodeId: 'code' },
    });
    const second = node({
      id: 'loop.i002.code',
      status: 'running',
      loop: { loopId: 'loop', iteration: 2, bodyNodeId: 'code' },
    });
    const third = node({
      id: 'loop.i002.test',
      status: 'running',
      loop: { loopId: 'loop', iteration: 2, bodyNodeId: 'test' },
    });

    expect(resolveLoopTerminalNode([first, second, third], null, false)?.id).toBe('loop.i002.test');
    expect(resolveLoopTerminalNode([first, second, third], first.id, true)?.id).toBe(first.id);
    expect(resolveLoopTerminalNode([first], null, false)?.id).toBe(first.id);
  });

  it('groups loop body instances by structured loop metadata and keeps mini-dag ghosts', () => {
    const loopNode = node({ id: 'loop', isLoop: true });
    const instance = node({
      id: 'loop.i001.code',
      status: 'done',
      loop: { loopId: 'loop', iteration: 1, bodyNodeId: 'code' },
    });
    expect(loopInstances(view([loopNode, instance]), 'loop').map((item) => item.id)).toEqual([instance.id]);

    const layout = buildRoundMiniDagLayout(
      [{ id: 'code', depends: [] }, { id: 'test', depends: ['code'] }],
      new Map([['code', instance]]),
    );
    expect(layout.nodes.map((box) => [box.templateId, Boolean(box.node)])).toEqual([
      ['code', true],
      ['test', false],
    ]);
    expect(layout.edges.map((edge) => `${edge.fromId}->${edge.toId}`)).toEqual(['code->test']);
  });
});

describe('v3 dashboard api helpers', () => {
  it('fetches list/detail endpoints and encodes run ids', async () => {
    const runs: RunSummary[] = [{ runId: 'r-1', runStatus: 'running', nodeCount: 2 }];
    const calls: string[] = [];
    const fetcher: V3Fetch = async (input) => {
      calls.push(input);
      if (input === '/api/v3/runs') return response(true, 200, { runs });
      return response(true, 200, view([], 'succeeded'));
    };

    await expect(fetchV3Runs(fetcher)).resolves.toEqual(runs);
    await expect(fetchV3RunDetail('run/id with space', fetcher)).resolves.toMatchObject({
      ok: true,
      view: { runStatus: 'succeeded' },
    });
    expect(calls).toEqual(['/api/v3/runs', '/api/v3/runs/run%2Fid%20with%20space']);
  });

  it('returns empty/non-ok results and probes legacy v2 fallback only once per 404 path', async () => {
    await expect(fetchV3Runs(async () => response(false, 500))).resolves.toEqual([]);
    await expect(fetchV3RunDetail('missing', async () => response(false, 404))).resolves.toEqual({ ok: false, status: 404 });
    expect(shouldProbeLegacyV2Fallback(404, false)).toBe(true);
    expect(shouldProbeLegacyV2Fallback(404, true)).toBe(false);
    expect(shouldProbeLegacyV2Fallback(500, false)).toBe(false);

    const calls: string[] = [];
    const exists = await probeLegacyV2RunSnapshot('old/run', async (input) => {
      calls.push(input);
      return response(true, 200);
    });
    expect(exists).toBe(true);
    expect(calls).toEqual(['/api/workflows/runs/old%2Frun/snapshot']);
  });
});

describe('v3 terminal render helpers', () => {
  it('keeps terminal signatures scoped to terminal-relevant inputs', () => {
    const base = node({ goal: 'old', status: 'pending' });
    expect(nodeTerminalSignature(base)).toBe(nodeTerminalSignature({ ...base, goal: 'new', status: 'blocked' }));
    expect(nodeTerminalSignature(base)).not.toBe(nodeTerminalSignature({ ...base, hasPtyLog: true }));
    expect(nodeTerminalSignature(node({
      webTerminal: { sessionId: 's', status: 'live', webPort: 3000 },
    }))).not.toBe(nodeTerminalSignature(node({
      webTerminal: { sessionId: 's', status: 'live', webPort: 3001 },
    })));
    expect(nodeTerminalSignature(node({
      webTerminal: { sessionId: 's1', status: 'live', webPort: 3000 },
    }))).not.toBe(nodeTerminalSignature(node({
      webTerminal: { sessionId: 's2', status: 'live', webPort: 3000 },
    })));
  });

  it('renders live, replay, and empty terminal modes', () => {
    const live = buildNodeTerminalRender('run-1', node({
      id: 'work',
      webTerminal: { sessionId: 's', status: 'live', webPort: 3000 },
    }), { host: 'dash.local' });
    expect(live.kind).toBe('live');
    expect(live.html).toContain('http://dash.local:3000/');
    expect(live.html).toContain('v3 live terminal');

    const replay = buildNodeTerminalRender('run 1', node({
      id: 'repair/node',
      hasPtyLog: true,
      webTerminal: { sessionId: 's', status: 'closed' },
    }));
    expect(replay.kind).toBe('replay');
    expect(replay.html).toContain('/api/v3/runs/run%201/nodes/repair%2Fnode/pty-log');
    expect(replay.html).toContain('v3-terminal-dot closed');

    expect(buildNodeTerminalRender('run-1', node({
      webTerminal: { sessionId: 's', status: 'live' },
    })).html).toContain('终端正在启动');
    expect(buildNodeTerminalRender('run-1', node()).html).toContain('暂无终端记录');
  });

  it('uses same-origin terminal proxy for live v3 terminals under HTTPS', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        origin: 'https://dash.example',
        hostname: 'dash.example',
      },
    });

    expect(liveTerminalUrl(3000, undefined, 'sess/live 1')).toBe('https://dash.example/s/sess%2Flive%201');
    expect(liveTerminalUrl(3000, 'dash.local', 'sess-live')).toBe('https://dash.example/s/sess-live');
  });

  it('keeps replay iframe behavior for auth errors, missing logs, truncation, and 160 cols', () => {
    const srcdoc = buildReplayTerminalSrcdoc('/api/v3/runs/r/nodes/n/pty-log', 'r / n');
    expect(srcdoc).toContain('var COLS=160;');
    expect(srcdoc).toContain('term.resize(COLS');
    expect(srcdoc).toContain("fetch(endpoint,{credentials:'include'})");
    expect(srcdoc).toContain('res.status===401');
    expect(srcdoc).toContain('res.status===404');
    expect(srcdoc).toContain('x-botmux-truncated');
    expect(srcdoc).toContain('showing tail');
  });
});
