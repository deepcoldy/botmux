import { useEffect, useRef, useState } from 'react';
import { useT } from './react-hooks.js';
import { confirm } from './confirm-modal.js';
import type { GroupBot } from './groups-api.js';
import type { GroupRecallMessage, GroupRecallResult } from '../../services/group-message-recall.js';

export function GroupMessageRecall(props: { chatId: string; bots: GroupBot[]; active: boolean; disabled?: boolean }) {
  const tr = useT();
  const [appId, setAppId] = useState(props.bots[0]?.larkAppId ?? '');
  const [threadRootId, setThreadRootId] = useState('');
  const [messages, setMessages] = useState<GroupRecallMessage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nextToken, setNextToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<GroupRecallResult[]>([]);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const botAvailable = props.bots.some(bot => bot.larkAppId === appId);
  const available = props.active && !props.disabled && botAvailable;
  const availableRef = useRef(available);
  availableRef.current = available;

  useEffect(() => {
    if (!botAvailable) { setAppId(props.bots[0]?.larkAppId ?? ''); setThreadRootId(''); }
  }, [botAvailable, props.bots]);

  async function load(append: boolean, token = '') {
    if (!availableRef.current || busyRef.current) return;
    const version = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    if (!append) { setMessages([]); setSelected(new Set()); setNextToken(''); setResults([]); }
    const query = new URLSearchParams();
    if (token) query.set('pageToken', token);
    if (threadRootId) query.set('threadRootId', threadRootId);
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/messages/${encodeURIComponent(appId)}?${query}`, { signal: controller.signal });
      const body = await response.json();
      if (version !== generation.current) return;
      if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
      setMessages(previous => {
        const merged = new Map((append ? previous : []).map(message => [message.messageId, message]));
        for (const message of body.messages as GroupRecallMessage[]) merged.set(message.messageId, message);
        return [...merged.values()];
      });
      setNextToken(body.hasMore ? body.pageToken ?? '' : '');
    } catch (error) {
      if (version === generation.current && !controller.signal.aborted) setError(String(error instanceof Error ? error.message : error));
    } finally { if (version === generation.current) setLoading(false); }
  }
  useEffect(() => {
    void load(false);
    return () => { generation.current++; request.current?.abort(); };
  }, [props.chatId, appId, threadRootId, props.active, props.disabled, botAvailable, refresh]);

  async function recall() {
    if (!availableRef.current || busyRef.current || selected.size === 0) return;
    const ids = messages.filter(message => message.canRecall && selected.has(message.messageId)).map(message => message.messageId);
    if (!ids.length) return;
    const version = generation.current;
    busyRef.current = true; setBusy(true);
    try {
      const agreed = await confirm({ title: tr('groups.recallTitle'), message: tr('groups.recallConfirm', { n: ids.length }), danger: true });
      // 确认弹窗期间可能切群、切 bot 或关闭抽屉，不能把旧选择提交到新的上下文。
      if (!agreed || version !== generation.current || !availableRef.current) return;
      setError('');
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/messages/${encodeURIComponent(appId)}/recall`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageIds: ids }),
      });
      const body = await response.json();
      if (version !== generation.current) return;
      if (!response.ok || !Array.isArray(body.results)) throw new Error(body.error || `HTTP ${response.status}`);
      const outcome = body.results as GroupRecallResult[];
      setResults(outcome);
      const succeeded = new Set(outcome.filter(result => result.ok).map(result => result.messageId));
      setMessages(previous => previous.map(message => succeeded.has(message.messageId) ? { ...message, deleted: true, canRecall: false } : message));
      setSelected(previous => new Set([...previous].filter(id => !succeeded.has(id))));
    } catch (error) {
      if (version === generation.current) setError(String(error instanceof Error ? error.message : error));
    } finally {
      busyRef.current = false; setBusy(false);
      // 请求途中切走再切回会使旧结果失效；结束后补载当前上下文，避免仍可重复选择已撤回消息。
      if (version !== generation.current && availableRef.current) setRefresh(value => value + 1);
    }
  }
  const selectable = messages.filter(message => message.canRecall);
  const locked = !available || busy || loading;
  const selectAll = selectable.length > 0 && selectable.slice(0, 50).every(message => selected.has(message.messageId));
  return <div className="group-message-recall">
    <p className="hint">{tr('groups.recallHelp')}</p>
    <div className="group-recall-toolbar">
      <label>{tr('groups.recallBot')}<select aria-label={tr('groups.recallBot')} value={appId} disabled={busy || loading || props.disabled} onChange={event => { setAppId(event.currentTarget.value); setThreadRootId(''); }}>
        {props.bots.map(bot => <option value={bot.larkAppId} key={bot.larkAppId}>{bot.botName ?? bot.larkAppId}</option>)}
      </select></label>
      <button type="button" disabled={locked} onClick={() => setRefresh(value => value + 1)}>{tr('groups.recallRefresh')}</button>
      {threadRootId ? <button type="button" disabled={locked} onClick={() => setThreadRootId('')}>{tr('groups.recallBack')}</button> : null}
    </div>
    {error ? <p role="alert" className="hint-warn">{error}</p> : null}
    {results.length ? <div role="status" className="group-recall-results">
      <strong>{tr('groups.recallSummary', { ok: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length })}</strong>
      {results.filter(result => !result.ok).map(result => <p key={result.messageId}><code>{result.messageId}</code> · {result.error}</p>)}
    </div> : null}
    <div className="group-recall-toolbar">
      <label className="checkbox-row"><input type="checkbox" aria-label={tr('groups.recallSelectAll')} checked={selectAll} disabled={locked || !selectable.length} onChange={event => setSelected(event.currentTarget.checked ? new Set(selectable.slice(0, 50).map(message => message.messageId)) : new Set())} />{tr('groups.recallSelectAll')}</label>
      <button type="button" className="contrast" disabled={locked || !selected.size} onClick={() => void recall()}>{busy ? tr('groups.recallBusy') : tr('groups.recallSelected', { n: selected.size })}</button>
    </div>
    {!messages.length && !loading ? <p className="empty">{tr('groups.recallEmpty')}</p> : null}
    <ul className="group-recall-list">
      {messages.map(message => <li key={message.messageId} className={message.deleted ? 'recalled' : ''}>
        <input type="checkbox" aria-label={tr('groups.recallSelectMessage', { id: message.messageId })} checked={selected.has(message.messageId)} disabled={locked || !message.canRecall || (!selected.has(message.messageId) && selected.size >= 50)} onChange={event => {
          const checked = event.currentTarget.checked;
          setSelected(previous => { const next = new Set(previous); if (checked) next.add(message.messageId); else next.delete(message.messageId); return next; });
        }} />
        <div className="group-recall-message">
          <div className="group-recall-meta"><strong>{message.senderName || tr('groups.recallUnknownSender')}</strong><time>{Number.isFinite(Number(message.createTime)) && message.createTime ? new Date(Number(message.createTime)).toLocaleString() : ''}</time>{message.deleted ? <span>{tr('groups.recallDone')}</span> : null}</div>
          <pre>{message.deleted ? tr('groups.recallDone') : message.preview}</pre>
          {!threadRootId && message.hasThread ? <button type="button" disabled={locked} onClick={() => setThreadRootId(message.messageId)}>{tr('groups.recallThread')}</button> : null}
        </div>
      </li>)}
    </ul>
    {loading ? <p role="status">{tr('groups.recallLoading')}</p> : null}
    {nextToken ? <button type="button" disabled={locked} onClick={() => void load(true, nextToken)}>{tr('groups.recallMore')}</button> : null}
  </div>;
}
