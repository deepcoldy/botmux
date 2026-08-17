import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { AgentWorkbenchView } from '../src/dashboard/web/agent-workbench-view.js';
import { AgentWorkbenchDockView } from '../src/dashboard/web/agent-workbench-dock-view.js';
import type { WorkbenchApi } from '../src/dashboard/web/agent-workbench-api.js';
import type { WorkbenchSessionRow } from '../src/dashboard/web/agent-workbench-model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const sessions: WorkbenchSessionRow[] = Array.from({ length: 320 }, (_, index) => ({
  sessionId: `session-${index}`,
  status: index !== 0 && index % 17 === 0 ? 'closed' : 'working',
  title: `Full title for session ${index}`,
  botName: 'Builder',
  cliId: 'codex',
  chatId: `oc_${index}`,
  lastMessageAt: 1_800_000_000_000 + index,
  ...(index === 0 ? { agentAttention: { reason: 'Approve deployment', at: 1_900_000_000_000 } } : {}),
}));

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
}

let main!: TestRenderer.ReactTestRenderer;
await act(async () => {
  main = TestRenderer.create(React.createElement(AgentWorkbenchView, {
    sessions,
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
const options = main.root.findAll(node => node.props.role === 'option');
assert.ok(options.length > 1 && options.length < 30);
assert.match(options[0].props['aria-label'], /Approve deployment/);
assert.ok(main.root.findByProps({ 'aria-label': 'Terminal pane' }));
const infoButton = main.root.findAllByType('button').find(button => textOf(button).includes('Info drawer'))!;
await act(async () => { infoButton.props.onClick(); });
assert.ok(main.root.findByProps({ className: 'wb-info-drawer' }));
assert.equal(main.root.findAll(node => node.props.className === 'wb-pane').some(node => textOf(node).includes('SESSION INFO')), false);
act(() => main.unmount());

let dock!: TestRenderer.ReactTestRenderer;
await act(async () => {
  dock = TestRenderer.create(React.createElement(AgentWorkbenchDockView, {
    sessions: sessions.slice(0, 3),
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
assert.equal(dock.root.findByProps({ className: 'agent-workbench-dock' }).props.style.minWidth, 350);
assert.match(dock.root.findByProps({ className: 'wb-primary-action' }).props.href, /mode=appCenter/);
assert.equal(dock.root.findAll(node => node.props.className === 'wb-pane').length, 0);
act(() => dock.unmount());

process.stdout.write(JSON.stringify({ ok: true, componentChecks: 9, renderedSessionOptions: options.length }) + '\n');
