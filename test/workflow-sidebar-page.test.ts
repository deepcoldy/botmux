/**
 * 飞书侧边栏里的工作流页面（设计 2026-11-03 §11.4）：竖排布局在 350–800px 内能放下、边从上
 * 一层指向下一层；侧栏 hash 只在带沉浸式标记和 app 时成立（Dashboard 里点进来的详情页不受
 * 影响）；页面按服务端给的受众渲染，成员视图没有终端入口；401 给出登录入口。
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { buildVerticalGraphLayout, V3_VERTICAL_GRAPH } from '../src/dashboard/web/v3-model.js';
import { parseWorkflowSidebarHash } from '../src/core/workflow-sidebar-link.js';
import {
  WorkflowSidebarPage,
  fetchWorkflowSidebar,
  sidebarModel,
  type WorkflowSidebarFetch,
} from '../src/dashboard/web/workflow-sidebar-page.js';
import type { RunNodeView, RunView } from '../src/workflows/v3/ops-projection.js';
import type { WorkflowSidebarAdminPayload, WorkflowSidebarMemberPayload } from '../src/dashboard/workflow-sidebar-view.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const node = (id: string, depends: string[] = [], over: Partial<RunNodeView> = {}): RunNodeView => ({
  id, status: 'pending', depends, hasPtyLog: false, hasManifest: false, attempts: [], ...over,
});
const view = (nodes: RunNodeView[]): RunView => ({ runId: 'run-1', runStatus: 'running', nodes, generatedAt: 0 });

describe('vertical layout for the sidebar', () => {
  // a → (b, c, d) → e : the widest row has three nodes.
  const diamond = view([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['a']), node('e', ['b', 'c', 'd'])]);

  it.each([350, 480, 800])('fits a %ipx sidebar: rows top to bottom by depth, no box outside the width', (width) => {
    const layout = buildVerticalGraphLayout(diamond, width);
    expect(layout.width).toBe(width);
    const y = (id: string) => layout.nodes.find((box) => box.node.id === id)!.y;
    expect(y('a')).toBeLessThan(y('b'));
    expect(y('b')).toBe(y('c'));
    expect(y('c')).toBeLessThan(y('e'));
    for (const box of layout.nodes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
    }
    for (const edge of layout.edges) {
      const from = layout.nodes.find((box) => box.node.id === edge.fromId)!;
      const to = layout.nodes.find((box) => box.node.id === edge.toId)!;
      expect(edge.y1).toBe(from.y + from.height);
      expect(edge.y2).toBe(to.y);
      expect(edge.y2).toBeGreaterThan(edge.y1);
    }
  });

  it('a row too wide even at the minimum box width scrolls sideways instead of shrinking further', () => {
    const wide = view(Array.from({ length: 5 }, (_, i) => node(`n${i}`)));
    const layout = buildVerticalGraphLayout(wide, 350);
    expect(layout.width).toBeGreaterThan(350);
    for (const box of layout.nodes) expect(box.width).toBe(V3_VERTICAL_GRAPH.minNodeWidth);
  });
});

describe('sidebar hash', () => {
  it('needs the immersive marker (hash or promoted to search) and a valid app', () => {
    expect(parseWorkflowSidebarHash('', '#/workflows/run-1?app=cli_a&botmuxWorkbenchShell=immersive'))
      .toEqual({ appId: 'cli_a', runId: 'run-1' });
    expect(parseWorkflowSidebarHash('?botmuxWorkbenchShell=immersive', '#/workflows/run-1?app=cli_a'))
      .toEqual({ appId: 'cli_a', runId: 'run-1' });
    expect(parseWorkflowSidebarHash('', '#/workflows/run-1')).toBeNull();
    expect(parseWorkflowSidebarHash('', '#/workflows/run-1?app=cli_a')).toBeNull();
    expect(parseWorkflowSidebarHash('', '#/workflows/run-1?botmuxWorkbenchShell=immersive')).toBeNull();
    expect(parseWorkflowSidebarHash('', '#/workflows/..?app=cli_a&botmuxWorkbenchShell=immersive')).toBeNull();
  });
});

const RUN = { runId: 'run-1', title: 'Risk report', mainBot: { larkAppId: 'cli_main', name: 'Main' } };

function memberPayload(): WorkflowSidebarMemberPayload {
  return {
    ok: true, audience: 'member', run: RUN,
    view: {
      runId: 'run-1', runStatus: 'running', generatedAt: 10_000,
      nodes: [{ id: 'write', status: 'running', depends: [], goal: 'write it', startedAt: 1_000, attempts: [{ startedAt: 1_000 }],
        landing: { placement: 'topic', url: 'https://applink.example.test/thread', handoffAt: 1_000 } }],
    },
  };
}

function adminPayload(): WorkflowSidebarAdminPayload {
  return {
    ok: true, audience: 'admin', run: RUN,
    view: view([node('write', [], { status: 'blocked', errorClass: 'workerError', errorCode: 'NODE_TIMEOUT', hasPtyLog: true })]),
    landings: {},
  };
}

const fetchOf = (status: number, body: unknown, headers: Record<string, string> = {}): WorkflowSidebarFetch =>
  async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function render(fetcher: WorkflowSidebarFetch): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(WorkflowSidebarPage, { target: { appId: 'cli_main', runId: 'run-1' }, fetcher }),
      { createNodeMock: () => ({ clientWidth: 360, innerHTML: '', setAttribute: () => {} }) },
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return renderer;
}

describe('sidebar page', () => {
  it('a member sees the graph and, on tap, the node\'s goal and landing — no terminal', async () => {
    const r = await render(fetchOf(200, memberPayload()));
    expect(r.root.findByProps({ 'data-audience': 'member' })).toBeTruthy();
    const nodeEl = r.root.find((el) => el.props['data-node'] === 'write');
    await act(async () => { nodeEl.props.onClick(); });
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('write it');
    expect(text).toContain('https://applink.example.test/thread');
    expect(r.root.findAll((el) => el.props.className === 'v3r-term-slot')).toHaveLength(0);
    act(() => r.unmount());
  });

  it('an admin also gets the error line and the terminal slot', async () => {
    const r = await render(fetchOf(200, adminPayload()));
    const nodeEl = r.root.find((el) => el.props['data-node'] === 'write');
    await act(async () => { nodeEl.props.onClick(); });
    expect(r.root.findAll((el) => el.props.className === 'v3r-term-slot')).toHaveLength(1);
    expect(JSON.stringify(r.toJSON())).toContain('NODE_TIMEOUT');
    act(() => r.unmount());
  });

  it('401 offers the login link the server named; 403 explains who may see it', async () => {
    const login = await render(fetchOf(401, { ok: false }, { 'x-botmux-login-url': '/auth/feishu?returnTo=%2Fworkflow%2Fcli_main%2Frun-1' }));
    expect(login.root.find((el) => el.type === 'a').props.href).toBe('/auth/feishu?returnTo=%2Fworkflow%2Fcli_main%2Frun-1');
    act(() => login.unmount());
    const forbidden = await render(fetchOf(403, { ok: false }));
    expect(forbidden.root.findAll((el) => el.type === 'a')).toHaveLength(0);
    act(() => forbidden.unmount());
  });

  it('an edge into a node a pending change would add is drawn as pending, the others as usual', async () => {
    const payload: WorkflowSidebarAdminPayload = {
      ...adminPayload(),
      view: view([node('a', [], { status: 'done' }), node('b', ['a'], { pendingChange: 'add' }), node('c', ['a'])]),
    };
    const r = await render(fetchOf(200, payload));
    const layout = buildVerticalGraphLayout(payload.view, 360);
    const drawn = r.root.findAll((el) => el.type === 'path' && typeof el.props.className === 'string' && el.props.className.split(' ').includes('v3r-edge'));
    // Drawn in layout order (the page measures the same 360px container).
    expect(drawn.map((el) => el.props.className.split(' ').includes('pending')))
      .toEqual(layout.edges.map((edge) => edge.pending));
    expect(layout.edges.some((edge) => edge.pending)).toBe(true);
    expect(layout.edges.some((edge) => !edge.pending)).toBe(true);
    act(() => r.unmount());
  });

  it('fetches the sidebar data route for the target and maps member nodes for the graph', async () => {
    const seen: string[] = [];
    const result = await fetchWorkflowSidebar({ appId: 'cli_main', runId: 'run-1' }, async (input) => {
      seen.push(input);
      return new Response(JSON.stringify(memberPayload()), { status: 200 });
    });
    expect(seen).toEqual(['/api/workflow-sidebar/cli_main/run-1']);
    if (!result.ok) throw new Error('expected ok');
    const model = sidebarModel(result.payload);
    expect(model.view.nodes[0]).toMatchObject({ id: 'write', hasPtyLog: false, hasManifest: false });
    expect(model.landings.get('write')?.url).toBe('https://applink.example.test/thread');
  });
});
