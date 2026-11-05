import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import {
  V3_DISPLAY_LABEL,
  V3_DISPLAY_STATUS,
  buildGraphLayout,
  buildRoundMiniDagLayout,
  formatV3Duration,
  isTerminalRunStatus,
  loopInstances,
  nodeBotLine,
  nodeRevisionBadge,
  nodeStatusLine,
  nodeWaitingMs,
  V3_CHECKPOINT_LABEL,
  resolveLoopTerminalNode,
  v3RunIdFromHash,
} from '../src/dashboard/web/v3-model.js';
import {
  cancelV3Run,
  fetchV3RunDetail,
  fetchV3Runs,
  type V3Fetch,
} from '../src/dashboard/web/v3-api.js';
import {
  buildNodeTerminalRender,
  buildReplayTerminalSrcdoc,
  liveTerminalUrl,
  nodeTerminalSignature,
} from '../src/dashboard/web/v3-terminal.js';
import type { RunNodeView, RunSummary, RunView } from '../src/workflows/v3/ops-projection.js';
import { DagNode, NodeExecution, NodeInterventions, V3CancelButton } from '../src/dashboard/web/v3-components.js';
import { ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function node(overrides: Partial<RunNodeView> = {}): RunNodeView {
  return {
    id: 'node-a',
    status: 'pending',
    depends: [],
    hasPtyLog: false,
    hasManifest: false,
    attempts: [],
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
    generatedAt: 0,
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
  it('stops detail polling for terminal states, but keeps polling through cancelling/blocked', () => {
    expect(isTerminalRunStatus('succeeded')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('cancelled')).toBe(true);
    expect(isTerminalRunStatus('cancelling')).toBe(false);
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

  it('returns empty/non-ok results without probing a retired v2 surface', async () => {
    await expect(fetchV3Runs(async () => response(false, 500))).resolves.toEqual([]);
    await expect(fetchV3RunDetail('missing', async () => response(false, 404))).resolves.toEqual({ ok: false, status: 404 });
  });

  it('posts v3 cancel with an encoded run id and preserves cancelling/cancelled outcomes', async () => {
    const fetcher = vi.fn<V3Fetch>(async () => response(true, 202, {
      ok: true,
      runId: 'run/id',
      status: 'cancelling',
    }));
    await expect(cancelV3Run('run/id', fetcher)).resolves.toEqual({
      ok: true,
      runId: 'run/id',
      runStatus: 'cancelling',
    });
    expect(fetcher).toHaveBeenCalledWith('/api/v3/runs/run%2Fid/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    await expect(cancelV3Run('done', async () => response(true, 200, {
      ok: true,
      status: 'cancelled',
      alreadyTerminal: true,
    }))).resolves.toEqual({
      ok: true,
      runStatus: 'cancelled',
      alreadyTerminal: true,
    });
  });

  it('returns a safe v3 cancel error for JSON and non-JSON failures', async () => {
    await expect(cancelV3Run('r-1', async () => response(false, 409, {
      ok: false,
      error: 'needs_cli_cancel',
    }))).resolves.toEqual({ ok: false, status: 409, error: 'needs_cli_cancel' });

    await expect(cancelV3Run('r-1', async () => ({
      ok: false,
      status: 401,
      json: async () => { throw new Error('HTML auth wall'); },
    }) as Response)).resolves.toEqual({ ok: false, status: 401, error: 'http_401' });
  });
});

describe('v3 dashboard cancel control', () => {
  it('enables only non-terminal runs and disables throughout cancelling/cancelled', () => {
    const onCancel = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(V3CancelButton, {
        runStatus: 'running',
        busy: false,
        onCancel,
      }));
    });
    let button = renderer.root.findByType('button');
    expect(button.props.disabled).toBe(false);
    act(() => { button.props.onClick(); });
    expect(onCancel).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(React.createElement(V3CancelButton, {
        runStatus: 'cancelling',
        busy: false,
        onCancel,
      }));
    });
    button = renderer.root.findByType('button');
    expect(button.props.disabled).toBe(true);

    act(() => {
      renderer.update(React.createElement(V3CancelButton, {
        runStatus: 'cancelled',
        busy: false,
        onCancel,
      }));
    });
    button = renderer.root.findByType('button');
    expect(button.props.disabled).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it('does not render a mutation affordance for public read-only visitors', () => {
    const previous = ui.authed;
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      ui.authed = false;
      act(() => {
        renderer = TestRenderer.create(React.createElement(V3CancelButton, {
          runStatus: 'running',
          busy: false,
          onCancel: vi.fn(),
        }));
      });
      expect(renderer.toJSON()).toBeNull();
    } finally {
      if (renderer) act(() => { renderer.unmount(); });
      ui.authed = previous;
    }
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

describe('v3 dashboard 节点：负责 Bot、五类状态与耗时', () => {
  const MIN = 60_000;

  it('把节点状态归成 等待/进行中/完成/失败/等人工确认 五类，审批等待与受阻都算等人工确认', () => {
    expect(V3_DISPLAY_LABEL[V3_DISPLAY_STATUS.pending]).toBe('等待');
    expect(V3_DISPLAY_LABEL[V3_DISPLAY_STATUS.running]).toBe('进行中');
    expect(V3_DISPLAY_LABEL[V3_DISPLAY_STATUS.done]).toBe('完成');
    expect(V3_DISPLAY_LABEL[V3_DISPLAY_STATUS.failed]).toBe('失败');
    expect(V3_DISPLAY_STATUS.gateWaiting).toBe('needsHuman');
    expect(V3_DISPLAY_STATUS.blocked).toBe('needsHuman');
    expect(V3_DISPLAY_LABEL.needsHuman).toBe('等人工确认');
  });

  it('耗时按秒/分/时/天压缩显示，负值归零', () => {
    expect(formatV3Duration(-5)).toBe('0秒');
    expect(formatV3Duration(45_000)).toBe('45秒');
    expect(formatV3Duration(6 * MIN + 59_000)).toBe('6分');
    expect(formatV3Duration(60 * MIN)).toBe('1时');
    expect(formatV3Duration(80 * MIN)).toBe('1时20分');
    expect(formatV3Duration(27 * 60 * MIN)).toBe('1天3时');
  });

  it('状态行：进行中按服务端时钟走秒，结束后固定为实际用时，重试显示第几次', () => {
    const running = node({ status: 'running', startedAt: 1_000, attempts: [{ attemptId: 'a/1', startedAt: 1_000 }] });
    expect(nodeStatusLine(running, 1_000 + 6 * MIN)).toBe('进行中 · 6分');
    const done = node({
      status: 'done', startedAt: 10_000, endedAt: 10_000 + 12 * MIN,
      attempts: [
        { attemptId: 'a/1', startedAt: 0, endedAt: 5_000, outcome: 'blocked' },
        { attemptId: 'a/2', startedAt: 10_000, endedAt: 10_000 + 12 * MIN, outcome: 'succeeded' },
      ],
    });
    // later polls do not keep growing a finished node's time
    expect(nodeStatusLine(done, 10_000 + 99 * MIN)).toBe('完成 · 12分 · 第2次');
    expect(nodeStatusLine(node({ status: 'gateWaiting', gateSince: 0 }), 5 * MIN)).toBe('等人工确认 · 审批');
    expect(nodeStatusLine(node({ status: 'blocked', startedAt: 0, endedAt: MIN }), 9 * MIN)).toBe('等人工确认 · 受阻');
    expect(nodeStatusLine(node({ status: 'pending' }), 9 * MIN)).toBe('等待');
  });

  it('状态行：未开始且在等检查点的节点显示「等检查点」，优先于普通「等待」', () => {
    // M23: waitingOnCheckpoint renders on the graph node (ops-projection).
    expect(nodeStatusLine(node({ status: 'pending', waitingOnCheckpoint: ['survey'] }), 9 * MIN)).toBe('等待 · 等检查点');
    // Only pending nodes wait; a running node never shows it.
    expect(nodeStatusLine(node({ status: 'running', startedAt: 0, waitingOnCheckpoint: ['survey'] }), 9 * MIN)).toBe('进行中 · 9分');
    expect(nodeStatusLine(node({ status: 'pending' }), 9 * MIN)).toBe('等待');
  });

  it('检查点三态标签：holding / reviewed / notReviewed 文案各不相同', () => {
    // M24: the dashboard must distinguish "reviewed by the main bot" from
    // "went on without that review" (a failed delivery, a closed session,
    // the timeout) — collapsing them would hide a safety event.
    expect(V3_CHECKPOINT_LABEL.holding).toBe('检查点：等主 Bot 看完结果，后续节点暂停');
    expect(V3_CHECKPOINT_LABEL.reviewed).toBe('检查点：主 Bot 已看过结果');
    expect(V3_CHECKPOINT_LABEL.notReviewed).toBe('检查点：没等到主 Bot 看结果，已按原流程继续');
    expect(new Set(Object.values(V3_CHECKPOINT_LABEL)).size).toBe(3);
  });

  it('等人时长：审批从发卡算起，受阻从卡住算起', () => {
    expect(nodeWaitingMs(node({ status: 'gateWaiting', gateSince: MIN }), 4 * MIN)).toBe(3 * MIN);
    expect(nodeWaitingMs(node({ status: 'blocked', startedAt: 0, endedAt: 2 * MIN }), 7 * MIN)).toBe(5 * MIN);
    expect(nodeWaitingMs(node({ status: 'running', startedAt: 0 }), 7 * MIN)).toBeUndefined();
  });

  it('Bot 行：优先显示飞书名称，其次 appId / 选择器；宿主节点显示执行器', () => {
    expect(nodeBotLine(node({ bot: { larkAppId: 'cli_a', name: '文档Bot', cliId: 'claude-code' } }))).toBe('文档Bot · claude-code');
    expect(nodeBotLine(node({ bot: { larkAppId: 'cli_a' } }))).toBe('cli_a');
    expect(nodeBotLine(node({ bot: { selector: 'reviewer' } }))).toBe('reviewer');
    expect(nodeBotLine(node({ host: { executor: 'feishu-send' } }))).toBe('宿主动作 · feishu-send');
    expect(nodeBotLine(node())).toBe('');
  });

  it('流程图节点框依次渲染节点名、负责 Bot、状态和耗时', () => {
    const n = node({
      id: 'write-report', status: 'running', startedAt: 0,
      bot: { larkAppId: 'cli_doc', name: '文档Bot', cliId: 'codex' },
      attempts: [{ attemptId: 'w/1', startedAt: 0 }],
    });
    const layout = buildGraphLayout(view([n]));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement('svg', null, React.createElement(DagNode, {
        box: layout.nodes[0]!, generatedAt: 3 * MIN, selected: false, onSelect: vi.fn(),
      })));
    });
    const texts = renderer.root.findAllByType('text').map((t) => t.children.join(''));
    expect(texts).toEqual(['write-report', '文档Bot · codex', '进行中 · 3分']);
    const g = renderer.root.findByType('g');
    expect(g.props.className).toContain('ds-running');
    act(() => { renderer.unmount(); });
  });

  describe('节点框第一行：修改徽标不压住节点名', () => {
    // Independent width model, upper bounds: the id is 12px monospace (0.6em a
    // character); the badge is 10px — CJK 1em, anything else at most 0.6em.
    const idPx = (text: string) => [...text].length * 12 * 0.6;
    const badgePx = (text: string) => [...text].reduce((sum, ch) => sum + (/[\u2e80-\u9fff]/.test(ch) ? 10 : 6), 0);
    const marks: Array<Partial<RunNodeView>> = [
      { pendingChange: 'add' }, { pendingChange: 'remove' }, { pendingChange: 'change' },
      { revisionMark: 'added' }, { revisionMark: 'changed' },
    ];
    const ids = ['collect_release_notes_v2', 'a'];
    const renderBox = (n: RunNodeView, width: number) => renderToStaticMarkup(React.createElement('svg', null,
      React.createElement(DagNode, { box: { node: n, x: 0, y: 0, width, height: 66 }, generatedAt: 0, selected: false, onSelect: vi.fn() })));
    const heading = (html: string) => {
      const id = /class="v3r-nid" x="([\d.]+)"[^>]*>([^<]*)</.exec(html);
      const badge = /class="v3r-nrev" x="([\d.]+)"[^>]*>([^<]*)</.exec(html);
      const title = /<title>([^<]*)<\/title>/.exec(html);
      return {
        id: id ? { x: Number(id[1]), text: id[2]! } : undefined,
        badge: badge ? { right: Number(badge[1]), text: badge[2]! } : undefined,
        title: title?.[1],
      };
    };

    it.each([196, 160, 103, 88])('%ipx 宽的框：节点名和徽标都在、互不重叠', (width) => {
      for (const id of ids) {
        for (const mark of marks) {
          const h = heading(renderBox(node({ id, ...mark }), width));
          const where = `${width}px ${id} ${JSON.stringify(mark)}`;
          expect(h.id?.text, where).toBeTruthy();
          expect(id.startsWith(h.id!.text.replace(/…$/, '')), where).toBe(true);
          expect(h.badge?.text, where).toBeTruthy();
          const idEnd = h.id!.x + idPx(h.id!.text);
          const badgeStart = h.badge!.right - badgePx(h.badge!.text);
          expect(idEnd, where).toBeLessThanOrEqual(badgeStart);
          expect(h.badge!.right, where).toBeLessThanOrEqual(width);
        }
      }
    });

    it('标准宽度显示完整徽标；放不下时缩成短标记，完整文字留在节点提示里', () => {
      for (const mark of marks) {
        const n = node({ id: ids[0]!, ...mark });
        expect(heading(renderBox(n, 196)).badge?.text).toBe(nodeRevisionBadge(n));
        const narrow = heading(renderBox(n, 88));
        expect(narrow.badge?.text === nodeRevisionBadge(n) || narrow.title === nodeRevisionBadge(n)).toBe(true);
      }
    });
  });

  it('节点详情列出主 Bot 的每次自动处理和每次交给人，附理由；没有时不显示', () => {
    const html = renderToStaticMarkup(React.createElement(NodeInterventions, {
      node: node({
        status: 'blocked',
        interventions: [
          { kind: 'retry', by: 'mainBot', reason: '上游接口偶发超时', at: 0 },
          { kind: 'handedToHuman', by: 'initiator', reason: '需要发起人给生产权限', at: MIN },
        ],
      }),
    }));
    expect(html).toContain('主 Bot 自动重试');
    expect(html).toContain('上游接口偶发超时');
    expect(html).toContain('交给人决定');
    expect(html).toContain('（发起人）');
    expect(html).toContain('需要发起人给生产权限');
    expect(renderToStaticMarkup(React.createElement(NodeInterventions, { node: node() }))).toBe('');
  });

  it('节点详情列出每次尝试的结果；只有一次成功尝试时不列清单', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(NodeExecution, {
        node: node({
          status: 'running', startedAt: 10 * MIN,
          bot: { larkAppId: 'cli_a', name: '调研Bot' },
          attempts: [
            { attemptId: 'r/1', startedAt: 0, endedAt: 2 * MIN, outcome: 'blocked', errorCode: 'NODE_TIMEOUT' },
            { attemptId: 'r/2', startedAt: 10 * MIN },
          ],
        }),
        generatedAt: 14 * MIN,
      }));
    });
    const items = renderer.root.findAllByType('li').map((li) => li.findAll((x) => typeof x.type === 'string' && x.type === 'span').map((sp) => sp.children.join('')));
    expect(items.map((spans) => [spans[0], spans[2], spans[3]])).toEqual([
      ['第 1 次', '2分', '受阻 (NODE_TIMEOUT)'],
      ['第 2 次', '4分', '进行中'],
    ]);

    act(() => {
      renderer.update(React.createElement(NodeExecution, {
        node: node({ status: 'done', startedAt: 0, endedAt: MIN, attempts: [{ attemptId: 'r/1', startedAt: 0, endedAt: MIN, outcome: 'succeeded' }] }),
        generatedAt: 5 * MIN,
      }));
    });
    expect(renderer.root.findAllByType('li')).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });
});
