import { useEffect, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useDashboardStore } from './react-hooks.js';
import { ui } from './ui.js';
import { parseWorkbenchHash, type WorkbenchSessionRow } from './agent-workbench-model.js';
import { AgentWorkbenchView } from './agent-workbench-view.js';

function AgentWorkbenchRoutePage(): JSX.Element {
  const snapshot = useDashboardStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const route = parseWorkbenchHash(window.location.hash);
  return (
    <AgentWorkbenchView
      sessions={[...snapshot.sessions.values()] as WorkbenchSessionRow[]}
      online={snapshot.online}
      authenticated={ui.workbenchAuthed}
      // P1-4：操作入口（定位/接管/交互）各看服务端投影的对应布尔，不再由
      // workbenchAuthed 一个布尔包办。
      capabilities={ui.workbenchCapabilities}
      initialSessionId={route?.surface === 'main' ? route.sessionId : null}
      locale="zh-CN"
      now={now}
    />
  );
}

export function renderAgentWorkbenchPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <AgentWorkbenchRoutePage />);
}
