// 决策看板（#/board）：汇总页 + 单项详情页。
//
// 草稿存在服务端（一张看板一份，电脑和飞书侧栏看到的是同一份），自动保存、不发出去；
// 点一次「提交 N 项决定」= 一个批次 = 管家会话里的一个回合。页面窄到 350px（飞书侧栏）
// 也要能用，所以详情页只有一列。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import { DropdownMenu, LoadingState } from './dashboard-components.js';
import { ModalDialog } from './modal-dialog.js';
import { confirm } from './confirm-modal.js';
import { setLeaveGuard } from './leave-guard.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import { previewMarkdownHtml } from './preview-markdown.js';
import { toast } from './toast.js';
import { botDefaultsHref } from './bot-defaults.js';
import {
  BoardRequestError,
  boardFileUrl,
  fetchBoardItem,
  fetchBoardItems,
  fetchBoards,
  markBoardItemSeen,
  redeliverBoardBatch,
  saveBoardDraft,
  submitBoardDecisions,
  uploadBoardImage,
  type SubmitResult,
} from './decision-board-api.js';
import {
  BOARD_ACTOR_LABEL_KEYS,
  BOARD_EMPTY_VIEW_KEYS,
  BOARD_EVENT_KIND_KEYS,
  BOARD_FILES_PER_DRAFT,
  BOARD_IMAGE_TYPES,
  BOARD_VIEW_LABEL_KEYS,
  BOARD_VIEW_ORDER,
  EMPTY_DRAFT,
  batchView,
  boardClock,
  boardItemHash,
  boardRelativeTime,
  boardSummaryHash,
  checkBoardImages,
  draftFromServer,
  draftNeedsReview,
  isDraftEmpty,
  newSubmitNonce,
  orderSubmitCandidates,
  parseBoardHash,
  pickBoard,
  questionOneLine,
  sameDraftContent,
  stateChipText,
  submitCandidateFromDetail,
  submitPayloadItems,
  submitScope,
  textPreview,
  type BoardBatch,
  type BoardDetailResponse,
  type BoardDraft,
  type BoardEvent,
  type BoardItem,
  type BoardListResponse,
  type BoardRoute,
  type BoardState,
  type BoardSummary,
  type BoardView,
  type DraftInput,
  type DraftSaveState,
  type RenderedLink,
  type SubmitCandidate,
  type Translate,
} from './decision-board-model.js';

const AUTOSAVE_MS = 800;
const SEARCH_DEBOUNCE_MS = 300;

/** 汇总页最后一次的地址（含看板、视图、搜索词）：详情页的「返回」回到这里。 */
let lastSummaryHash = '#/board';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stewardConfigHref(appId: string): string {
  return botDefaultsHref({ bot: appId, section: 'steward' });
}

function imageFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('bad_image_data'));
    reader.onerror = () => reject(reader.error ?? new Error('image_read_failed'));
    reader.readAsDataURL(file);
  });
}

// ─── 小部件 ─────────────────────────────────────────────────────────────────

function StateChip(props: { state: BoardState; stage?: string }) {
  const tr = useT();
  return <span className={`dboard-state dboard-state-${props.state}`}>{stateChipText(props.state, props.stage, tr)}</span>;
}

function Markdown(props: { text: string; className?: string }) {
  const html = useMemo(() => previewMarkdownHtml(props.text), [props.text]);
  if (!html) return null;
  return <div className={['dboard-md', props.className].filter(Boolean).join(' ')} dangerouslySetInnerHTML={{ __html: html }} />;
}

function LinkChips(props: { links: RenderedLink[] }) {
  if (!props.links.length) return null;
  return (
    <div className="dboard-links">
      {props.links.map((link, index) => link.url ? (
        <a key={`${link.kind}:${link.ref}:${index}`} className="dboard-link" href={link.url} target="_blank" rel="noopener noreferrer" title={link.ref}>
          {link.text} <span aria-hidden="true">↗</span>
        </a>
      ) : (
        <span key={`${link.kind}:${link.ref}:${index}`} className="dboard-link dboard-link-plain" title={link.ref}>{link.text}</span>
      ))}
    </div>
  );
}

function batchAuthor(batch: BoardBatch, tr: Translate): string {
  if (batch.authorName) return batch.authorName;
  if (batch.author === 'local' || batch.author === 'owner') return tr('decisionBoard.authorYou');
  return tr('decisionBoard.authorSignedIn');
}

// ─── 提交确认框（汇总页与详情页共用）──────────────────────────────────────────

export function SubmitDialog(props: {
  appId: string;
  seqs: number[];
  firstSeq?: number;
  onClose(changed: boolean): void;
}) {
  const tr = useT();
  const { appId, seqs, firstSeq } = props;
  const [phase, setPhase] = useState<'loading' | 'confirm' | 'submitting' | 'done'>('loading');
  const [candidates, setCandidates] = useState<SubmitCandidate[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [redelivering, setRedelivering] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // 同一次点击的重试（网络断了、不知道服务端收没收到）沿用同一个 nonce，服务端据此去重。
  const nonceRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);
    // 每项现读一次：确认框里看到的就是要提交的那一版草稿（草稿版本随请求带上，被改过服务端会拒）。
    void Promise.allSettled(seqs.map(seq => fetchBoardItem(appId, seq))).then(results => {
      if (cancelled) return;
      const found: SubmitCandidate[] = [];
      let failure: string | null = null;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const candidate = submitCandidateFromDetail(r.value);
          if (candidate) found.push(candidate);
        } else if (!(r.reason instanceof BoardRequestError && r.reason.code === 'item_not_found')) {
          failure = errorText(r.reason);
        }
      }
      setCandidates(orderSubmitCandidates(found, firstSeq));
      setExcluded(current => new Set([...current].filter(seq => found.some(c => c.seq === seq))));
      setError(failure);
      setPhase('confirm');
    });
    return () => { cancelled = true; };
  }, [appId, seqs, firstSeq, reloadTick]);

  const items = submitPayloadItems(candidates, excluded);
  const close = () => {
    if (phase === 'submitting') return;
    props.onClose(!!result);
  };

  async function submit(): Promise<void> {
    if (!items.length) return;
    const nonce = nonceRef.current ?? newSubmitNonce();
    nonceRef.current = nonce;
    setPhase('submitting');
    setError(null);
    try {
      const res = await submitBoardDecisions(appId, nonce, items);
      nonceRef.current = null;
      setResult(res);
      setPhase('done');
    } catch (err) {
      // 服务端明确拒了（草稿被改过等）：这次提交没发生，下次点击是新的一次。
      if (err instanceof BoardRequestError && err.answered) nonceRef.current = null;
      setError(errorText(err));
      setPhase('confirm');
    }
  }

  async function redeliver(): Promise<void> {
    if (!result) return;
    setRedelivering(true);
    try {
      const batch = await redeliverBoardBatch(appId, result.batch.id);
      setResult({ ...result, batch });
    } catch (err) {
      toast(errorText(err), { kind: 'error' });
    } finally {
      setRedelivering(false);
    }
  }

  const title = phase === 'done' && result
    ? tr('decisionBoard.batchTitle', { id: result.batch.id })
    : tr('decisionBoard.submitDialogTitle', { n: items.length });

  let body: ReactNode;
  if (phase === 'loading') {
    body = <LoadingState compact label={tr('decisionBoard.submitDialogLoading')} />;
  } else if (phase === 'done' && result) {
    const view = batchView(result.batch, Date.now(), tr);
    const id = result.batch.id;
    const line = result.batch.delivery === 'delivered'
      ? tr('decisionBoard.resultDelivered', { id })
      : result.batch.delivery === 'pending'
        ? tr('decisionBoard.resultPending', { id })
        : tr('decisionBoard.resultFailed', { id, error: view.reason ?? '' });
    body = (
      <div className="dboard-result" data-delivery={result.batch.delivery}>
        <p className={`dboard-result-line tone-${view.tone}`}>{line}</p>
        {result.duplicate ? <p className="dboard-muted">{tr('decisionBoard.resultDuplicate')}</p> : null}
        {result.batch.delivery !== 'delivered'
          ? <p className="dboard-muted">{tr('decisionBoard.resultKept')}</p> : null}
        {view.needsChat ? <a className="dboard-inline-link" href={stewardConfigHref(appId)} onClick={() => props.onClose(true)}>{tr('decisionBoard.openBotConfig')}</a> : null}
      </div>
    );
  } else {
    body = (
      <>
        <p className="dboard-muted">{tr('decisionBoard.submitDialogIntro')}</p>
        {candidates.length === 0 ? <p className="dboard-empty-line">{tr('decisionBoard.submitDialogEmpty')}</p> : (
          <ul className="dboard-submit-list">
            {candidates.map(c => {
              const checked = !excluded.has(c.seq);
              return (
                <li key={c.seq} className={checked ? undefined : 'is-excluded'}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={phase === 'submitting'}
                      onChange={event => {
                        const on = event.currentTarget.checked;
                        setExcluded(current => {
                          const next = new Set(current);
                          if (on) next.delete(c.seq); else next.add(c.seq);
                          return next;
                        });
                      }}
                    />
                    <span className="dboard-submit-item">
                      <span className="dboard-submit-item-head">
                        <span className="dboard-seq">#{c.seq}</span>
                        <strong>{c.title}</strong>
                        {c.stale ? <span className="dboard-flag-warn">{tr('decisionBoard.staleRow')}</span> : null}
                      </span>
                      <span className="dboard-submit-item-choice">
                        {c.choice
                          ? `${tr('decisionBoard.choiceLabel', { key: c.choice })}${c.choiceLabel ? ` ${c.choiceLabel}` : ''}${c.recommended ? ` (${tr('decisionBoard.recommended')})` : ''}`
                          : tr('decisionBoard.noChoice')}
                      </span>
                      <span className="dboard-submit-item-text">{c.text.trim() ? textPreview(c.text, 120) : tr('decisionBoard.noText')}</span>
                      {c.imageCount ? <span className="dboard-submit-item-images">{tr('decisionBoard.imagesN', { n: c.imageCount })}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {error ? (
          <p className="dboard-error-line" role="alert">
            {error}{' '}
            <button type="button" className="dboard-text-btn" onClick={() => setReloadTick(n => n + 1)}>{tr('decisionBoard.refreshDrafts')}</button>
          </p>
        ) : null}
      </>
    );
  }

  return (
    <ModalDialog
      open
      className="confirm-modal-dialog dboard-submit-dialog"
      aria-labelledby="dboard-submit-title"
      backdropClose={phase !== 'submitting'}
      onRequestClose={close}
    >
      <div className="confirm-modal-card">
        <h3 id="dboard-submit-title" className="confirm-modal-title">{title}</h3>
        <div className="dboard-submit-body">{body}</div>
        <div className="confirm-modal-footer">
          {phase === 'done' && result ? (
            <>
              {batchView(result.batch, Date.now(), tr).canRedeliver ? (
                <button type="button" className="btn-cancel" disabled={redelivering} onClick={() => void redeliver()}>
                  {redelivering ? tr('decisionBoard.redelivering') : tr('decisionBoard.redeliver')}
                </button>
              ) : null}
              <button type="button" className="btn-primary" onClick={close}>{tr('decisionBoard.close')}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn-cancel" disabled={phase === 'submitting'} onClick={close}>{tr('decisionBoard.cancel')}</button>
              <button type="button" className="btn-primary" disabled={phase !== 'confirm' || items.length === 0} onClick={() => void submit()}>
                {phase === 'submitting' ? tr('decisionBoard.submitting') : tr('decisionBoard.confirmSubmit', { n: items.length })}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}

// ─── 最近提交 ───────────────────────────────────────────────────────────────

function BatchList(props: { appId: string; batches: BoardBatch[]; now: number; onChanged(): void }) {
  const tr = useT();
  const [busyId, setBusyId] = useState<number | null>(null);
  if (!props.batches.length) return null;

  async function redeliver(id: number): Promise<void> {
    setBusyId(id);
    try {
      const batch = await redeliverBoardBatch(props.appId, id);
      const view = batchView(batch, Date.now(), tr);
      toast(batch.delivery === 'delivered'
        ? tr('decisionBoard.redeliverDone', { id })
        : tr('decisionBoard.redeliverFailed', { id, error: view.reason ?? tr(view.labelKey) }), { kind: batch.delivery === 'delivered' ? 'success' : 'warning' });
      props.onChanged();
    } catch (err) {
      toast(errorText(err), { kind: 'error' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="dboard-block dboard-batches">
      <h2 className="dboard-block-title">{tr('decisionBoard.recentBatches')}</h2>
      <ul className="dboard-batch-list">
        {props.batches.map(batch => {
          const view = batchView(batch, props.now, tr);
          return (
            <li key={batch.id} className="dboard-batch" data-delivery={batch.delivery}>
              <span className="dboard-batch-id">{tr('decisionBoard.batchTitle', { id: batch.id })}</span>
              <span className="dboard-batch-meta">{batchAuthor(batch, tr)} · {boardRelativeTime(batch.createdAt, props.now, tr)}</span>
              <span className={`dboard-batch-status tone-${view.tone}`}>{tr(view.labelKey)}</span>
              {view.reason ? <span className="dboard-batch-reason">{view.reason}</span> : null}
              {view.needsChat ? <a className="dboard-inline-link" href={stewardConfigHref(props.appId)}>{tr('decisionBoard.openBotConfig')}</a> : null}
              {view.canRedeliver ? (
                <button type="button" className="dboard-text-btn" disabled={busyId === batch.id} onClick={() => void redeliver(batch.id)}>
                  {busyId === batch.id ? tr('decisionBoard.redelivering') : tr('decisionBoard.redeliver')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── 汇总页 ─────────────────────────────────────────────────────────────────

function BoardRow(props: { appId: string; item: BoardListResponse['items'][number]; now: number }) {
  const tr = useT();
  const { item } = props;
  const asking = item.state === 'decide' || item.state === 'accept';
  const question = asking && item.question ? questionOneLine(item.question) : '';
  return (
    <li>
      <a className={`dboard-row${item.unseen ? ' is-unseen' : ''}`} href={boardItemHash(props.appId, item.seq)} data-seq={item.seq}>
        <span className="dboard-row-dot" aria-label={item.unseen ? tr('decisionBoard.unseenMark') : undefined}>{item.unseen ? '●' : ''}</span>
        <span className="dboard-row-main">
          <span className="dboard-row-title">
            <span className="dboard-seq">#{item.seq}</span>
            <strong>{item.title}</strong>
          </span>
          {asking && (question || item.recommend) ? (
            <span className="dboard-row-ask">
              {question ? <>{tr('decisionBoard.askShort')}{question}</> : null}
              {question && item.recommend ? ' ｜ ' : null}
              {item.recommend ? tr('decisionBoard.recommendShort', { key: item.recommend }) : null}
            </span>
          ) : null}
          {item.pendingDecisions > 0 ? <span className="dboard-row-pending">{tr('decisionBoard.pendingShort')}</span> : null}
        </span>
        <span className="dboard-row-meta">
          <StateChip state={item.state} stage={item.stage} />
          {item.repo ? <span className="dboard-row-repo">{item.repo}</span> : null}
          <span className="dboard-row-time">{boardRelativeTime(item.updatedAt, props.now, tr)}</span>
          {item.hasDraft ? <span className="dboard-row-draft">{tr('decisionBoard.draftMark')}</span> : null}
        </span>
      </a>
    </li>
  );
}

function BoardSummaryView(props: { route: BoardRoute }) {
  const tr = useT();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [appId, setAppId] = useState<string | undefined>(props.route.appId);
  const [view, setView] = useState<BoardView>(props.route.view ?? 'decide');
  const [query, setQuery] = useState(props.route.q ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(props.route.q ?? '');
  const [list, setList] = useState<BoardListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [submitSeqs, setSubmitSeqs] = useState<number[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const loadSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void fetchBoards().then(next => {
      if (cancelled) return;
      setBoards(next);
      setBoardsError(null);
    }).catch(err => {
      if (!cancelled) setBoardsError(errorText(err));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const board = boards ? pickBoard(boards, appId) : undefined;
  const activeAppId = board?.larkAppId;
  const boardOnline = board?.online !== false;

  useEffect(() => {
    if (!activeAppId || !boardOnline) return;
    const seq = ++loadSeqRef.current;
    setListLoading(true);
    void fetchBoardItems(activeAppId, view, debouncedQuery).then(res => {
      if (seq !== loadSeqRef.current) return;
      setList(res);
      setListError(null);
      setNow(Date.now());
    }).catch(err => {
      if (seq !== loadSeqRef.current) return;
      setListError(errorText(err));
    }).finally(() => {
      if (seq === loadSeqRef.current) setListLoading(false);
    });
  }, [activeAppId, boardOnline, view, debouncedQuery, reloadTick]);

  // 视图 / 搜索 / 看板记进地址（replaceState 不触发重挂载），从详情页返回时原样恢复。
  useEffect(() => {
    if (!boards) return;
    const hash = boardSummaryHash({ appId: activeAppId, view, q: debouncedQuery });
    lastSummaryHash = hash;
    if (location.hash !== hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  }, [boards, activeAppId, view, debouncedQuery]);

  const draftCount = list?.drafts.length ?? 0;
  const counts = list?.counts;
  const heading = (
    <div className="page-heading dboard-heading">
      <div className="dboard-heading-main">
        <h1>{tr('decisionBoard.title')}</h1>
        {boards && boards.length > 1 && activeAppId ? (
          <DropdownMenu
            id="dboard-board-switch"
            className="dboard-board-switch"
            ariaLabel={tr('decisionBoard.switchBoard')}
            label={`${tr('decisionBoard.stewardLabel')} ${board?.botName ?? activeAppId}`}
            value={activeAppId}
            options={boards.map(b => ({ value: b.larkAppId, label: b.botName, hint: b.counts ? tr('decisionBoard.tabDecideCount', { n: b.counts.decide }) : undefined }))}
            onChange={next => { setAppId(next); setList(null); }}
          />
        ) : board ? <span className="dboard-heading-bot">{tr('decisionBoard.stewardLabel')} {board.botName}</span> : null}
      </div>
      {board ? (
        <div className="page-heading-actions">
          <button
            type="button"
            className="primary dboard-submit-btn"
            disabled={draftCount === 0}
            onClick={() => list && setSubmitSeqs(list.drafts.map(d => d.seq))}
          >
            {draftCount > 0 ? tr('decisionBoard.submitN', { n: draftCount }) : tr('decisionBoard.submitNone')}
          </button>
        </div>
      ) : null}
    </div>
  );

  if (boardsError) {
    return <section className="page dboard-page">{heading}<p className="hint-warn">{tr('decisionBoard.loadFailed', { error: boardsError })}</p></section>;
  }
  if (!boards) {
    return <section className="page dboard-page">{heading}<LoadingState label={tr('common.loading')} /></section>;
  }
  if (!board || !activeAppId) {
    return (
      <section className="page dboard-page">
        {heading}
        <div className="dboard-empty-state">
          <h2>{tr('decisionBoard.emptyBoardsTitle')}</h2>
          <p>{tr('decisionBoard.emptyBoardsBody')}</p>
          <a className="btn-link primary" href="#/bot-defaults">{tr('decisionBoard.emptyBoardsAction')}</a>
        </div>
      </section>
    );
  }

  const items = list?.items ?? [];
  return (
    <section className="page dboard-page" data-board={activeAppId}>
      {heading}
      {!boardOnline ? <p className="dboard-banner tone-warn">{tr('decisionBoard.botOffline')}</p> : null}
      {boardOnline && list && !list.steward.ready ? (
        <p className="dboard-banner tone-warn">
          {tr('decisionBoard.stewardNotReady')}{' '}
          <a className="dboard-inline-link" href={stewardConfigHref(activeAppId)}>{tr('decisionBoard.openBotConfig')}</a>
        </p>
      ) : null}
      {boardOnline ? (
        <>
          <div className="dboard-toolbar">
            <div className="dboard-tabs" role="tablist" aria-label={tr('decisionBoard.title')}>
              {BOARD_VIEW_ORDER.map(key => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={view === key}
                  className={view === key ? 'active' : undefined}
                  onClick={() => setView(key)}
                >
                  {tr(BOARD_VIEW_LABEL_KEYS[key])}
                  {counts ? <span className="dboard-tab-count">{counts[key]}</span> : null}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="dboard-search"
              value={query}
              placeholder={tr('decisionBoard.searchPlaceholder')}
              aria-label={tr('decisionBoard.searchPlaceholder')}
              onChange={event => setQuery(event.currentTarget.value)}
            />
          </div>
          {listError ? (
            <p className="hint-warn">
              {tr('decisionBoard.loadFailed', { error: listError })}{' '}
              <button type="button" className="dboard-text-btn" onClick={() => setReloadTick(n => n + 1)}>{tr('decisionBoard.retry')}</button>
            </p>
          ) : null}
          {!list && listLoading ? <LoadingState label={tr('common.loading')} /> : null}
          {list ? (
            items.length ? (
              <ul className={`dboard-list${listLoading ? ' is-loading' : ''}`}>
                {items.map(item => <BoardRow key={item.seq} appId={activeAppId} item={item} now={now} />)}
              </ul>
            ) : (
              <p className="dboard-empty-line">
                {debouncedQuery
                  ? tr('decisionBoard.emptySearch', { q: debouncedQuery })
                  : tr(BOARD_EMPTY_VIEW_KEYS[view])}
              </p>
            )
          ) : null}
          {list && items.length ? <p className="dboard-legend">{tr('decisionBoard.legend')}</p> : null}
          {list ? <BatchList appId={activeAppId} batches={list.batches} now={now} onChanged={() => setReloadTick(n => n + 1)} /> : null}
        </>
      ) : null}
      {submitSeqs ? (
        <SubmitDialog
          appId={activeAppId}
          seqs={submitSeqs}
          onClose={changed => {
            setSubmitSeqs(null);
            if (changed) setReloadTick(n => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

// ─── 详情页：草稿自动保存 ───────────────────────────────────────────────────

interface DraftEditor {
  draft: DraftInput;
  saved: BoardDraft | null;
  state: DraftSaveState;
  error: string;
  update(patch: Partial<DraftInput> | ((current: DraftInput) => DraftInput)): void;
  /** 立刻把未保存的改动存掉，返回服务端当前的草稿（空草稿 = null）。失败抛错。 */
  flush(): Promise<BoardDraft | null>;
  /** 用服务端的草稿重置编辑器（首次打开、提交之后）。 */
  reset(server: BoardDraft | null): void;
  /** 有改动还没被服务端确认。 */
  dirty(): boolean;
}

function useDraftEditor(appId: string, seq: number, itemRev: number, optionKeys: readonly string[]): DraftEditor {
  const [draft, setDraft] = useState<DraftInput>(EMPTY_DRAFT);
  const [saved, setSaved] = useState<BoardDraft | null>(null);
  const [state, setState] = useState<DraftSaveState>('idle');
  const [error, setError] = useState('');
  const latestRef = useRef<DraftInput>(EMPTY_DRAFT);
  /** 服务端手里的那份内容（最后一次保存成功时发出去的）。 */
  const ackRef = useRef<DraftInput>(EMPTY_DRAFT);
  const savedRef = useRef<BoardDraft | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const inflightRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const revRef = useRef(itemRev);
  revRef.current = itemRev;
  const optionKeysRef = useRef(optionKeys);
  optionKeysRef.current = optionKeys;
  const flushRef = useRef<() => Promise<BoardDraft | null>>(async () => null);

  const settledState = (): DraftSaveState => (savedRef.current ? 'saved' : 'idle');
  // 管家改掉了选项、草稿里的选择已不存在：只发文字和图片，不让整份草稿存不进去。
  const payloadFor = (content: DraftInput): DraftInput => (content.choice && !optionKeysRef.current.includes(content.choice)
    ? { ...content, choice: undefined }
    : content);
  const stateRef = useRef<DraftSaveState>('idle');
  stateRef.current = state;

  const schedule = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void flushRef.current().catch(() => {}); }, AUTOSAVE_MS);
  }, []);

  const flush = useCallback(async (): Promise<BoardDraft | null> => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    // 等上一笔保存落地，再决定这一笔要不要发；上一笔失败就由这一笔重试。
    while (inflightRef.current) {
      try { await inflightRef.current; } catch { /* 下面重试 */ }
    }
    const snapshot = latestRef.current;
    if (sameDraftContent(snapshot, ackRef.current)) {
      if (mountedRef.current) setState(settledState());
      return savedRef.current;
    }
    if (mountedRef.current) setState('saving');
    const request: Promise<void> = saveBoardDraft(appId, seq, payloadFor(snapshot), revRef.current).then(next => {
      ackRef.current = snapshot;
      savedRef.current = next;
      if (!mountedRef.current) return;
      setSaved(next);
      setError('');
      if (sameDraftContent(latestRef.current, snapshot)) {
        setState(settledState());
      } else {
        setState('pending');
        schedule();
      }
    }, err => {
      if (mountedRef.current) {
        setState('error');
        setError(errorText(err));
      }
      throw err;
    }).finally(() => {
      if (inflightRef.current === request) inflightRef.current = null;
    });
    inflightRef.current = request;
    await request;
    return savedRef.current;
  }, [appId, seq, schedule]);
  flushRef.current = flush;

  const update = useCallback((patch: Partial<DraftInput> | ((current: DraftInput) => DraftInput)) => {
    const next = typeof patch === 'function' ? patch(latestRef.current) : { ...latestRef.current, ...patch };
    latestRef.current = next;
    setDraft(next);
    if (sameDraftContent(next, ackRef.current)) {
      window.clearTimeout(timerRef.current);
      setState(settledState());
      return;
    }
    setState('pending');
    schedule();
  }, [schedule]);

  const reset = useCallback((server: BoardDraft | null) => {
    window.clearTimeout(timerRef.current);
    const content = draftFromServer(server);
    latestRef.current = content;
    ackRef.current = content;
    savedRef.current = server;
    setDraft(content);
    setSaved(server);
    setState(server ? 'saved' : 'idle');
    setError('');
  }, []);

  const dirty = useCallback(() => !sameDraftContent(latestRef.current, ackRef.current), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timerRef.current);
      // 离开详情页（站内跳转）时把最后的改动存掉：等进行中的那笔落地后再补一笔。
      const pending = inflightRef.current ?? Promise.resolve();
      void pending.catch(() => {}).then(() => {
        if (!sameDraftContent(latestRef.current, ackRef.current)) {
          void saveBoardDraft(appId, seq, payloadFor(latestRef.current), revRef.current, { keepalive: true }).catch(() => {});
        }
      });
    };
  }, [appId, seq]);

  useEffect(() => {
    // 关页面 / 刷新：页面马上就没了，用 keepalive 直接把最后的改动发出去；上一笔已经存失败时
    // 这一笔多半也会失败，请浏览器拦一下。
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (sameDraftContent(latestRef.current, ackRef.current)) return;
      void saveBoardDraft(appId, seq, payloadFor(latestRef.current), revRef.current, { keepalive: true }).catch(() => {});
      if (stateRef.current !== 'error') return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [appId, seq]);

  return { draft, saved, state, error, update, flush, reset, dirty };
}

function SaveStatus(props: { editor: DraftEditor }) {
  const tr = useT();
  const { state, error } = props.editor;
  if (state === 'idle') return <span className="dboard-save-status" />;
  if (state === 'error') {
    return (
      <span className="dboard-save-status tone-error" role="status">
        {tr('decisionBoard.saveFailed', { error })}{' '}
        <button type="button" className="dboard-text-btn" onClick={() => void props.editor.flush().catch(() => {})}>{tr('decisionBoard.saveRetry')}</button>
      </span>
    );
  }
  const key = state === 'saving' ? 'decisionBoard.saveSaving' : state === 'pending' ? 'decisionBoard.savePending' : 'decisionBoard.saveSaved';
  return <span className={`dboard-save-status${state === 'saved' ? ' tone-ok' : ''}`} role="status" aria-live="polite">{tr(key)}</span>;
}

// ─── 详情页 ─────────────────────────────────────────────────────────────────

function EventRow(props: { appId: string; event: BoardEvent }) {
  const tr = useT();
  const { event } = props;
  return (
    <li className={`dboard-event dboard-event-${event.actor}`}>
      <div className="dboard-event-head">
        <time dateTime={new Date(event.at).toISOString()}>{boardClock(event.at)}</time>
        <b>{tr(BOARD_ACTOR_LABEL_KEYS[event.actor] ?? BOARD_ACTOR_LABEL_KEYS.system)}</b>
        <span className="dboard-event-kind">
          {tr(BOARD_EVENT_KIND_KEYS[event.kind] ?? BOARD_EVENT_KIND_KEYS.note)}
          {event.batchId ? ` · ${tr('decisionBoard.batchTitle', { id: event.batchId })}` : ''}
        </span>
      </div>
      {event.text ? <div className="dboard-event-text">{event.text}</div> : null}
      {event.fileIds.length ? (
        <div className="dboard-thumbs">
          {event.fileIds.map(id => (
            <a key={id} className="dboard-thumb" href={boardFileUrl(props.appId, id)} target="_blank" rel="noopener noreferrer" title={tr('decisionBoard.openImage')}>
              <img src={boardFileUrl(props.appId, id)} alt="" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function OptionList(props: { item: BoardItem; choice?: string; onChoose(choice: string | undefined): void }) {
  const tr = useT();
  const { item } = props;
  if (!item.options.length) return null;
  return (
    <div className="dboard-options" role="radiogroup" aria-label={tr('decisionBoard.askTitle')}>
      {item.options.map(option => {
        const checked = props.choice === option.key;
        return (
          <label key={option.key} className={`dboard-option${checked ? ' is-checked' : ''}`}>
            <input
              type="radio"
              name={`dboard-choice-${item.seq}`}
              value={option.key}
              checked={checked}
              onChange={() => props.onChoose(option.key)}
              // 单选也要能「不选」（只写说明或提问）：再点一次已选中的项就取消。
              onClick={() => { if (checked) props.onChoose(undefined); }}
            />
            <span className="dboard-option-body">
              <span className="dboard-option-head">
                <b className="dboard-option-key">{option.key}</b>
                {item.recommend === option.key ? <span className="dboard-badge">{tr('decisionBoard.recommended')}</span> : null}
                <span className="dboard-option-label">{option.label}</span>
              </span>
              {option.effect ? <span className="dboard-option-effect">→ {option.effect}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function ItemDetailView(props: { appId: string; seq: number }) {
  const tr = useT();
  const { appId, seq } = props;
  const [detail, setDetail] = useState<BoardDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; notFound: boolean } | null>(null);
  const [submitSeqs, setSubmitSeqs] = useState<number[] | null>(null);
  const [uploads, setUploads] = useState<Array<{ key: string; preview: string }>>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const optionKeys = useMemo(() => detail?.item.options.map(o => o.key) ?? [], [detail?.item.options]);
  const editor = useDraftEditor(appId, seq, detail?.item.rev ?? 0, optionKeys);
  const uploadingRef = useRef(0);
  uploadingRef.current = uploads.length;
  const editorStateRef = useRef(editor.state);
  editorStateRef.current = editor.state;

  const load = useCallback(async (opts: { resetDraft: boolean }): Promise<boolean> => {
    try {
      const next = await fetchBoardItem(appId, seq);
      if (!mountedRef.current) return false;
      setDetail(next);
      setLoadError(null);
      if (opts.resetDraft) editor.reset(next.draft ?? null);
      return true;
    } catch (err) {
      if (mountedRef.current) {
        setLoadError({ text: errorText(err), notFound: err instanceof BoardRequestError && err.code === 'item_not_found' });
      }
      return false;
    }
  }, [appId, seq, editor.reset]);

  useEffect(() => {
    mountedRef.current = true;
    void load({ resetDraft: true }).then(ok => {
      // 打开详情 = 看过了：汇总页那一行的 ● 熄掉。
      if (ok) void markBoardItemSeen(appId, seq).catch(() => {});
    });
    return () => { mountedRef.current = false; };
  }, [appId, seq]);

  // 草稿没存进去或图片还在传：离开前问一句（其余情况离开时会自动补存）。
  useEffect(() => setLeaveGuard(() => (editorStateRef.current === 'error' || uploadingRef.current > 0)
    ? { title: tr('decisionBoard.leaveTitle'), message: tr('decisionBoard.leaveBody'), confirmLabel: tr('decisionBoard.leaveConfirm') }
    : null), [tr]);

  async function addImages(files: File[]): Promise<void> {
    if (!files.length) return;
    const check = checkBoardImages(files, editor.draft.fileIds.length + uploadingRef.current);
    if (!check.ok) {
      const message = check.reason === 'type' ? tr('decisionBoard.imageType')
        : check.reason === 'size' ? tr('decisionBoard.imageSize')
          : tr('decisionBoard.imageCount', { n: BOARD_FILES_PER_DRAFT });
      toast(message, { kind: 'warning' });
      return;
    }
    await Promise.all(files.map(async (file, index) => {
      const key = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
      let dataUrl: string;
      try {
        dataUrl = await imageFileDataUrl(file);
      } catch {
        toast(tr('decisionBoard.imageReadFailed'), { kind: 'error' });
        return;
      }
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        toast(tr('decisionBoard.imageReadFailed'), { kind: 'error' });
        return;
      }
      if (mountedRef.current) setUploads(current => [...current, { key, preview: dataUrl }]);
      try {
        const uploaded = await uploadBoardImage(appId, {
          name: file.name || `image-${index + 1}.${file.type.split('/')[1] ?? 'png'}`,
          mimeType: file.type.toLowerCase(),
          dataBase64: dataUrl.slice(comma + 1),
        });
        editor.update(current => current.fileIds.includes(uploaded.id) ? current : { ...current, fileIds: [...current.fileIds, uploaded.id] });
      } catch (err) {
        toast(tr('decisionBoard.imageUploadFailed', { error: errorText(err) }), { kind: 'error' });
      } finally {
        if (mountedRef.current) setUploads(current => current.filter(u => u.key !== key));
      }
    }));
  }

  function imagesFrom(list: FileList | null | undefined): File[] {
    return [...(list ?? [])].filter(file => file.type.startsWith('image/'));
  }

  function onPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const files = imagesFrom(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }

  function hasFiles(event: ReactDragEvent): boolean {
    return [...event.dataTransfer.types].includes('Files');
  }

  async function clearDraft(): Promise<void> {
    const ok = await confirm({
      title: tr('decisionBoard.clearDraftConfirmTitle'),
      message: tr('decisionBoard.clearDraftConfirmBody'),
      confirmLabel: tr('decisionBoard.clearDraft'),
      danger: true,
    });
    if (!ok) return;
    editor.update({ choice: undefined, text: '', fileIds: [] });
    await editor.flush().catch(() => {});
  }

  async function openSubmit(): Promise<void> {
    if (!detail) return;
    let own: BoardDraft | null;
    try {
      own = await editor.flush();
    } catch (err) {
      toast(tr('decisionBoard.saveFailed', { error: errorText(err) }), { kind: 'error' });
      return;
    }
    const others = [...new Set(detail.drafts.filter(d => d.seq !== seq).map(d => d.seq))];
    const seqs = own ? [seq, ...others] : others;
    if (seqs.length) setSubmitSeqs(seqs);
  }

  const backHref = parseBoardHash(lastSummaryHash)?.appId === appId ? lastSummaryHash : boardSummaryHash({ appId });
  const back = <a className="dboard-back" href={backHref}>← {tr('decisionBoard.title')}</a>;

  if (loadError && !detail) {
    return (
      <section className="page dboard-page dboard-detail">
        {back}
        <p className="hint-warn">{loadError.notFound ? tr('decisionBoard.notFound') : tr('decisionBoard.loadFailed', { error: loadError.text })}</p>
      </section>
    );
  }
  if (!detail) {
    return <section className="page dboard-page dboard-detail">{back}<LoadingState label={tr('common.loading')} /></section>;
  }

  const { item } = detail;
  const now = Date.now();
  const hasAsk = !!item.question?.trim() || item.options.length > 0;
  const ownDraft = !!editor.saved || !isDraftEmpty(editor.draft);
  const scope = submitScope(detail.drafts, seq, ownDraft);
  const stale = draftNeedsReview(editor.saved, item);
  const missingChoice = editor.draft.choice && !optionKeys.includes(editor.draft.choice) ? editor.draft.choice : null;
  const submitLabel = scope.own && scope.others > 0 ? tr('decisionBoard.submitThisAndOthers', { n: scope.others })
    : scope.own ? tr('decisionBoard.submitThis')
      : scope.others > 0 ? tr('decisionBoard.submitOthers', { n: scope.others })
        : tr('decisionBoard.submitNone');
  const recommendReason = item.recommend
    ? (item.recommendReason?.trim()
      ? tr('decisionBoard.recommendReason', { key: item.recommend, reason: item.recommendReason.trim() })
      : tr('decisionBoard.recommendOnly', { key: item.recommend }))
    : '';
  const meta = [item.repo, item.kind, tr('decisionBoard.updated', { time: boardRelativeTime(item.updatedAt, now, tr) })].filter(Boolean).join(' · ');

  return (
    <section className="page dboard-page dboard-detail" data-seq={seq}>
      {back}
      <header className="dboard-detail-head">
        <h1><span className="dboard-seq">#{item.seq}</span> {item.title}</h1>
        <StateChip state={item.state} stage={item.stage} />
      </header>
      <p className="dboard-detail-meta">{meta}</p>
      <LinkChips links={detail.links} />
      {item.summary?.trim() ? (
        <p className="dboard-summary"><span className="dboard-summary-label">{tr('decisionBoard.summaryLabel')}</span>{item.summary}</p>
      ) : null}
      {loadError ? <p className="hint-warn">{tr('decisionBoard.loadFailed', { error: loadError.text })}</p> : null}

      {item.progress?.trim() ? (
        <section className="dboard-block">
          <h2 className="dboard-block-title">
            {tr('decisionBoard.progressTitle')}
            <small>{tr('decisionBoard.progressBy', { time: boardClock(item.stewardEventAt ?? item.updatedAt) })}</small>
          </h2>
          <Markdown text={item.progress} />
        </section>
      ) : null}

      {hasAsk ? (
        <section className="dboard-block dboard-ask">
          <h2 className="dboard-block-title">{tr('decisionBoard.askTitle')}</h2>
          {item.question?.trim() ? <Markdown text={item.question} className="dboard-question" /> : null}
          <OptionList item={item} choice={editor.draft.choice} onChoose={choice => editor.update({ choice })} />
          {recommendReason ? <p className="dboard-recommend">{recommendReason}</p> : null}
        </section>
      ) : null}

      {detail.pendingDecisions.length ? (
        <section className="dboard-pending">
          <strong>{tr('decisionBoard.pendingTitle')}</strong>
          <ul>
            {detail.pendingDecisions.map(d => (
              <li key={`${d.batchId}:${d.seq}`}>
                {d.choice ? tr('decisionBoard.pendingChoice', { id: d.batchId, choice: d.choice }) : tr('decisionBoard.pendingNoChoice', { id: d.batchId })}
                {d.text.trim() ? `：${textPreview(d.text, 100)}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="dboard-block dboard-decision">
        <h2 className="dboard-block-title">
          {tr('decisionBoard.decisionTitle')}
          <small>{tr('decisionBoard.decisionHint')}</small>
        </h2>
        <div
          className={`dboard-editor${dragging ? ' is-dragging' : ''}`}
          onDragOver={event => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={event => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={event => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            setDragging(false);
            void addImages(imagesFrom(event.dataTransfer.files));
          }}
        >
          <textarea
            value={editor.draft.text}
            rows={4}
            maxLength={20_000}
            placeholder={tr('decisionBoard.decisionPlaceholder')}
            aria-label={tr('decisionBoard.decisionTitle')}
            onChange={event => editor.update({ text: event.currentTarget.value })}
            onPaste={onPaste}
          />
          <div className="dboard-thumbs dboard-editor-thumbs">
            {editor.draft.fileIds.map(id => (
              <span key={id} className="dboard-thumb">
                <a href={boardFileUrl(appId, id)} target="_blank" rel="noopener noreferrer" title={tr('decisionBoard.openImage')}>
                  <img src={boardFileUrl(appId, id)} alt="" />
                </a>
                <button
                  type="button"
                  className="dboard-thumb-remove"
                  aria-label={tr('decisionBoard.removeImage')}
                  title={tr('decisionBoard.removeImage')}
                  onClick={() => editor.update(current => ({ ...current, fileIds: current.fileIds.filter(f => f !== id) }))}
                >
                  ×
                </button>
              </span>
            ))}
            {uploads.map(upload => (
              <span key={upload.key} className="dboard-thumb is-uploading" title={tr('decisionBoard.uploading')}>
                <img src={upload.preview} alt="" />
                <span className="dboard-thumb-progress">{tr('decisionBoard.uploading')}</span>
              </span>
            ))}
            <button type="button" className="dboard-add-image" onClick={() => fileInputRef.current?.click()}>
              {tr('decisionBoard.addImages')}
            </button>
            <span className="dboard-drop-hint">{tr('decisionBoard.dropHint')}</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            accept={BOARD_IMAGE_TYPES.join(',')}
            onChange={event => {
              const files = imagesFrom(event.currentTarget.files);
              event.currentTarget.value = '';
              void addImages(files);
            }}
          />
        </div>
        {missingChoice ? <p className="dboard-warn">{tr('decisionBoard.choiceGone', { key: missingChoice })}</p> : null}
        {stale ? <p className="dboard-warn">⚠ {tr('decisionBoard.staleDraft')}</p> : null}
        <div className="dboard-decision-foot">
          <SaveStatus editor={editor} />
          <div className="dboard-decision-actions">
            <button type="button" disabled={!ownDraft} onClick={() => void clearDraft()}>{tr('decisionBoard.clearDraft')}</button>
            <button
              type="button"
              className="primary"
              disabled={scope.total === 0 || uploads.length > 0}
              onClick={() => void openSubmit()}
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </section>

      <section className="dboard-block dboard-history">
        <h2 className="dboard-block-title">{tr('decisionBoard.historyTitle')}</h2>
        {detail.events.length ? (
          <ol className="dboard-events">
            {detail.events.map(event => <EventRow key={event.id} appId={appId} event={event} />)}
          </ol>
        ) : <p className="dboard-empty-line">{tr('decisionBoard.historyEmpty')}</p>}
      </section>

      {submitSeqs ? (
        <SubmitDialog
          appId={appId}
          seqs={submitSeqs}
          firstSeq={seq}
          onClose={changed => {
            setSubmitSeqs(null);
            // 提交后这些草稿已变成决定：重新读一遍，编辑器跟着清空（本项若没提交则原样回来）。
            if (changed) void load({ resetDraft: !editor.dirty() });
          }}
        />
      ) : null}
    </section>
  );
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

function DecisionBoardPage() {
  // 每次 hashchange 壳层都会重挂载页面，所以挂载时读一次地址就够了。
  const route = useMemo<BoardRoute>(() => parseBoardHash(location.hash || '#/board') ?? {}, []);
  if (route.appId && route.seq !== undefined) return <ItemDetailView appId={route.appId} seq={route.seq} />;
  return <BoardSummaryView route={route} />;
}

export function renderDecisionBoardPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <DecisionBoardPage />);
}
