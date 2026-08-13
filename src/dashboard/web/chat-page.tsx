// src/dashboard/web/chat-page.tsx
//
// Chat console — a DeepSeek-style conversation UI over the botmux session
// pool. Left rail: groups → sessions tree (which sessions live in which
// group). Center: the selected session's conversation (user / bot bubbles,
// Markdown-rendered). Bottom: composer that injects a turn directly into the
// session via POST /api/sessions/:id/messages — no Feishu interaction needed
// (and by default the reply is suppressed from Feishu; the Feishu bot keeps
// working normally for everyone else).
//
// Data sources:
//   - session list + live state: the shared dashboard store (SSE /api/events)
//   - message history: GET /api/sessions/:id/messages (local archive)
//   - sending: POST /api/sessions/:id/messages { content, suppressFeishuReply }
//   - live messages: `chat.message` SSE events buffered in the store
import { useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useDashboardStore, useT } from './react-hooks.js';
import { store, type ChatMessage } from './store.js';
import { chatDisplayTitle, escapeHtml } from './ui.js';
import { previewMarkdownHtml } from './preview-markdown.js';
import { sessionStatusText } from './sessions.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function rawHtml(html: string): { __html: string } {
  return { __html: html };
}

function messageText(message: ChatMessage): string {
  return String(message.content ?? '').trim();
}

function senderLabel(message: ChatMessage): string {
  if (message.role === 'bot') return 'Bot';
  if (message.senderName && message.senderName !== 'console') return String(message.senderName);
  return '我';
}

/** Extra provenance badge for model-initiated (botmux send) replies. */
function sourceBadge(message: ChatMessage): string | null {
  if (message.source !== 'send-marker') return null;
  return '模型直发';
}

function timeLabel(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return new Date(ts).toLocaleString();
}

/** Conversation bubbles for one message. */
function MessageBubble({ message }: { message: ChatMessage }) {
  const isBot = message.role === 'bot';
  const text = messageText(message);
  const content = isBot
    ? previewMarkdownHtml(text)
    : `<div class="chat-msg-plain">${escapeHtml(text)}</div>`;
  const badge = sourceBadge(message);
  return (
    <div className={`chat-msg ${isBot ? 'chat-msg-bot' : 'chat-msg-user'}`}>
      <div className="chat-msg-meta">
        <span className="chat-msg-sender">{senderLabel(message)}</span>
        {badge ? <span className="chat-msg-badge">{badge}</span> : null}
        {timeLabel(message.createTime) ? <span className="chat-msg-time">{timeLabel(message.createTime)}</span> : null}
      </div>
      <div className="chat-msg-body" dangerouslySetInnerHTML={rawHtml(content)} />
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

interface ChatGroup {
  key: string;
  title: string;
  sessions: Array<Record<string, any>>;
}

function groupSessionsForChat(sessions: Iterable<Record<string, any>>): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();
  for (const s of sessions) {
    const key = String(s.chatId ?? 'unknown');
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: chatDisplayTitle(s) ?? String(s.chatId ?? '未知群'),
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(s);
  }
  return [...groups.values()].map(g => ({
    ...g,
    sessions: g.sessions.sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0)),
  })).sort((a, b) => {
    const aAt = Math.max(...a.sessions.map(s => Number(s.lastMessageAt ?? 0)), 0);
    const bAt = Math.max(...b.sessions.map(s => Number(s.lastMessageAt ?? 0)), 0);
    return bAt - aAt;
  });
}

function ChatPage() {
  const tr = useT();
  const snapshot = useDashboardStore();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [markerMessages, setMarkerMessages] = useState<ChatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [suppressFeishu, setSuppressFeishu] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedSessionId;
  const olderCursorRef = useRef<number | undefined>(undefined);

  const sessions = useMemo(
    () => [...snapshot.sessions.values()].sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0)),
    [snapshot.sessions, snapshot.version],
  );
  const groups = useMemo(() => groupSessionsForChat(sessions), [sessions]);
  const selectedSession = useMemo(
    () => selectedSessionId ? snapshot.sessions.get(selectedSessionId) : undefined,
    [selectedSessionId, snapshot.sessions, snapshot.version],
  );

  // Load history when a session is selected.
  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      setMarkerMessages([]);
      setHasOlder(false);
      olderCursorRef.current = undefined;
      return;
    }
    store.clearChatMessages(selectedSessionId);
    setMessages([]);
    setMarkerMessages([]);
    setHistoryLoading(true);
    setHistoryError(null);
    setHasOlder(false);
    olderCursorRef.current = undefined;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages?limit=100`);
        const body = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok || body?.ok === false) {
          setHistoryError(String(body?.error ?? r.status));
          return;
        }
        const list: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
        setMessages([...list].sort((a, b) => a.seq - b.seq));
        // Model-initiated `botmux send` replies (turn-sends supplement).
        const markers: ChatMessage[] = Array.isArray(body.sendMarkers) ? body.sendMarkers : [];
        setMarkerMessages([...markers].sort((a, b) => b.createTime - a.createTime));
        const total = Number(body.total ?? list.length);
        setHasOlder(Number.isFinite(total) && total > list.length);
      } catch (e) {
        if (alive) setHistoryError(String(e));
      } finally {
        if (alive) setHistoryLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [selectedSessionId]);

  // Fold live SSE messages + turn-sends markers into the rendered list,
  // ordered by wall-clock createTime (markers carry synthetic negative seqs,
  // so seq ordering would misplace them). Dedupe by turnId when present
  // (optimistic console bubbles share the server turnId once the SSE event
  // lands, so the optimistic bubble is replaced rather than duplicated);
  // fall back to seq for archive rows.
  const liveMessages = selectedSessionId ? snapshot.chatMessages.get(selectedSessionId) : undefined;
  const merged = useMemo(() => {
    const keyOf = (m: ChatMessage): string => (m.turnId ? `t:${m.turnId}` : `s:${m.seq}`);
    const byKey = new Map<string, ChatMessage>();
    for (const m of messages) byKey.set(keyOf(m), m);
    for (const m of markerMessages) byKey.set(`m:${m.messageId ?? m.seq}`, m);
    for (const m of liveMessages ?? []) byKey.set(keyOf(m), m);
    return [...byKey.values()].sort((a, b) => a.createTime - b.createTime);
  }, [messages, markerMessages, liveMessages]);

  // Auto-scroll to the newest message when the list grows.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const count = merged.length;
    if (count > prevCountRef.current) {
      list.scrollTop = list.scrollHeight;
    }
    prevCountRef.current = count;
  }, [merged.length]);

  const loadOlder = async (): Promise<void> => {
    if (!selectedSessionId || loadingOlder) return;
    // Oldest ARCHIVE seq (markers carry negative seqs and must not drive the
    // cursor); undefined when only markers are loaded.
    const oldestArchive = messages[0];
    if (!oldestArchive || oldestArchive.seq < 0) return;
    const beforeSeq = oldestArchive.seq;
    if (beforeSeq === undefined) return;
    setLoadingOlder(true);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages?limit=100&beforeSeq=${beforeSeq}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) throw new Error(String(body?.error ?? r.status));
      const older: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
      setMessages(prev => {
        const map = new Map<number, ChatMessage>();
        for (const m of older) map.set(m.seq, m);
        for (const m of prev) map.set(m.seq, m);
        const mergedList = [...map.values()].sort((a, b) => a.seq - b.seq);
        const total = Number(body.total ?? mergedList.length);
        setHasOlder(Number.isFinite(total) && total > mergedList.length);
        return mergedList;
      });
    } catch (e) {
      setHistoryError(String(e));
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async (): Promise<void> => {
    const content = composer.trim();
    if (!content || sending || !selectedSessionId) return;
    setSending(true);
    setSendError(null);
    // Optimistic local bubble. It carries a client-generated turnId so the
    // server archive (which echoes the same turnId via SSE chat.message)
    // replaces it instead of duplicating it.
    const clientTurnId = `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const optimistic: ChatMessage = {
      seq: Date.now(),
      role: 'user',
      content,
      senderName: '我',
      turnId: clientTurnId,
      createTime: Date.now(),
    };
    setMessages(prev => [...prev, optimistic]);
    setComposer('');
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, suppressFeishuReply: suppressFeishu, clientTurnId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        // Roll the optimistic bubble back so the failed text is not lost.
        setMessages(prev => prev.filter(m => m.turnId !== clientTurnId));
        setComposer(content);
        setSendError(String(body?.error ?? body?.message ?? r.status));
        return;
      }
      // Success: drop the optimistic bubble. The archived row usually arrives
      // via SSE chat.message (same turnId → replaced in the merge); removing it
      // here guards against a lost SSE frame leaving a phantom bubble behind.
      setMessages(prev => prev.filter(m => m.turnId !== clientTurnId));
    } catch (e) {
      setMessages(prev => prev.filter(m => m.turnId !== clientTurnId));
      setComposer(content);
      setSendError(String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const selectSession = (sessionId: string): void => {
    setSelectedSessionId(sessionId);
  };

  return (
    <div className="chat-console">
      <aside className="chat-rail">
        <div className="chat-rail-header">
          <span>{tr('nav.chat')}</span>
          <span className="chat-rail-count">{sessions.length}</span>
        </div>
        <div className="chat-rail-groups">
          {groups.length === 0 ? (
            <div className="chat-rail-empty">{tr('chat.empty')}</div>
          ) : groups.map(group => (
            <div className="chat-group" key={group.key}>
              <div className="chat-group-title" title={group.key}>
                <span className="chat-group-dot" />
                {group.title}
                <span className="chat-group-count">{group.sessions.length}</span>
              </div>
              <div className="chat-group-sessions">
                {group.sessions.map(s => {
                  const active = s.sessionId === selectedSessionId;
                  const title = String(s.title || s.sessionId || '').replace(/\s+/g, ' ').slice(0, 40);
                  return (
                    <button
                      key={s.sessionId}
                      type="button"
                      className={`chat-session${active ? ' active' : ''}`}
                      onClick={() => selectSession(s.sessionId)}
                      title={s.sessionId}
                    >
                      <span className="chat-session-title">{title || '(未命名)'}</span>
                      <span className={`chat-session-status st-${String(s.status ?? 'unknown')}`}>
                        {sessionStatusText(s)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        {!selectedSession ? (
          <div className="chat-empty-state">
            <div className="chat-empty-title">{tr('chat.selectSession')}</div>
            <div className="chat-empty-hint">{tr('chat.selectHint')}</div>
          </div>
        ) : (
          <>
            <header className="chat-header">
              <div className="chat-header-title">
                {String(selectedSession.title || chatDisplayTitle(selectedSession) || selectedSession.sessionId || '')}
              </div>
              <div className="chat-header-meta">
                {chatDisplayTitle(selectedSession) ? <span className="chat-header-group">{chatDisplayTitle(selectedSession)}</span> : null}
                <span className={`chat-header-status st-${String(selectedSession.status ?? 'unknown')}`}>
                  {sessionStatusText(selectedSession)}
                </span>
                <span className="chat-header-cli">{String(selectedSession.cliId ?? 'unknown')}</span>
              </div>
            </header>

            <div className="chat-list" ref={listRef}>
              {historyLoading ? (
                <div className="chat-list-state">{tr('chat.loading')}</div>
              ) : historyError ? (
                <div className="chat-list-state chat-list-error">{tr('chat.historyFail')}: {historyError}</div>
              ) : merged.length === 0 ? (
                <div className="chat-list-state">{tr('chat.noMessages')}</div>
              ) : (
                <>
                  {hasOlder ? (
                    <button
                      type="button"
                      className="chat-load-older"
                      disabled={loadingOlder}
                      onClick={() => void loadOlder()}
                    >
                      {loadingOlder ? tr('chat.loading') : tr('chat.loadOlder')}
                    </button>
                  ) : null}
                  {merged.map(message => (
                    <MessageBubble key={`${message.seq}-${message.role}`} message={message} />
                  ))}
                </>
              )}
            </div>

            <footer className="chat-composer">
              {sendError ? <div className="chat-send-error">{tr('chat.sendFail')}: {sendError}</div> : null}
              <div className="chat-composer-row">
                <textarea
                  className="chat-input"
                  value={composer}
                  onChange={e => setComposer(e.currentTarget.value)}
                  onKeyDown={onKeyDown}
                  placeholder={tr('chat.placeholder')}
                  rows={3}
                  disabled={!selectedSession || selectedSession.status === 'closed'}
                />
                <div className="chat-composer-side">
                  <label className="chat-suppress" title={tr('chat.suppressHint')}>
                    <input
                      type="checkbox"
                      checked={suppressFeishu}
                      onChange={e => setSuppressFeishu(e.currentTarget.checked)}
                    />
                    <span>{tr('chat.suppressFeishu')}</span>
                  </label>
                  <button
                    type="button"
                    className="page-primary-action chat-send"
                    disabled={sending || !composer.trim() || !selectedSession || selectedSession.status === 'closed'}
                    onClick={() => void send()}
                  >
                    {sending ? tr('chat.sending') : tr('chat.send')}
                  </button>
                </div>
              </div>
              {selectedSession.status === 'closed' ? (
                <div className="chat-closed-note">{tr('chat.closedNote')}</div>
              ) : null}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

export function renderChatPage(root: HTMLElement): PageDisposer {
  const prev = {
    maxWidth: root.style.maxWidth,
    padding: root.style.padding,
    flex: root.style.flex,
    minHeight: root.style.minHeight,
    minWidth: root.style.minWidth,
    display: root.style.display,
    overflow: root.style.overflow,
  };
  root.style.maxWidth = 'none';
  root.style.padding = '0';
  root.style.flex = '1 1 auto';
  root.style.minHeight = '0';
  root.style.minWidth = '0';
  root.style.display = 'flex';
  root.style.overflow = 'hidden';

  const dispose = mountReactPage(root, <ChatPage />);
  return () => {
    dispose();
    root.style.maxWidth = prev.maxWidth;
    root.style.padding = prev.padding;
    root.style.flex = prev.flex;
    root.style.minHeight = prev.minHeight;
    root.style.minWidth = prev.minWidth;
    root.style.display = prev.display;
    root.style.overflow = prev.overflow;
  };
}
