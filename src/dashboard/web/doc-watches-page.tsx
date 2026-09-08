import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu, LoadingState, OverflowText, RefreshIconButton } from './dashboard-components.js';
import { confirm } from './confirm-modal.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { toast } from './toast.js';
import {
  createDocWatch,
  deleteDocWatch,
  loadDocWatches,
  outcomeMeta,
  relTime,
  setDocWatchMode,
  type DocWatchBotResult,
  type DocWatchMode,
  type DocWatchRow,
} from './doc-watches.js';

interface BotRow { larkAppId: string; botName?: string | null }

const MODE_OPTIONS: Array<{ value: DocWatchMode; label: string }> = [
  { value: 'mention-only', label: '仅 @ 我时触发' },
  { value: 'all', label: '所有新评论' },
];

/** 文档链接：`file`/`docx` 等类型的 path 段与 fileType 不是一对一（doc→docs、
 *  sheet→sheets…），这里只对能确定的几种给链接，其余不给 —— 给错的链接比不给更糟。 */
function docUrl(row: DocWatchRow): string | null {
  const seg = row.fileType === 'docx' ? 'docx'
    : row.fileType === 'doc' ? 'docs'
      : row.fileType === 'sheet' ? 'sheets'
        : row.fileType === 'bitable' ? 'base'
          : row.fileType === 'slides' ? 'slides'
            : row.fileType === 'mindnote' ? 'mindnote'
              : null;
  return seg ? `https://feishu.cn/${seg}/${row.fileToken}` : null;
}

function OutcomeBadge(props: { row: DocWatchRow }) {
  const meta = outcomeMeta(props.row.lastOutcome);
  const title = props.row.lastError ? `${meta.hint}\n\n${props.row.lastError}` : meta.hint;
  return (
    <span className={`dw-outcome dw-outcome-${meta.kind}`} title={title}>
      {meta.label}
    </span>
  );
}

function WatchCard(props: {
  row: DocWatchRow;
  botName: string;
  busy: boolean;
  onMode: (mode: DocWatchMode) => void;
  onDelete: () => void;
}) {
  const { row } = props;
  const href = docUrl(row);
  const title = row.docTitle?.trim() || row.fileToken;
  return (
    <div className="dw-card" data-doc-watch={row.fileToken}>
      <div className="dw-card-head">
        <span className="dw-title">
          {href
            ? <a href={href} target="_blank" rel="noreferrer">{title}</a>
            : <OverflowText text={title} />}
        </span>
        {row.autoCreated ? (
          <span
            className="dw-pill dw-pill-auto"
            title={`由文档里的 @bot 自动创建${row.autoCreatedBy ? `，触发者 ${row.autoCreatedBy}` : ''}${row.autoCreatedAt ? `（${relTime(row.autoCreatedAt)}）` : ''}。owner 当时收到过一条私信通知。`}
          >自动创建</span>
        ) : null}
        {row.managedBy !== 'watch-comment' ? (
          <span className="dw-pill" title="旧 /subscribe-lark-doc 族：飞书侧有逐文件订阅">旧式订阅</span>
        ) : null}
      </div>

      <div className="dw-meta">
        <span title="飞书文档 token（订阅表主键）"><code>{row.fileToken.slice(0, 16)}</code></span>
        <span>{row.fileType}</span>
        <span className="dw-bot" title="所属机器人">{props.botName}</span>
        {row.workingDir
          ? <span className="dw-wd" title={`agent 工作目录：${row.workingDir}`}>📂 {row.workingDir}</span>
          : <span className="dw-wd dw-muted" title="没绑目录：触发时按 bot 的默认工作目录建会话">📂 未绑定目录</span>}
      </div>

      <div className="dw-runtime">
        <OutcomeBadge row={row} />
        <span title="最近一次评论事件/轮询尝试处理这篇文档的时间">最近活动 {relTime(row.lastActivityAt)}</span>
        <span title="最近一次真正把评论喂进会话的时间">最近投递 {relTime(row.lastDispatchAt)}</span>
        <span title="累计投递成功次数。0 = 配好了但从未真正触发过">投递 {row.dispatchCount ?? 0} 次</span>
        {row.commentTriggerMode === 'all' ? (
          <span
            className={row.pollBaselineReady === true ? '' : 'dw-warn'}
            title={row.pollBaselineReady === true
              ? '轮询基线已建立，只处理基线之后的新评论'
              : '轮询基线尚未建立：下一轮 poll 会先建基线（只建基线、不重放历史评论）'}
          >
            {row.pollBaselineReady === true ? '轮询就绪' : '待建基线'}
          </span>
        ) : null}
      </div>

      {row.lastError ? <p className="dw-error" title={row.lastError}>{row.lastError}</p> : null}

      <div className="dw-actions">
        <DropdownMenu<DocWatchMode>
          className="dw-mode"
          ariaLabel="触发范围"
          disabled={props.busy}
          label={MODE_OPTIONS.find(o => o.value === row.commentTriggerMode)?.label ?? row.commentTriggerMode}
          value={row.commentTriggerMode}
          options={MODE_OPTIONS}
          onChange={props.onMode}
        />
        <button type="button" className="danger" disabled={props.busy} onClick={props.onDelete}>
          停止监听
        </button>
      </div>
    </div>
  );
}

function AddForm(props: {
  bots: BotRow[];
  selectedBot: string;
  onBot: (id: string) => void;
  busy: boolean;
  onSubmit: (input: { docRef: string; commentTriggerMode: DocWatchMode; workingDir?: string }) => void;
}) {
  const [docRef, setDocRef] = useState('');
  const [mode, setMode] = useState<DocWatchMode>('mention-only');
  const [workingDir, setWorkingDir] = useState('');
  const canSubmit = !props.busy && docRef.trim().length > 0 && props.selectedBot.length > 0;
  return (
    <div className="dw-add">
      <div className="dw-add-row">
        {/* 注意：包 DropdownMenu 的容器必须用 div，不能用 label 元素 —— label 会
            隐式关联第一个可 labelable 后代，而 DropdownMenu 的选项是 button，
            于是点一下字段标题就会静默选中第 1 个选项。标题用 span，无障碍名由
            组件自己的 ariaLabel 提供。
            （test/dashboard-rebase-ui-regressions.test.ts 扫整个 web/ 钉死这条；
            那个扫描器认的是裸标签文本，所以这段注释里刻意不写尖括号形式。） */}
        <div className="dw-field">
          <span>机器人</span>
          <DropdownMenu<string>
            ariaLabel="选择机器人"
            disabled={props.busy || props.bots.length === 0}
            label={props.bots.find(b => b.larkAppId === props.selectedBot)?.botName || props.selectedBot || '选择机器人'}
            value={props.selectedBot}
            options={props.bots.map(b => ({ value: b.larkAppId, label: b.botName || b.larkAppId }))}
            onChange={props.onBot}
            searchable
            searchPlaceholder="搜索机器人"
          />
        </div>
        <div className="dw-field">
          <span>触发范围</span>
          <DropdownMenu<DocWatchMode>
            ariaLabel="触发范围"
            disabled={props.busy}
            label={MODE_OPTIONS.find(o => o.value === mode)?.label ?? mode}
            value={mode}
            options={MODE_OPTIONS}
            onChange={setMode}
          />
        </div>
      </div>
      <label className="dw-field dw-field-wide">
        <span>文档链接或 token</span>
        <input
          type="text"
          value={docRef}
          disabled={props.busy}
          placeholder="https://…feishu.cn/docx/<token>  或直接粘贴 token"
          onChange={e => setDocRef(e.currentTarget.value)}
        />
      </label>
      <label className="dw-field dw-field-wide">
        <span>工作目录（可选）</span>
        <input
          type="text"
          value={workingDir}
          disabled={props.busy}
          placeholder="留空则用该 bot 的默认工作目录"
          onChange={e => setWorkingDir(e.currentTarget.value)}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!canSubmit}
          onClick={() => props.onSubmit({
            docRef: docRef.trim(),
            commentTriggerMode: mode,
            ...(workingDir.trim() ? { workingDir: workingDir.trim() } : {}),
          })}
        >
          {props.busy ? '登记中…' : '开始监听'}
        </button>
      </div>
      <p className="hint">
        监听后，该文档的评论会喂进会话、bot 的回复发回评论串。
        「仅 @ 我时触发」最安全；「所有新评论」适合专用文档（走应用身份轮询，切换时会先重建基线、不重放历史评论）。
      </p>
    </div>
  );
}

function DocWatchesPage() {
  const tr = useT();
  const mountedRef = useRef(false);
  const [bots, setBots] = useState<BotRow[]>([]);
  const [results, setResults] = useState<DocWatchBotResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedBot, setSelectedBot] = useState('');

  const reload = useCallback(async (botRows: BotRow[]): Promise<void> => {
    // 逐 bot 并发拉，单个 bot 失败只标它自己（daemon 离线是常态，不该整页空白）。
    const settled = await Promise.all(botRows.map(async (b): Promise<DocWatchBotResult> => {
      const r = await loadDocWatches(b.larkAppId);
      return {
        larkAppId: b.larkAppId,
        botName: b.botName ?? undefined,
        watches: r.watches,
        ...(r.error ? { error: r.error } : {}),
      };
    }));
    if (!mountedRef.current) return;
    setResults(settled);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/bots');
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        const rows: BotRow[] = Array.isArray(body.bots) ? body.bots : [];
        if (!mountedRef.current) return;
        setBots(rows);
        setSelectedBot(cur => cur || rows[0]?.larkAppId || '');
        await reload(rows);
        if (mountedRef.current) setError(null);
      } catch (err) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
    return () => { mountedRef.current = false; };
  }, [reload]);

  const botName = useCallback((larkAppId: string): string => (
    bots.find(b => b.larkAppId === larkAppId)?.botName || larkAppId
  ), [bots]);

  const flat = useMemo(() => (
    results.flatMap(r => r.watches.map(w => ({ ...w, larkAppId: w.larkAppId ?? r.larkAppId })))
  ), [results]);

  const botErrors = useMemo(() => results.filter(r => r.error), [results]);

  // 需要注意的：真故障（轮询失败 / 审计拒绝）+ 从未投递过的。
  const attention = useMemo(() => flat.filter(w => {
    const kind = outcomeMeta(w.lastOutcome).kind;
    return kind === 'error' || kind === 'warn';
  }), [flat]);

  async function changeMode(row: DocWatchRow, mode: DocWatchMode): Promise<void> {
    if (mode === row.commentTriggerMode) return;
    const appId = row.larkAppId;
    if (!appId) return;
    setBusyToken(row.fileToken);
    const r = await setDocWatchMode(appId, row.fileToken, mode);
    if (!mountedRef.current) return;
    setBusyToken(null);
    if (!r.ok) { toast(`切换失败：${r.error}`, { kind: 'error' }); return; }
    toast(mode === 'all' ? '已改为「所有新评论」（下一轮先重建基线）' : '已改为「仅 @ 我时触发」');
    await reload(bots);
  }

  async function removeWatch(row: DocWatchRow): Promise<void> {
    const appId = row.larkAppId;
    if (!appId) return;
    const label = row.docTitle?.trim() || row.fileToken.slice(0, 16);
    const ok = await confirm({
      title: '停止监听该文档？',
      message: `将删除「${label}」的监听绑定。之后该文档的评论不再喂进会话；如果有人在文档里 @bot，会重新自动创建一条 mention-only 监听。`,
      danger: true,
      confirmLabel: '停止监听',
    });
    if (!ok) return;
    setBusyToken(row.fileToken);
    const r = await deleteDocWatch(appId, row.fileToken);
    if (!mountedRef.current) return;
    setBusyToken(null);
    if (!r.ok) { toast(`停止失败：${r.error}`, { kind: 'error' }); return; }
    toast('已停止监听');
    await reload(bots);
  }

  async function addWatch(input: { docRef: string; commentTriggerMode: DocWatchMode; workingDir?: string }): Promise<void> {
    if (!selectedBot) return;
    setAdding(true);
    const r = await createDocWatch(selectedBot, input);
    if (!mountedRef.current) return;
    setAdding(false);
    if (!r.ok) {
      toast(`登记失败：${r.message || r.error}`, { kind: 'error' });
      return;
    }
    toast('已开始监听');
    await reload(bots);
  }

  const heading = (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{tr('nav.docWatches')}</p>
        <h1>{tr('nav.docWatches')}</h1>
      </div>
      <RefreshIconButton
        label="刷新"
        busy={loading}
        disabled={loading || busyToken !== null}
        onClick={() => { void reload(bots); }}
      />
    </div>
  );

  if (error) {
    return <section className="page dw-page">{heading}<p className="hint-warn">加载失败：{error}</p></section>;
  }
  if (loading) {
    return <section className="page dw-page">{heading}<LoadingState label={tr('common.loading')} /></section>;
  }

  return (
    <section className="page dw-page">
      {heading}

      <section className="overview-block">
        <h2>开始监听一篇文档</h2>
        <AddForm
          bots={bots}
          selectedBot={selectedBot}
          onBot={setSelectedBot}
          busy={adding}
          onSubmit={input => { void addWatch(input); }}
        />
      </section>

      {botErrors.length > 0 ? (
        <section className="overview-block">
          <h2>部分机器人读取失败</h2>
          <ul className="dw-bot-errors">
            {botErrors.map(b => (
              <li key={b.larkAppId}>
                <strong>{b.botName || b.larkAppId}</strong>：{b.error}
              </li>
            ))}
          </ul>
          <p className="hint">daemon 离线时该 bot 的监听读不到 —— 这不代表监听已丢，重启后会恢复。</p>
        </section>
      ) : null}

      <section className="overview-block">
        <h2>
          监听中的文档
          <small className="dw-count">
            {flat.length} 条{attention.length > 0 ? ` · ${attention.length} 条需要注意` : ''}
          </small>
        </h2>
        {flat.length === 0 ? (
          <p className="empty">
            还没有任何文档监听。上面贴一个文档链接即可开始；
            也可以直接在飞书文档里 @ 机器人 —— 那会自动创建一条「仅 @ 我时触发」的监听，并在这里显示为「自动创建」。
          </p>
        ) : (
          <div className="dw-list">
            {flat.map(row => (
              <WatchCard
                key={`${row.larkAppId}:${row.fileToken}`}
                row={row}
                botName={botName(row.larkAppId ?? '')}
                busy={busyToken === row.fileToken}
                onMode={mode => { void changeMode(row, mode); }}
                onDelete={() => { void removeWatch(row); }}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

export function renderDocWatchesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <DocWatchesPage />);
}
