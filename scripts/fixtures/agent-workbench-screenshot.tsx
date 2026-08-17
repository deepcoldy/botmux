import { createRoot } from 'react-dom/client';
import { AgentWorkbenchView } from '../../src/dashboard/web/agent-workbench-view.js';
import { workbenchLayoutStorageKey } from '../../src/dashboard/web/agent-workbench-storage.js';
import type { WorkbenchApi } from '../../src/dashboard/web/agent-workbench-api.js';
import type { WorkbenchSessionRow } from '../../src/dashboard/web/agent-workbench-model.js';

const NOW = Date.UTC(2026, 7, 11, 20, 42, 0);
const SESSION_ID = 'orca-release-review';
const serverPort = Number(window.location.port);

const sessions: WorkbenchSessionRow[] = Array.from({ length: 320 }, (_, index) => {
  const sessionId = index === 0 ? SESSION_ID : 'agent-session-' + String(index + 1).padStart(3, '0');
  const base: WorkbenchSessionRow = {
    sessionId,
    status: index < 198 ? (index % 5 === 0 ? 'analyzing' : 'working') : (index < 276 ? 'dormant' : 'closed'),
    title: index === 0
      ? 'Ship Agent Workbench — contract and accessibility review'
      : (index % 4 === 0 ? 'Review preview interaction lease and safe relock' : 'Agent task ' + String(index + 1) + ' — implementation stream'),
    botName: index % 3 === 0 ? 'Orca Builder' : (index % 3 === 1 ? 'Contract Reviewer' : 'Release Scout'),
    cliId: index % 4 === 0 ? 'codex' : (index % 4 === 1 ? 'claude' : (index % 4 === 2 ? 'gemini' : 'cursor')),
    repoName: index % 2 === 0 ? 'botmux' : 'platform-shell',
    workingDir: index % 2 === 0 ? '/workspace/botmux' : '/workspace/platform-shell',
    gitBranch: index === 0 ? 'feat/agent-workbench' : 'agent/session-' + String(index + 1),
    chatId: 'oc_agent_workbench_' + String(index + 1),
    chatType: 'group',
    chatDisplayName: index === 0 ? 'Agent Workbench launch room' : 'Agent coordination ' + String(index + 1),
    scope: 'thread',
    lastMessageAt: NOW - index * 83_000,
  };
  if (index < 7) {
    base.agentAttention = {
      reason: index === 0 ? 'Approve preview relock behavior' : (index % 2 ? 'Choose a repository' : 'Respond to agent question'),
      at: NOW - index * 37_000,
    };
  } else if (index === 7) {
    base.pendingRepo = true;
  } else if (index === 8) {
    base.tuiPromptActive = true;
  }
  if (index === 0) {
    base.webPort = serverPort;
    base.proxyPort = serverPort;
    base.preview = { path: '/preview/' + SESSION_ID + '/', registeredAt: new Date(NOW - 4_000).toISOString() };
  }
  return base;
});

// 工作台如今只读这两项布局偏好（分屏/信息抽屉/页内聊天已移除），种子里就不再
// 塞 paneMode/splitAxis/chatRequested 那些不再驱动任何东西的键。
window.localStorage.setItem(workbenchLayoutStorageKey(SESSION_ID), JSON.stringify({
  version: 1,
  railWidth: 246,
  railCollapsed: false,
}));

const api: WorkbenchApi = {
  async getTerminalControl() { return { mode: 'controlled', owned: true, expiresAt: NOW + 11 * 60_000 }; },
  async takeoverTerminal() { return { mode: 'controlled', owned: true, expiresAt: NOW + 15 * 60_000 }; },
  async releaseTerminal() { return { mode: 'readonly', owned: false }; },
  async getPreviewInteraction() {
    return {
      mode: 'interactive',
      label: 'INTERACTIVE',
      securityNotice: 'The interaction overlay prevents accidental input; it is not an application security boundary.',
      idleExpiresAt: NOW + 12 * 60_000,
    };
  },
  async unlockPreview() {
    return {
      mode: 'interactive',
      label: 'INTERACTIVE',
      securityNotice: 'The interaction overlay prevents accidental input; it is not an application security boundary.',
      idleExpiresAt: NOW + 15 * 60_000,
    };
  },
  async touchPreview() {
    return {
      mode: 'interactive',
      label: 'INTERACTIVE',
      securityNotice: 'The interaction overlay prevents accidental input; it is not an application security boundary.',
      idleExpiresAt: NOW + 15 * 60_000,
    };
  },
  async lockPreview() {
    return {
      mode: 'preview',
      label: 'PREVIEW',
      securityNotice: 'The interaction overlay prevents accidental input; it is not an application security boundary.',
    };
  },
  async getH5Context() {
    return { enabled: true, appId: 'cli_demo_app', brand: 'feishu', entryPath: '/auth/feishu' };
  },
  async getTerminalViewLink() { return null; },
  async locateSession() {},
};

document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(
  <AgentWorkbenchView
    sessions={sessions}
    online
    authenticated
    capabilities={{ canLocate: true, canControl: true, canInteract: true }}
    initialSessionId={SESSION_ID}
    now={NOW}
    viewportWidth={1440}
    api={api}
    storage={window.localStorage}
    location={window.location}
    h5Context={{ enabled: true, appId: 'cli_demo_app', brand: 'feishu', entryPath: '/auth/feishu' }}
    sdk={null}
    demo
  />,
);
