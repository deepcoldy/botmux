import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  buildWorkbenchHash,
  groupWorkbenchSessions,
  workbenchExternalTerminalHref,
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
import {
  WorkbenchAppearanceMenu,
  useWorkbenchAppearanceRoot,
} from './agent-workbench-appearance-menu.js';
import { WorkbenchSessionList } from './agent-workbench-session-list.js';
// 终端面板用的同一份触屏契约（P1-17）：坞里的终端链接不能自己另发一条裸 Cookie 地址。
import { useTerminalViewLink, useTouchEnvironment } from './agent-workbench-touch.js';

export interface AgentWorkbenchDockViewProps {
  sessions: readonly WorkbenchSessionRow[];
  online: boolean;
  authenticated: boolean;
  /** 本机完整管理身份（`ui.authed`）。同完整工作台：只决定 ⋯ 菜单里那一项
   *  「常驻链接」画不画，缺省 false = fail closed。 */
  manageAuthed?: boolean;
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

export function AgentWorkbenchDockView(props: AgentWorkbenchDockViewProps): React.JSX.Element {
  const api = useMemo(() => props.api ?? createWorkbenchApi(), [props.api]);
  // 坞和完整工作台是同一份外观：挂载期间落到文档根，离开时还回全站机制。
  useWorkbenchAppearanceRoot();
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
  // P1-17：坞里的「终端链接」和完整工作台的终端面板走同一条鉴权分岔。
  // 以前这里永远发裸的同源 /s/<id>，而 iOS WebView 发 WebSocket 升级时不带 Cookie，
  // 于是手机上点开只有一片 403 空白——和当初手机端整页空白是同一个根因。触屏（以及
  // 任何没有 Dashboard Cookie 的场合）改成先换一条短时 viewToken 只读链接再放进
  // href；桌面登录态照旧用同源地址，它捎带接管授权，绕道反而丢功能。
  const touch = useTouchEnvironment();
  const cookieTerminalLink = selected ? workbenchTerminalHref(selected, location) : null;
  // 外部 Riff 终端本来就是别的 origin，能力凭证对它无效，保持原样直接跳。
  const externalTerminalLink = selected ? workbenchExternalTerminalHref(selected) : null;
  const wantsViewToken = Boolean(cookieTerminalLink) && !externalTerminalLink && (touch || !props.authenticated);
  const viewLink = useTerminalViewLink({
    api,
    sessionId: selected?.sessionId ?? '',
    enabled: wantsViewToken,
  });
  // 触屏没有裸回退：链接没到手就摆等待/重试，绝不退回同源地址——那条路在 iOS 上必然
  // 是 403 空白，摆出来只会让人以为终端坏了。
  const terminalLink = wantsViewToken ? viewLink.link?.url ?? null : cookieTerminalLink;
  const previewLink = selected ? workbenchPreviewHref(selected) : null;

  return (
    <main className="agent-workbench-dock" data-surface="sidebar" style={{ minWidth: 350 }}>
      <header className="wb-dock-header">
        <div><span aria-hidden="true">◖</span><strong>会话坞</strong></div>
        <span className={props.online ? 'is-online' : 'is-offline'}>{props.online ? '● 在线' : '○ 离线'}</span>
        {/* 精简形态头部放不下单列图标，外观仍走 ⋯ 菜单——和完整工作台同一个状态源。 */}
        <WorkbenchAppearanceMenu standingLink={props.manageAuthed === true} api={api} />
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
              {terminalLink
                ? <a href={terminalLink} target="_blank" rel="noopener noreferrer">终端链接</a>
                : wantsViewToken
                  ? (viewLink.phase === 'failed'
                    ? <button type="button" onClick={viewLink.retry}>终端重试</button>
                    : <span aria-disabled="true">终端准备中…</span>)
                  : <span aria-disabled="true">无终端</span>}
              {previewLink ? <a href={previewLink} target="_blank" rel="noopener noreferrer">网页链接</a> : <span aria-disabled="true">无网页预览</span>}
            </div>
          </>
        ) : <p>请选择一个会话。</p>}
      </section>
      <footer>轻量会话坞 · 终端/网页请在完整工作台查看 · 聊天使用飞书原生窗口</footer>
    </main>
  );
}
