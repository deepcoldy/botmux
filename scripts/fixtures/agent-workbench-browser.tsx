import { createRoot } from 'react-dom/client';
import { AgentWorkbenchDockView } from '../../src/dashboard/web/agent-workbench-dock-view.js';
import { AgentWorkbenchView } from '../../src/dashboard/web/agent-workbench-view.js';
import { workbenchLayoutStorageKey } from '../../src/dashboard/web/agent-workbench-storage.js';
import type { FeishuJsApi } from '../../src/dashboard/web/agent-workbench-chat.js';
import type { WorkbenchSessionRow } from '../../src/dashboard/web/agent-workbench-model.js';

declare global {
  interface Window {
    __workbenchHarness?: {
      sdkCalls: string[];
      scenario: string;
      sessionId: string;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get('scenario') || 'success';
const surface = params.get('surface') === 'dock' ? 'dock' : 'main';
const sdkMode = params.get('sdk') || 'none';
const sessionId = scenario === 'failure' ? 'browser-failure' : 'browser-success';
const sdkCalls: string[] = [];
window.__workbenchHarness = { sdkCalls, scenario, sessionId };

let sdk: FeishuJsApi | null = null;
if (sdkMode === 'toggle-success') {
  sdk = {
    toggleChat(options) { sdkCalls.push('toggleChat'); options.success?.(); },
    enterChat(options) { sdkCalls.push('enterChat'); options.success?.(); },
  };
} else if (sdkMode === 'enter-fallback') {
  sdk = {
    toggleChat(options) { sdkCalls.push('toggleChat'); options.fail?.({ errno: 1 }); },
    enterChat(options) { sdkCalls.push('enterChat'); options.success?.(); },
  };
} else if (sdkMode === 'timeout') {
  sdk = {
    toggleChat() { sdkCalls.push('toggleChat'); },
    enterChat(options) { sdkCalls.push('enterChat'); options.success?.(); },
  };
}

const port = Number(window.location.port);
const sessions: WorkbenchSessionRow[] = [
  {
    sessionId,
    status: 'working',
    title: scenario === 'failure' ? 'Workbench failure boundary' : 'Integrated Workbench browser scenario',
    botName: 'Local Harness',
    cliId: 'codex',
    repoName: 'botmux',
    chatId: 'oc_browser_harness',
    chatDisplayName: 'Browser harness chat',
    lastMessageAt: Date.now(),
    webPort: port,
    proxyPort: port,
    preview: {
      path: `/preview/${encodeURIComponent(sessionId)}/`,
      registeredAt: new Date().toISOString(),
    },
  },
  {
    sessionId: 'browser-secondary',
    status: 'idle',
    title: 'Secondary session for route switching',
    botName: 'Local Harness',
    cliId: 'claude',
    lastMessageAt: Date.now() - 60_000,
  },
];

window.localStorage.setItem(workbenchLayoutStorageKey(sessionId), JSON.stringify({
  version: 1,
  railWidth: 220,
  railCollapsed: false,
  focus: 'terminal',
  paneMode: 'split',
  splitAxis: 'horizontal',
  splitRatio: 0.5,
  chatRequested: false,
}));

const authenticated = params.get('authenticated') !== 'false';
const common = {
  sessions,
  online: scenario !== 'failure',
  authenticated,
  initialSessionId: sessionId,
  sdk,
  onRouteChange: () => {},
};

const root = createRoot(document.getElementById('root')!);
if (surface === 'dock') {
  root.render(
    <AgentWorkbenchDockView
      {...common}
      targetOrigin={window.location.origin}
      location={window.location}
    />,
  );
} else {
  root.render(
    <AgentWorkbenchView
      {...common}
      // 浏览器夹具模拟 legacy owner：登录态即三能力齐全（P1-4 投影值）；
      // 未登录场景与真实匿名一致，全 false。
      capabilities={{ canLocate: authenticated, canControl: authenticated, canInteract: authenticated }}
      storage={window.localStorage}
      location={window.location}
    />,
  );
}
