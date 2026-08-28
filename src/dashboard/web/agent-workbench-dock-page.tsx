import type React from 'react';
import { useEffect, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useDashboardStore } from './react-hooks.js';
import { ui } from './ui.js';
import { parseWorkbenchHash, type WorkbenchSessionRow } from './agent-workbench-model.js';
import { AgentWorkbenchDockView } from './agent-workbench-dock-view.js';

function AgentWorkbenchDockRoutePage(): React.JSX.Element {
  const snapshot = useDashboardStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const route = parseWorkbenchHash(window.location.hash);
  return (
    <AgentWorkbenchDockView
      sessions={[...snapshot.sessions.values()] as WorkbenchSessionRow[]}
      online={snapshot.online}
      authenticated={ui.workbenchAuthed}
      // 同完整工作台：常驻链接只对本机完整管理身份可见。
      manageAuthed={ui.authed}
      initialSessionId={route?.surface === 'dock' ? route.sessionId : null}
      locale="zh-CN"
      now={now}
    />
  );
}

export function renderAgentWorkbenchDockPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <AgentWorkbenchDockRoutePage />);
}
