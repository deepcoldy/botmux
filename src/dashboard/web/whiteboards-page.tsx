import { useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';

interface WhiteboardRow {
  id: string;
  title: string;
  scope: string;
  larkAppId?: string;
  chatId?: string;
  workingDir?: string;
  updatedAt: string;
  path: string;
  preview: string;
  logCount: number;
}

interface GroupRow { chatId?: string; name?: string }
interface SelectedBoard { id: string; content: string; row?: WhiteboardRow }

type GroupNameMap = Map<string, string>;

function rel(ts: string): string {
  const t = Date.parse(ts);
  if (!t) return ts || '-';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function groupKey(r: WhiteboardRow): string {
  return r.chatId?.trim() || '__local__';
}

function groupLabel(chatId: string, names: GroupNameMap): string {
  if (chatId === '__local__') return '未绑定群 / 本地白板';
  const name = names.get(chatId);
  return name && name !== chatId ? `${name} (${chatId})` : chatId;
}

function groupedRows(rows: WhiteboardRow[], names: GroupNameMap): Array<{ chatId: string; label: string; rows: WhiteboardRow[] }> {
  const map = new Map<string, WhiteboardRow[]>();
  for (const r of rows) {
    const key = groupKey(r);
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([chatId, list]) => ({
      chatId,
      label: groupLabel(chatId, names),
      rows: [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function itemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'block',
    textDecoration: 'none',
    color: 'inherit',
    border: `1px solid ${active ? 'rgba(14,165,233,.75)' : 'var(--border)'}`,
    borderRadius: 14,
    padding: '13px 14px',
    margin: '10px 0 10px 18px',
    background: active ? 'linear-gradient(135deg, rgba(14,165,233,.16), rgba(59,130,246,.08))' : 'var(--surface-raised)',
    boxShadow: active ? '0 10px 24px rgba(14,165,233,.13)' : '0 4px 14px rgba(15,23,42,.04)',
  };
}

function selectedIdFromHash(): string {
  return decodeURIComponent((location.hash.match(/^#\/whiteboards\/([^/]+)/)?.[1] ?? '').trim());
}

async function loadSelectedBoard(id: string, rows: WhiteboardRow[]): Promise<SelectedBoard | undefined> {
  const sr = await fetch(`/api/whiteboards/${encodeURIComponent(id)}`);
  const sb = await sr.json().catch(() => ({}));
  if (!sr.ok) return undefined;
  return { id, content: String(sb.content ?? ''), row: rows.find(r => r.id === id) };
}

async function loadGroupNames(res: Response | null): Promise<GroupNameMap> {
  const map = new Map<string, string>();
  if (!res?.ok) return map;
  const body = await res.json().catch(() => ({}));
  const chats: GroupRow[] = Array.isArray(body.chats) ? body.chats : [];
  for (const c of chats) {
    if (c.chatId) map.set(String(c.chatId), String(c.name || c.chatId));
  }
  return map;
}

function BoardItem(props: {
  row: WhiteboardRow;
  active: boolean;
  onSelect(id: string): void;
}) {
  const r = props.row;
  return (
    <a
      className={`wb-item${props.active ? ' active' : ''}`}
      data-whiteboard-id={r.id}
      href={`#/whiteboards/${encodeURIComponent(r.id)}`}
      style={itemStyle(props.active)}
      onClick={ev => {
        ev.preventDefault();
        props.onSelect(r.id);
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title || r.id}</strong>
          <span style={{ display: 'inline-block', marginTop: 4, fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' }}>{r.id}</span>
        </div>
        <span style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 999, padding: '2px 7px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.scope}</span>
      </div>
      <div style={{ marginTop: 9, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--muted)', fontSize: 12 }}>
        <span>{rel(r.updatedAt)}</span>
        <span>·</span>
        <span>log {r.logCount}</span>
      </div>
    </a>
  );
}

function MetaCard(props: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', background: 'var(--surface-raised)', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 5 }}>{props.label}</div>
      <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{props.value || '-'}</div>
    </div>
  );
}

function Detail(props: {
  selected?: SelectedBoard;
  groupNames: GroupNameMap;
  onDelete(): void;
}) {
  const selected = props.selected;
  if (!selected) return <p className="empty">选择左侧白板查看 meta 和 board.md。</p>;

  const selectedRow = selected.row;
  const selectedChat = selectedRow?.chatId ? groupLabel(selectedRow.chatId, props.groupNames) : '未绑定群 / 本地白板';
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow" style={{ margin: '0 0 6px' }}>WHITEBOARD</p>
          <h2 style={{ margin: 0, fontSize: 22, lineHeight: 1.25 }}>{selectedRow?.title || selected.id}</h2>
          <div style={{ marginTop: 8, color: 'var(--muted)', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12 }}>{selected.id}</div>
        </div>
        <button type="button" className="danger" data-delete-whiteboard onClick={props.onDelete}>删除白板</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10, marginBottom: 18 }}>
        <MetaCard label="所属群" value={selectedChat} />
        <MetaCard label="范围" value={selectedRow?.scope ?? '-'} />
        <MetaCard label="最近更新" value={selectedRow?.updatedAt ? rel(selectedRow.updatedAt) : '-'} />
        <MetaCard label="来源目录" value={selectedRow?.workingDir ?? '-'} />
      </div>
      <details style={{ marginBottom: 18, color: 'var(--muted)' }}>
        <summary style={{ cursor: 'pointer' }}>管理信息 / 文件路径</summary>
        <code style={{ display: 'block', marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{selectedRow?.path ?? ''}</code>
      </details>
      <section style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--surface-raised)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>当前状态 board.md</strong>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>read / update</span>
        </div>
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '70vh', overflow: 'auto', margin: 0, padding: 16, lineHeight: 1.65, background: 'transparent' }}>
          {selected.content || '（暂无内容）'}
        </pre>
      </section>
    </>
  );
}

function DeleteModal(props: {
  selected: SelectedBoard;
  deleting: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const title = props.selected.row?.title || props.selected.id;
  return (
    <div
      className="wb-delete-backdrop"
      data-delete-modal
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.48)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 20 }}
      onClick={ev => { if (ev.target === ev.currentTarget) props.onCancel(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="wb-delete-title" style={{ width: 'min(520px,92vw)', background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 18px 60px rgba(0,0,0,.35)', padding: '22px 24px' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div aria-hidden="true" style={{ width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(220,38,38,.14)', color: '#dc2626', fontWeight: 800 }}>!</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 id="wb-delete-title" style={{ margin: '0 0 8px', fontSize: 18 }}>删除白板？</h3>
            <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.6 }}>
              将删除 <strong>{title}</strong>（<code>{props.selected.id}</code>）的 board、log、meta，并清理默认绑定和会话引用。此操作不可恢复。
            </p>
          </div>
        </div>
        <div className="actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button type="button" data-delete-cancel onClick={props.onCancel} disabled={props.deleting}>取消</button>
          <button type="button" className="danger" data-delete-confirm onClick={props.onConfirm} disabled={props.deleting}>
            {props.deleting ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}

function WhiteboardsPage() {
  const mountedRef = useRef(false);
  const selectionSeqRef = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<WhiteboardRow[]>([]);
  const [groupNames, setGroupNames] = useState<GroupNameMap>(() => new Map());
  const [selected, setSelected] = useState<SelectedBoard | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SelectedBoard | null>(null);
  const [deleting, setDeleting] = useState(false);

  const groups = useMemo(() => groupedRows(rows, groupNames), [rows, groupNames]);

  useEffect(() => {
    mountedRef.current = true;
    const initialSelectedId = selectedIdFromHash();

    async function load(): Promise<void> {
      setLoading(true);
      try {
        const [whiteboardsRes, groupsRes] = await Promise.all([
          fetch('/api/whiteboards'),
          fetch('/api/groups').catch(() => null),
        ]);
        const body = await whiteboardsRes.json().catch(() => ({}));
        if (!whiteboardsRes.ok) throw new Error(body?.error ?? `HTTP ${whiteboardsRes.status}`);
        const nextGroupNames = await loadGroupNames(groupsRes);
        const nextRows: WhiteboardRow[] = Array.isArray(body.whiteboards) ? body.whiteboards : [];
        let nextSelected: SelectedBoard | undefined;
        if (initialSelectedId) nextSelected = await loadSelectedBoard(initialSelectedId, nextRows);
        if (!mountedRef.current) return;
        setEnabled(body.enabled === true);
        setRows(nextRows);
        setGroupNames(nextGroupNames);
        setSelected(nextSelected);
        setError(null);
      } catch (err) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    }

    void load();
    return () => {
      mountedRef.current = false;
      selectionSeqRef.current += 1;
    };
  }, []);

  async function selectBoard(id: string): Promise<void> {
    const seq = selectionSeqRef.current + 1;
    selectionSeqRef.current = seq;
    const next = await loadSelectedBoard(id, rows);
    if (!mountedRef.current || selectionSeqRef.current !== seq || !next) return;
    setSelected(next);
    window.history.replaceState(null, '', `#/whiteboards/${encodeURIComponent(id)}`);
  }

  async function deleteBoard(): Promise<void> {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/whiteboards/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      if (!mountedRef.current) return;
      setRows(cur => cur.filter(r => r.id !== deleteTarget.id));
      if (selected?.id === deleteTarget.id) {
        setSelected(undefined);
        window.history.replaceState(null, '', '#/whiteboards');
      }
      setDeleteTarget(null);
    } catch (err) {
      if (mountedRef.current) window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  }

  if (error) {
    return <section className="page"><p className="hint-warn">加载白板失败：{error}</p></section>;
  }

  if (loading) {
    return <div data-whiteboards-host><p className="empty">Loading whiteboards...</p></div>;
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Whiteboards</p>
          <h1>本地白板</h1>
          <p>按群共享的本地最新状态白板。开关关闭时仅只读展示历史白板，不注入 prompt、不允许 agent CLI 读写。</p>
        </div>
        <span className={`pill ${enabled ? 'ok' : 'warn'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      {enabled ? null : <p className="hint-warn">白板能力当前关闭：不会自动创建/绑定白板，也不会注入到 agent prompt。历史白板仅在 dashboard 中只读可见，可在此清理。</p>}
      <div className="wb-split" style={{ display: 'grid', gridTemplateColumns: 'minmax(300px,400px) minmax(0,1fr)', gap: 18, alignItems: 'start' }}>
        <article className="bd-card settings-card" style={{ padding: 18 }}>
          <h3 className="bd-section-title" style={{ marginBottom: 12 }}>群组 / 白板</h3>
          {groups.length === 0 ? (
            <p className="empty">暂无白板。打开能力后，每个群首次需要白板时才会创建默认白板。</p>
          ) : groups.map(g => (
            <details className="wb-group" open style={{ marginBottom: 14 }} key={g.chatId}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, margin: '12px 0 8px', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.label}</span>
                <small style={{ border: '1px solid var(--border)', borderRadius: 999, padding: '1px 7px', color: 'var(--muted)' }}>{g.rows.length}</small>
              </summary>
              {g.rows.map(r => (
                <BoardItem key={r.id} row={r} active={selected?.id === r.id} onSelect={id => void selectBoard(id)} />
              ))}
            </details>
          ))}
        </article>
        <article className="bd-card settings-card" id="whiteboard-detail" style={{ padding: '20px 22px' }}>
          <Detail selected={selected} groupNames={groupNames} onDelete={() => { if (selected) setDeleteTarget(selected); }} />
        </article>
      </div>
      {deleteTarget ? (
        <DeleteModal
          selected={deleteTarget}
          deleting={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteBoard()}
        />
      ) : null}
    </section>
  );
}

export function renderWhiteboardsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <WhiteboardsPage />);
}
