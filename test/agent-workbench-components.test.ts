import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { AgentWorkbenchView } from '../src/dashboard/web/agent-workbench-view.js';
import { AgentWorkbenchDockView } from '../src/dashboard/web/agent-workbench-dock-view.js';
import { WebPane } from '../src/dashboard/web/agent-workbench-panes.js';
import type { WorkbenchApi } from '../src/dashboard/web/agent-workbench-api.js';
import type { WorkbenchSessionRow } from '../src/dashboard/web/agent-workbench-model.js';

const api: WorkbenchApi = {
  getTerminalControl: async () => ({ mode: 'readonly', owned: false }),
  takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: Date.now() + 60_000 }),
  releaseTerminal: async () => ({ mode: 'readonly', owned: false }),
  getPreviewInteraction: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a security boundary' }),
  unlockPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a security boundary', idleExpiresAt: Date.now() + 60_000 }),
  touchPreview: async () => ({ mode: 'interactive', label: 'INTERACTIVE', securityNotice: 'not a security boundary', idleExpiresAt: Date.now() + 60_000 }),
  lockPreview: async () => ({ mode: 'preview', label: 'PREVIEW', securityNotice: 'not a security boundary' }),
  getH5Context: async () => null,
};

function sessions(count = 320): WorkbenchSessionRow[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `session-${index}`,
    status: index !== 0 && index % 17 === 0 ? 'closed' : 'working',
    title: `Full title for session ${index} that remains available through title and aria-label`,
    botName: 'Builder',
    cliId: 'codex',
    chatId: `oc_${index}`,
    lastMessageAt: 1_800_000_000_000 + index,
    ...(index === 0 ? { agentAttention: { reason: 'Approve deployment', at: 1_900_000_000_000 } } : {}),
  }));
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}

describe('Agent Workbench components', () => {
  it('renders a windowed accessible session list and keeps Info outside panes', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: sessions(),
        online: true,
        authenticated: true,
        initialSessionId: 'session-0',
        viewportWidth: 1440,
        now: 1_900_000_001_000,
        api,
        storage: null,
        location: null,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    const options = renderer.root.findAll(node => node.props.role === 'option');
    expect(options.length).toBeGreaterThan(1);
    expect(options.length).toBeLessThan(30);
    expect(options[0].props['aria-label']).toContain('Approve deployment');
    expect(options[0].findByProps({ className: 'wb-session-title' }).props.title).toContain('Full title');
    expect(renderer.root.findByProps({ 'aria-label': 'Terminal pane' })).toBeTruthy();
    const info = renderer.root.findAllByType('button').find(button => textOf(button).includes('Info drawer'))!;
    await act(async () => { info.props.onClick(); });
    expect(renderer.root.findByProps({ className: 'wb-info-drawer' })).toBeTruthy();
    expect(renderer.root.findAll(node => node.props.className === 'wb-pane').some(node => textOf(node).includes('SESSION INFO'))).toBe(false);
    act(() => renderer.unmount());
  });

  it('renders a standalone >=350px Dock with appCenter action and no pane tree', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchDockView, {
        sessions: sessions(3),
        online: true,
        authenticated: true,
        initialSessionId: 'session-0',
        api,
        sdk: null,
        h5Context: { enabled: true, appId: 'cli_x', brand: 'feishu', entryPath: '/auth/feishu' },
        targetOrigin: 'https://dash.example',
        location: null,
        onRouteChange: () => {},
      }));
    });
    const root = renderer.root.findByProps({ className: 'agent-workbench-dock' });
    expect(root.props.style.minWidth).toBe(350);
    expect(renderer.root.findByProps({ className: 'wb-primary-action' }).props.href).toContain('mode=appCenter');
    expect(renderer.root.findAll(node => node.props.className === 'wb-pane')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('renders the full Sessions list in the fixed mobile page stack', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: sessions(12),
        online: true,
        authenticated: true,
        initialSessionId: 'session-0',
        viewportWidth: 390,
        api,
        storage: null,
        location: null,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    expect(renderer.root.findByProps({ 'data-responsive-step': 'mobile-stack' })).toBeTruthy();
    expect(textOf(renderer.root)).toContain('CHAT · NATIVE JUMP');
    const sessionsButton = renderer.root.findAllByType('button').find(button => button.children.includes('Sessions'))!;
    await act(async () => { sessionsButton.props.onClick(); });
    expect(renderer.root.findByProps({ className: 'wb-session-list' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ className: 'wb-rail-expand' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('keeps an explicit session selection when the initial route prop is unchanged', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(AgentWorkbenchView, {
        sessions: sessions(3),
        online: true,
        authenticated: true,
        initialSessionId: 'session-0',
        viewportWidth: 1440,
        api,
        storage: null,
        location: null,
        sdk: null,
        h5Context: null,
        onRouteChange: () => {},
      }));
    });
    const second = renderer.root.findAll(node => node.props.role === 'option')
      .find(option => String(option.props['aria-label']).includes('session 1'))!;
    await act(async () => { second.props.onClick(); });
    expect(renderer.root.findAll(node => String(node.props['aria-label']).includes('Workbench for Full title for session 1'))).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('binds a preview descriptor to the selected session and shows the weak-overlay boundary', async () => {
    const selected = sessions(1)[0];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WebPane, {
        session: { ...selected, preview: { path: '/preview/another-session/', registeredAt: new Date().toISOString() } },
        authenticated: true,
        api,
        now: Date.now(),
      }));
    });
    expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
    expect(textOf(renderer.root)).toContain('No Web preview registered');
    act(() => renderer.unmount());

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WebPane, {
        session: { ...selected, preview: { path: '/preview/session-0/', registeredAt: new Date().toISOString() } },
        authenticated: true,
        api,
        now: Date.now(),
      }));
    });
    expect(renderer.root.findByType('iframe').props.src).toBe('/preview/session-0/');
    expect(textOf(renderer.root)).toContain('not a security boundary');
    act(() => renderer.unmount());
  });
});
