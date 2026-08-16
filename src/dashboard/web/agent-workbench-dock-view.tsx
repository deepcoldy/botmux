import { useEffect, useMemo, useState } from 'react';
import {
  buildWorkbenchHash,
  groupWorkbenchSessions,
  workbenchPreviewHref,
  workbenchSessionTitle,
  workbenchTerminalHref,
  type WorkbenchSessionRow,
  type WorkbenchTerminalLocation,
} from './agent-workbench-model.js';
import {
  buildChatAppLink,
  buildWorkbenchLoginUrl,
  buildWorkbenchWebAppLink,
  type FeishuJsApi,
  type WorkbenchH5Context,
} from './agent-workbench-chat.js';
import { createWorkbenchApi, type WorkbenchApi } from './agent-workbench-api.js';
import { WorkbenchSessionList } from './agent-workbench-session-list.js';

export interface AgentWorkbenchDockViewProps {
  sessions: readonly WorkbenchSessionRow[];
  online: boolean;
  authenticated: boolean;
  initialSessionId?: string | null;
  locale?: string;
  now?: number;
  api?: WorkbenchApi;
  h5Context?: WorkbenchH5Context | null;
  sdk?: FeishuJsApi | null;
  targetOrigin?: string;
  location?: WorkbenchTerminalLocation | null;
  onRouteChange?(hash: string): void;
}

function firstSessionId(sessions: readonly WorkbenchSessionRow[]): string | null {
  const groups = groupWorkbenchSessions(sessions);
  return groups['needs-you'][0]?.sessionId ?? groups.active[0]?.sessionId ?? groups.recent[0]?.sessionId ?? null;
}

export function AgentWorkbenchDockView(props: AgentWorkbenchDockViewProps): JSX.Element {
  const api = useMemo(() => props.api ?? createWorkbenchApi(), [props.api]);
  const [selectedId, setSelectedId] = useState(props.initialSessionId ?? firstSessionId(props.sessions));
  const [h5, setH5] = useState<WorkbenchH5Context | null>(props.h5Context ?? null);
  const selected = props.sessions.find(session => session.sessionId === selectedId) ?? null;
  const targetOrigin = props.targetOrigin ?? (typeof window === 'undefined' ? 'https://dashboard.invalid' : window.location.origin);
  const location = props.location ?? (typeof window === 'undefined' ? null : window.location);

  useEffect(() => {
    if (props.h5Context !== undefined) return undefined;
    const controller = new AbortController();
    void api.getH5Context(controller.signal).then(setH5);
    return () => controller.abort();
  }, [api, props.h5Context]);

  const select = (sessionId: string) => {
    setSelectedId(sessionId);
    const hash = buildWorkbenchHash('dock', sessionId);
    if (props.onRouteChange) props.onRouteChange(hash);
    else if (typeof window !== 'undefined') window.history.replaceState(window.history.state, '', hash);
  };

  const appCenterLink = selected && h5?.enabled
    ? buildWorkbenchWebAppLink({
        appId: h5.appId,
        brand: h5.brand,
        surface: 'main',
        targetOrigin,
        sessionId: selected.sessionId,
      })
    : null;
  const terminalLink = selected ? workbenchTerminalHref(selected, location) : null;
  const previewLink = selected ? workbenchPreviewHref(selected) : null;

  return (
    <main className="agent-workbench-dock" data-surface="sidebar" style={{ minWidth: 350 }}>
      <header className="wb-dock-header">
        <div><span aria-hidden="true">◖</span><strong>会话坞</strong></div>
        <span className={props.online ? 'is-online' : 'is-offline'}>{props.online ? '● 在线' : '○ 离线'}</span>
      </header>
      <WorkbenchSessionList
        sessions={props.sessions}
        selectedSessionId={selectedId}
        locale={props.locale}
        now={props.now}
        online={props.online}
        onSelect={select}
      />
      <section className="wb-dock-actions" aria-live="polite">
        {selected ? (
          <>
            <div className="wb-dock-selected">
              <strong title={workbenchSessionTitle(selected)}>{workbenchSessionTitle(selected)}</strong>
              <span>{selected.botName || selected.larkAppId || 'Bot'} · {selected.status}</span>
            </div>
            {!props.authenticated ? (
              <a className="wb-primary-action" href={buildWorkbenchLoginUrl(h5?.entryPath ?? '/auth/feishu', 'dock', selected.sessionId)}>
                登录后继续
              </a>
            ) : appCenterLink ? (
              <a className="wb-primary-action" href={appCenterLink}>打开完整工作台</a>
            ) : (
              <a className="wb-primary-action" href={buildWorkbenchHash('main', selected.sessionId)} target="_top">
                打开完整工作台
              </a>
            )}
            <div className="wb-dock-action-grid">
              {/* Same contract as the Dashboard's own chat control: a real link
                  the client can claim. Scripting this open (window.open, or
                  location.assign as a "fallback") navigates the Dock away
                  instead of letting Feishu place the chat beside it. */}
              {selected.chatId
                ? (
                  <a
                    href={selected.feishuChatLink || buildChatAppLink(selected.chatId, h5?.brand)}
                    target="_blank"
                    rel="noopener"
                  >打开聊天</a>
                )
                : <span aria-disabled="true">无聊天</span>}
              {terminalLink ? <a href={terminalLink} target="_blank" rel="noopener noreferrer">终端链接</a> : <span aria-disabled="true">无终端</span>}
              {previewLink ? <a href={previewLink} target="_blank" rel="noopener noreferrer">网页链接</a> : <span aria-disabled="true">无网页预览</span>}
            </div>
          </>
        ) : <p>请选择一个会话。</p>}
      </section>
      <footer>轻量会话坞 · 终端/网页请在完整工作台查看 · 聊天使用飞书原生窗口</footer>
    </main>
  );
}
