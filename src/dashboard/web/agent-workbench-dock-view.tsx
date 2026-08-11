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
  ensureFeishuJsApi,
  openWorkbenchChat,
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
  const [sdk, setSdk] = useState<FeishuJsApi | null>(props.sdk ?? null);
  const [feedback, setFeedback] = useState('Dock is ready.');
  const selected = props.sessions.find(session => session.sessionId === selectedId) ?? null;
  const targetOrigin = props.targetOrigin ?? (typeof window === 'undefined' ? 'https://dashboard.invalid' : window.location.origin);
  const location = props.location ?? (typeof window === 'undefined' ? null : window.location);

  useEffect(() => {
    if (props.h5Context !== undefined) return undefined;
    const controller = new AbortController();
    void api.getH5Context(controller.signal).then(setH5);
    return () => controller.abort();
  }, [api, props.h5Context]);

  useEffect(() => {
    if (props.sdk !== undefined) return undefined;
    let live = true;
    void ensureFeishuJsApi().then(value => { if (live) setSdk(value); });
    return () => { live = false; };
  }, [props.sdk]);

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

  const openChat = async () => {
    if (!selected?.chatId) return;
    const result = await openWorkbenchChat({
      chatId: selected.chatId,
      appLink: selected.feishuChatLink || buildChatAppLink(selected.chatId, h5?.brand),
      preferSplit: false,
      sdk,
      openExternal: url => { if (typeof window !== 'undefined') window.location.assign(url); },
    });
    setFeedback(result.kind === 'native-jump' ? 'Chat opened in Feishu.' : 'Chat opened with AppLink fallback.');
  };

  return (
    <main className="agent-workbench-dock" data-surface="sidebar" style={{ minWidth: 350 }}>
      <header className="wb-dock-header">
        <div><span aria-hidden="true">◖</span><strong>ORCA DOCK</strong></div>
        <span className={props.online ? 'is-online' : 'is-offline'}>{props.online ? '● LIVE' : '○ OFFLINE'}</span>
      </header>
      <WorkbenchSessionList
        sessions={props.sessions}
        selectedSessionId={selectedId}
        locale={props.locale}
        now={props.now}
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
                Sign in to continue
              </a>
            ) : appCenterLink ? (
              <a className="wb-primary-action" href={appCenterLink}>Open full Workbench in appCenter</a>
            ) : (
              <a className="wb-primary-action" href={buildWorkbenchHash('main', selected.sessionId)} target="_top">
                Open full Workbench
              </a>
            )}
            <div className="wb-dock-action-grid">
              <button type="button" disabled={!selected.chatId} onClick={() => void openChat()}>Open chat</button>
              {terminalLink ? <a href={terminalLink} target="_blank" rel="noopener noreferrer">Terminal fallback</a> : <span aria-disabled="true">No terminal</span>}
              {previewLink ? <a href={previewLink} target="_blank" rel="noopener noreferrer">Web fallback</a> : <span aria-disabled="true">No Web preview</span>}
            </div>
            <p role="status">{feedback}</p>
          </>
        ) : <p>Select a session.</p>}
      </section>
      <footer>Quick Dock only · Terminal/Web panes live in appCenter · Chat stays native</footer>
    </main>
  );
}
