import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadingState, SectionHeader } from './dashboard-components.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';

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
      onClick={ev => {
        ev.preventDefault();
        props.onSelect(r.id);
      }}
    >
      <div className="wb-item-head">
        <div className="wb-item-main">
          <strong>{r.title || r.id}</strong>
          <span>{r.id}</span>
        </div>
        <span className="wb-scope">{r.scope}</span>
      </div>
      <div className="wb-item-meta">
        <span>{rel(r.updatedAt)}</span>
        <span>·</span>
        <span>log {r.logCount}</span>
      </div>
    </a>
  );
}

function MetaCard(props: { label: string; value: string }) {
  return (
    <div className="wb-meta-card">
      <div>{props.label}</div>
      <strong>{props.value || '-'}</strong>
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
      <div className="wb-detail-head">
        <div>
          <p className="eyebrow">WHITEBOARD</p>
          <h2>{selectedRow?.title || selected.id}</h2>
          <div>{selected.id}</div>
        </div>
        <button type="button" className="danger" data-delete-whiteboard onClick={props.onDelete}>删除白板</button>
      </div>
      <div className="wb-meta-grid">
        <MetaCard label="所属群" value={selectedChat} />
        <MetaCard label="范围" value={selectedRow?.scope ?? '-'} />
        <MetaCard label="最近更新" value={selectedRow?.updatedAt ? rel(selectedRow.updatedAt) : '-'} />
        <MetaCard label="来源目录" value={selectedRow?.workingDir ?? '-'} />
      </div>
      <details className="wb-admin-info">
        <summary>管理信息 / 文件路径</summary>
        <code>{selectedRow?.path ?? ''}</code>
      </details>
      <section className="wb-board-panel">
        <div className="wb-board-panel-head">
          <strong>当前状态 board.md</strong>
          <span>read / update</span>
        </div>
        <pre>
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
      onClick={ev => { if (ev.target === ev.currentTarget) props.onCancel(); }}
    >
      <div className="wb-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-delete-title">
        <div className="wb-delete-body">
          <div className="wb-delete-mark" aria-hidden="true">!</div>
          <div>
            <h3 id="wb-delete-title">删除白板？</h3>
            <p>
              将删除 <strong>{title}</strong>（<code>{props.selected.id}</code>）的 board、log、meta，并清理默认绑定和会话引用。此操作不可恢复。
            </p>
          </div>
        </div>
        <div className="actions wb-delete-actions">
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
  const tr = useT();
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

  const heading = (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{tr('nav.whiteboards')}</p>
        <h1>{tr('nav.whiteboards')}</h1>
      </div>
    </div>
  );

  if (error) {
    return <section className="page whiteboards-page">{heading}<p className="hint-warn">加载白板失败：{error}</p></section>;
  }

  if (loading) {
    return <section className="page whiteboards-page" data-whiteboards-host>{heading}<LoadingState label={tr('common.loading')} /></section>;
  }

  return (
    <section className="page whiteboards-page">
      {heading}
      {enabled ? null : <p className="hint-warn">白板能力当前关闭：不会自动创建/绑定白板，也不会注入到 agent prompt。历史白板仅在 dashboard 中只读可见，可在此清理。</p>}
      <div className="wb-split">
        <section className="overview-block wb-list-block">
          <SectionHeader title="群组 / 白板" count={rows.length} />
          <div className="wb-list-panel">
            {groups.length === 0 ? (
              <p className="empty wb-empty">暂无白板。打开能力后，每个群首次需要白板时才会创建默认白板。</p>
            ) : groups.map(g => (
              <details className="wb-group" open key={g.chatId}>
                <summary>
                  <span>{g.label}</span>
                  <small>{g.rows.length}</small>
                </summary>
                {g.rows.map(r => (
                  <BoardItem key={r.id} row={r} active={selected?.id === r.id} onSelect={id => void selectBoard(id)} />
                ))}
              </details>
            ))}
          </div>
        </section>
        <section className="overview-block wb-detail-block">
          <SectionHeader title="白板详情" />
          <div className="wb-detail-panel" id="whiteboard-detail">
            <Detail selected={selected} groupNames={groupNames} onDelete={() => { if (selected) setDeleteTarget(selected); }} />
          </div>
        </section>
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
