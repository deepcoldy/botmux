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
  closeBoardItemInChat,
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
  BOARD_NAV_STORAGE_KEY,
  boardNeighbors,
  navListFrom,
  parseNavList,
  viewForItemState,
  type BoardNavList,
  type BoardNeighbors,
  BOARD_ACTOR_LABEL_KEYS,
  BOARD_EMPTY_VIEW_KEYS,
  BOARD_EVENT_KIND_KEYS,
  BOARD_EXPLAINER_SANDBOX,
  boardExplainers,
  eventFileKind,
  formatBoardBytes,
  BOARD_FILES_PER_DRAFT,
  BOARD_HINT_LABEL_KEYS,
  BOARD_IMAGE_TYPES,
  BOARD_VIEW_LABEL_KEYS,
  BOARD_VIEW_ORDER,
  OVERVIEW_GROUP_KEYS,
  buildBoardOverview,
  childProgressText,
  nestBoardList,
  overviewGroupCounts,
  pageViewCount,
  readyToWrapUp,
  serverView,
  trackingView,
  EMPTY_DRAFT,
  batchView,
  boardClock,
  boardItemHash,
  boardRelativeTime,
  boardSummaryHash,
  chatTaskLine,
  chatTaskSummaryText,
  checkBoardImages,
  draftFromServer,
  draftNeedsReview,
  isBoardItemEnded,
  isDraftEmpty,
  itemChatView,
  knownHint,
  knownTaskHint,
  newSubmitNonce,
  nonChatLinks,
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
  TASK_HINT_LABEL_KEYS,
  type ChatTaskState,
  type ItemTaskFields,
  type TaskHint,
  type BoardBatch,
  type BoardDetailResponse,
  type BoardDraft,
  type BoardEvent,
  type BoardExplainer,
  type BoardFile,
  type BoardHint,
  type BoardItem,
  type BoardListResponse,
  type BoardRoute,
  type BoardState,
  type BoardSummary,
  type BoardItemSummary,
  type BoardPageView,
  type ChildStats,
  type DraftInput,
  type DraftSaveState,
  type ItemChatView,
  type RenderedLink,
  type SubmitCandidate,
  type Translate,
} from './decision-board-model.js';

const AUTOSAVE_MS = 800;
const SEARCH_DEBOUNCE_MS = 300;

/** 汇总页最后一次的地址（含看板、视图、搜索词）：详情页的「返回」回到这里。 */
let lastSummaryHash = '#/board';

/**
 * owner 最近一次在汇总页看到的列表（看板、视图、搜索、顺序）。详情页的上一项 / 下一项只在
 * 这份列表里走。也存一份到 sessionStorage：飞书侧栏里刷新页面后还能接着切。
 */
let lastNavList: BoardNavList | null = null;

function rememberNavList(list: BoardNavList): void {
  lastNavList = list;
  try { window.sessionStorage?.setItem(BOARD_NAV_STORAGE_KEY, JSON.stringify(list)); } catch { /* 存不了就只留在内存里 */ }
}

/** 测试隔离用：清掉内存里记下的列表（sessionStorage 由测试自己的桩管理）。 */
export function resetBoardNavMemory(): void {
  lastNavList = null;
}

function recallNavList(): BoardNavList | null {
  if (lastNavList) return lastNavList;
  try {
    const raw = window.sessionStorage?.getItem(BOARD_NAV_STORAGE_KEY);
    return raw ? parseNavList(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

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
  const text = stateChipText(props.state, props.stage, tr);
  return <span className={`dboard-state dboard-state-${props.state}`} title={text}>{text}</span>;
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

/**
 * 进群：直接是群 applink 的链接，交给飞书客户端接管（与 Dashboard 其它「打开聊天」同一做法；
 * 用脚本打开会让侧栏里的页面跳走，而不是切到那个群）。
 */
function JoinChatLink(props: { link: RenderedLink; className: string; children: ReactNode }) {
  const tr = useT();
  if (!props.link.url) return null;
  return (
    <a className={props.className} href={props.link.url} target="_blank" rel="noopener noreferrer"
      title={tr('decisionBoard.joinChatTitle', { name: props.link.text })} data-chat={props.link.ref}>
      {props.children}
    </a>
  );
}

function UnverifiedTag() {
  const tr = useT();
  return <span className="dboard-chat-tag is-warn" title={tr('decisionBoard.chatUnverifiedTitle')}>{tr('decisionBoard.chatUnverified')}</span>;
}

/** 汇总行里的巡检提示：标签 + 原因（触屏上没有悬停，原因直接写出来）。 */
function HintChip(props: { hint: BoardHint | undefined }) {
  const tr = useT();
  const hint = knownHint(props.hint);
  if (!hint) return null;
  return (
    <span className="dboard-hint-row" data-hint={hint.kind}>
      <span className={`dboard-hint-chip is-${hint.kind}`}>💡 {tr(BOARD_HINT_LABEL_KEYS[hint.kind])}</span>
      <span className="dboard-hint-reason">{hint.reason}</span>
    </span>
  );
}

/** 详情页标题下的一行：「建议关闭：PR … 已合入（巡检发现，状态没改…）」。 */
function HintBanner(props: { hint: BoardHint | undefined }) {
  const tr = useT();
  const hint = knownHint(props.hint);
  if (!hint) return null;
  return (
    <p className={`dboard-hint-banner is-${hint.kind}`} data-hint={hint.kind} role="note">
      💡 {tr('decisionBoard.hintDetail', { label: tr(BOARD_HINT_LABEL_KEYS[hint.kind]), reason: hint.reason })}
    </p>
  );
}

/** 子任务提示：关联群里有管家还没处理的新结果（只是提示，状态没改）。 */
function TaskHintChip(props: { hint: TaskHint | undefined; banner?: boolean }) {
  const tr = useT();
  const hint = knownTaskHint(props.hint);
  if (!hint) return null;
  const label = tr(TASK_HINT_LABEL_KEYS[hint.kind]);
  if (props.banner) {
    return <p className={`dboard-hint-banner is-${hint.kind}`} data-task-hint={hint.kind} role="note">🔔 {tr('decisionBoard.taskHintDetail', { label })}</p>;
  }
  return (
    <span className="dboard-hint-row" data-task-hint={hint.kind}>
      <span className={`dboard-hint-chip is-${hint.kind}`}>🔔 {label}</span>
    </span>
  );
}

/** 汇总行里的关联群状态：单群写状态、时间和一句话；多群写汇总。 */
function RowTaskLine(props: { item: ItemTaskFields; now: number }) {
  const tr = useT();
  const chats = props.item.taskChats;
  if (!chats?.length) return null;
  if (chats.length > 1) {
    return <span className="dboard-row-task" data-fresh={props.item.taskFresh ? 'true' : undefined}>{chatTaskSummaryText(chats, tr)}</span>;
  }
  const line = chatTaskLine(chats[0]!, props.now, tr);
  if (!line) return null;
  return (
    <span className="dboard-row-task" data-task={chats[0]!.kind} data-fresh={props.item.taskFresh ? 'true' : undefined}>
      <span className="dboard-task-label">{line.label}</span>
      {line.time ? <span className="dboard-task-time">{line.time}</span> : null}
      {line.text ? <span className="dboard-task-text">{line.text}</span> : null}
    </span>
  );
}

/** 详情页：每个关联群的子任务状态（状态、时间、一句话）；进群链接在上面的群列表里。 */
function TaskChatsPanel(props: { chats: ChatTaskState[] | undefined; links: RenderedLink[]; now: number }) {
  const tr = useT();
  if (!props.chats?.length) return null;
  return (
    <section className="dboard-tasks" aria-label={tr('decisionBoard.taskTitle')}>
      <span className="dboard-chats-label">{tr('decisionBoard.taskTitle')}</span>
      <ul className="dboard-tasks-list">
        {props.chats.map(state => {
          const line = chatTaskLine(state, props.now, tr);
          const link = props.links.find(l => l.kind === 'chat' && l.ref === state.chatId);
          return (
            <li key={state.chatId} className="dboard-task" data-task={state.kind}>
              <span className="dboard-task-chat">{link?.text ?? state.chatId}</span>
              {line ? <span className="dboard-task-label">{line.label}</span> : null}
              {line?.time ? <span className="dboard-task-time">{line.time}</span> : null}
              {line?.text ? <span className="dboard-task-text">{line.text}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 汇总行标题下的一行：主群名（+N 个群）/ 无群：原因 / ⚠ 缺群。 */
function RowChatLine(props: { view: ItemChatView }) {
  const tr = useT();
  const { view } = props;
  if (view.primary) {
    return (
      <span className="dboard-row-chat">
        <span className="dboard-row-chat-name">💬 {view.primary.text}</span>
        {view.primary.chatCheck === 'unverified' ? <UnverifiedTag /> : null}
        {view.chats.length > 1 ? <span className="dboard-row-chat-more">{tr('decisionBoard.moreChats', { n: view.chats.length - 1 })}</span> : null}
      </span>
    );
  }
  if (view.noChatReason) return <span className="dboard-row-chat is-none">{tr('decisionBoard.noChat', { reason: view.noChatReason })}</span>;
  return <span className="dboard-row-chat is-missing">⚠ {tr('decisionBoard.chatMissing')}</span>;
}

/** 详情页标题下方：这一项的全部群，主群在前；没有群时写原因或标缺群。 */
function ChatPanel(props: { seq: number; view: ItemChatView }) {
  const tr = useT();
  const { view } = props;
  if (!view.primary) {
    return view.noChatReason
      ? <p className="dboard-chats is-none">{tr('decisionBoard.noChat', { reason: view.noChatReason })}</p>
      : (
        <div className="dboard-chats is-missing" role="note">
          <span>⚠ {tr('decisionBoard.chatMissingAdd')}</span>
          <code>{`botmux board set ${props.seq} --link chat=oc_…`}</code>
          <span>{tr('decisionBoard.chatMissingReason')}</span>
          <code>{`botmux board set ${props.seq} --no-chat "…"`}</code>
        </div>
      );
  }
  return (
    <section className="dboard-chats" aria-label={tr('decisionBoard.chatsTitle')}>
      <span className="dboard-chats-label">{tr('decisionBoard.chatsTitle')}</span>
      <div className="dboard-chats-list">
        {view.chats.map(link => {
          const primary = link === view.primary;
          const body = (
            <>
              <span className="dboard-chat-name">{link.text}</span>
              {primary ? <span className="dboard-chat-tag">{tr('decisionBoard.primaryChat')}</span> : null}
              {link.chatCheck === 'unverified' ? <UnverifiedTag /> : null}
              <span className="dboard-chat-go">{tr('decisionBoard.joinChat')} ↗</span>
            </>
          );
          return link.url
            ? <JoinChatLink key={link.ref} link={link} className={`dboard-chat${primary ? ' is-primary' : ''}`}>{body}</JoinChatLink>
            : <span key={link.ref} className={`dboard-chat${primary ? ' is-primary' : ''}`}>{body}</span>;
        })}
      </div>
    </section>
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

  // 没有能提交的项时标题和按钮都不带数字（不出现「提交 0 项」）。
  const title = phase === 'done' && result
    ? tr('decisionBoard.batchTitle', { id: result.batch.id })
    : items.length ? tr('decisionBoard.submitDialogTitle', { n: items.length }) : tr('decisionBoard.submitNone');

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
              // 已结束的项不进确认框（submitCandidateFromDetail 已排除），草稿收在那一项的历史里。
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
                {phase === 'submitting' ? tr('decisionBoard.submitting')
                  : items.length ? tr('decisionBoard.confirmSubmit', { n: items.length }) : tr('decisionBoard.confirmSubmitNone')}
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

/** 待拍板 / 待验收的事项 owner 可以直接关闭（不生成决定）。 */
function closableInChat(state: BoardState): boolean {
  return state === 'decide' || state === 'accept';
}

function CloseInChatButton(props: {
  appId: string; item: Pick<BoardItem, 'seq' | 'rev' | 'state'>; disabled?: boolean;
  beforeClose?(): Promise<unknown>; onChanged(): void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  if (!closableInChat(props.item.state)) return null;
  async function closeOnly(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      // Settle autosave before clearing this item's draft; never submit it.
      await props.beforeClose?.();
      await closeBoardItemInChat(props.appId, props.item.seq, props.item.rev);
      setOpen(false);
      props.onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return <>
    <button type="button" className="dboard-text-btn" disabled={props.disabled || busy}
      data-action="close-in-chat" onClick={() => setOpen(true)}>{tr('decisionBoard.closeInChat')}</button>
    <ModalDialog open={open} className="confirm-modal-dialog" aria-label={tr('decisionBoard.closeInChatTitle')}
      backdropClose={!busy} onRequestClose={() => { if (!busy) setOpen(false); }}>
      <div className="confirm-modal-card">
        <h3 className="confirm-modal-title">{tr('decisionBoard.closeInChatTitle')}</h3>
        <p className="confirm-modal-message">{tr('decisionBoard.closeInChatBody')}</p>
        {error ? <p className="confirm-modal-message dboard-error-line" role="alert">{error}</p> : null}
        <div className="confirm-modal-footer">
          <button type="button" className="btn-cancel" disabled={busy} onClick={() => setOpen(false)}>{tr('decisionBoard.cancel')}</button>
          <button type="button" className="btn-danger" disabled={busy} data-action="confirm-close-in-chat" onClick={() => void closeOnly()}>{tr('decisionBoard.closeInChatConfirm')}</button>
        </div>
      </div>
    </ModalDialog>
  </>;
}

/** 树里第几层：给 CSS 算缩进（手机侧栏里超过 4 层不再加缩进）。 */
function depthStyle(depth: number): Record<string, number> | undefined {
  return depth ? { '--dboard-depth': depth } : undefined;
}

/** 子任务完成情况「子任务 3/5」+ 都结束了时的「可以收尾」。 */
function ChildProgress(props: { state: BoardState; stats: ChildStats | undefined }) {
  const tr = useT();
  if (!props.stats?.total) return null;
  const progress = childProgressText(props.stats, tr);
  const ready = readyToWrapUp({ state: props.state, childStats: props.stats });
  return (
    <>
      <span className={`dboard-child-progress${ready ? ' is-ready' : ''}`} title={progress.title} data-children={`${props.stats.done + props.stats.closed}/${props.stats.total}`}>
        {progress.text}
      </span>
      {ready ? <span className="dboard-ready" data-ready="">✓ {tr('decisionBoard.readyToWrapUp')}</span> : null}
    </>
  );
}

/** 汇总行标题下：上级不在这一页时写「属于 #12 …」；有子任务时写完成情况。 */
function RowTreeLine(props: { item: BoardItemSummary; showParent: boolean }) {
  const tr = useT();
  const { item } = props;
  const parent = props.showParent ? item.parent : undefined;
  if (!parent && !item.childStats?.total) return null;
  return (
    <span className="dboard-row-tree">
      {parent ? <span className="dboard-row-parent" data-parent={parent.seq}>↑ {tr('decisionBoard.parentOf', { seq: parent.seq, title: parent.title })}</span> : null}
      <ChildProgress state={item.state} stats={item.childStats} />
    </span>
  );
}

function BoardRow(props: { appId: string; item: BoardListResponse['items'][number]; now: number; depth?: number; onChanged(): void }) {
  const tr = useT();
  const { item } = props;
  const depth = props.depth ?? 0;
  const asking = item.state === 'decide' || item.state === 'accept';
  const question = asking && item.question ? questionOneLine(item.question) : '';
  const chat = itemChatView(item, item.links);
  // 「进群」与整行的详情链接是兄弟元素：链接里不能再套链接。
  return (
    <li className="dboard-row-item" data-depth={depth || undefined} style={depthStyle(depth)}>
      <a className={`dboard-row${item.unseen ? ' is-unseen' : ''}`} href={boardItemHash(props.appId, item.seq)} data-seq={item.seq}>
        <span className="dboard-row-dot" aria-label={item.unseen ? tr('decisionBoard.unseenMark') : undefined}>{item.unseen ? '●' : ''}</span>
        <span className="dboard-row-main">
          <span className="dboard-row-title">
            {depth ? <span className="dboard-tree-mark" aria-hidden="true">└</span> : null}
            <span className="dboard-seq">#{item.seq}</span>
            <strong>{item.title}</strong>
          </span>
          <RowTreeLine item={item} showParent={depth === 0} />
          {item.state === 'closed' ? <span className="dboard-row-ask">{tr('decisionBoard.closeInChatDone')}</span> : null}
          {asking && (question || item.recommend) ? (
            <span className="dboard-row-ask">
              {question ? <>{tr('decisionBoard.askShort')}{question}</> : null}
              {question && item.recommend ? ' ｜ ' : null}
              {item.recommend ? tr('decisionBoard.recommendShort', { key: item.recommend }) : null}
            </span>
          ) : null}
          {item.pendingDecisions > 0 ? <span className="dboard-row-pending">{tr('decisionBoard.pendingShort')}</span> : null}
          <HintChip hint={item.hint} />
          <TaskHintChip hint={item.taskHint} />
          <RowChatLine view={chat} />
          <RowTaskLine item={item} now={props.now} />
        </span>
        <span className="dboard-row-meta">
          <StateChip state={item.state} stage={item.stage} />
          {item.repo ? <span className="dboard-row-repo">{item.repo}</span> : null}
          <span className="dboard-row-time">{boardRelativeTime(item.updatedAt, props.now, tr)}</span>
          {item.hasDraft ? <span className="dboard-row-draft">{tr('decisionBoard.draftMark')}</span> : null}
          {item.explainers ? <span className="dboard-row-explainer">📎 {tr('decisionBoard.explainerTitle')}</span> : null}
        </span>
      </a>
      <span className="dboard-row-join">
        <CloseInChatButton appId={props.appId} item={item} onChanged={props.onChanged} />
        {chat.primary ? <JoinChatLink link={chat.primary} className="dboard-join-btn">{tr('decisionBoard.joinChat')}</JoinChatLink> : null}
      </span>
    </li>
  );
}

/** 跟进情况一行：在等谁、最近进展（很久没动时标出来）、复查时间。总览行和详情页共用。 */
function TrackingChips(props: { item: Parameters<typeof trackingView>[0]; now: number }) {
  const tr = useT();
  const track = trackingView(props.item, props.now, tr);
  return (
    <>
      {track.waiting ? <span className={`dboard-track-wait is-${track.waiting.tone}`} data-waiting={track.waiting.tone}>{track.waiting.text}</span> : null}
      <span className={`dboard-track-time${track.activity.stale ? ' is-stale' : ''}`} data-stale={track.activity.stale ? '' : undefined}>
        {track.activity.stale ? '⏳ ' : ''}{track.activity.text}
      </span>
      {track.check ? (
        <span className={`dboard-track-check${track.check.due ? ' is-due' : ''}`} data-check={track.check.due ? 'due' : 'later'}>
          {track.check.due ? '⏰ ' : '💤 '}{track.check.text}
        </span>
      ) : null}
    </>
  );
}

function OverviewRowItem(props: { appId: string; row: ReturnType<typeof buildBoardOverview<BoardItemSummary>>[number]['rows'][number]; now: number }) {
  const { item, depth, group } = props.row;
  return (
    <li className={`dboard-ov-row${group ? '' : ' is-context'}`} data-seq={item.seq} data-group={group ?? 'context'}
      data-depth={depth || undefined} style={depthStyle(depth)}>
      <a className="dboard-ov-link" href={boardItemHash(props.appId, item.seq)}>
        <span className="dboard-ov-title">
          {depth ? <span className="dboard-tree-mark" aria-hidden="true">└</span> : null}
          <span className="dboard-seq">#{item.seq}</span>
          <strong>{item.title}</strong>
          {item.unseen ? <span className="dboard-row-dot" aria-hidden="true">●</span> : null}
        </span>
        {/* 顶格却有上级：搜索把上级筛掉了，写明属于谁。 */}
        {!depth && item.parent ? <RowTreeLine item={{ ...item, childStats: undefined }} showParent /> : null}
        <span className="dboard-ov-meta">
          <StateChip state={item.state} stage={item.stage} />
          <TrackingChips item={item} now={props.now} />
          <ChildProgress state={item.state} stats={item.childStats} />
        </span>
      </a>
    </li>
  );
}

/**
 * 总览：所有没结束的事项一屏看完，按「最该看的在最上面」分组（规则见 overview.ts）。每项写状态和阶段、在等谁、
 * 最近一次进展、下次复查；一棵任务树整体放在它里面最该看的那一项所在的组。
 */
function BoardOverview(props: { appId: string; items: readonly BoardItemSummary[]; sections: ReturnType<typeof buildBoardOverview<BoardItemSummary>>; now: number }) {
  const tr = useT();
  // 顶上这一排按每一项自己的组数：一棵树被排进「要你拍板」时，树里过了复查时间的子任务照样算进「过了复查时间」。
  const counts = overviewGroupCounts(props.items, props.now);
  return (
    <div className="dboard-overview">
      <p className="dboard-ov-summary">
        {[...counts].map(([group, n]) => (
          <span key={group} className={`dboard-ov-chip is-${group}`} data-group={group}>
            {tr(OVERVIEW_GROUP_KEYS[group].label)} <b>{n}</b>
          </span>
        ))}
      </p>
      {props.sections.map(section => (
        <section key={section.group} className="dboard-ov-section" data-group={section.group}>
          <h2 className="dboard-ov-head">
            <span className="dboard-ov-head-label">{tr(OVERVIEW_GROUP_KEYS[section.group].label)}</span>
            <span className="dboard-tab-count">{section.count}</span>
            <small>{tr(OVERVIEW_GROUP_KEYS[section.group].hint)}</small>
          </h2>
          <ul className="dboard-list dboard-ov-list">
            {section.rows.map(row => <OverviewRowItem key={row.item.seq} appId={props.appId} row={row} now={props.now} />)}
          </ul>
        </section>
      ))}
      <p className="dboard-legend">{tr('decisionBoard.ovTreeNote')}</p>
    </div>
  );
}

export function BoardSummaryView(props: { route: BoardRoute }) {
  const tr = useT();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [appId, setAppId] = useState<string | undefined>(props.route.appId);
  const [view, setView] = useState<BoardPageView>(props.route.view ?? 'decide');
  const [query, setQuery] = useState(props.route.q ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(props.route.q ?? '');
  const [list, setList] = useState<BoardListResponse | null>(null);
  /** list 是按哪个视图取的：切视图时新数据回来之前照旧显示旧列表（半透明），但不拿它排总览。 */
  const [listView, setListView] = useState<BoardPageView | null>(null);
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
    void fetchBoardItems(activeAppId, serverView(view), debouncedQuery).then(res => {
      if (seq !== loadSeqRef.current) return;
      setList(res);
      setListView(view);
      // 详情页的上一项 / 下一项按这里显示的顺序走：总览按分组和树，其余按树。
      const now = Date.now();
      const shown = view === 'overview'
        ? buildBoardOverview(res.items, now).flatMap(section => section.rows.map(r => r.item))
        : nestBoardList(res.items).map(r => r.item);
      rememberNavList(navListFrom(activeAppId, view, debouncedQuery, shown));
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
            onChange={next => { setAppId(next); setList(null); setListView(null); }}
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
  // 总览只列没结束的项（已结束的上级当层级显示），只用按总览取回来的数据排。
  const overview = view === 'overview' && list && listView === 'overview' ? buildBoardOverview(items, now) : null;
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
                  {counts ? <span className="dboard-tab-count">{pageViewCount(counts, key)}</span> : null}
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
            overview ? (
              overview.length
                ? <BoardOverview appId={activeAppId} items={items} sections={overview} now={now} />
                : <p className="dboard-empty-line">{debouncedQuery ? tr('decisionBoard.emptySearch', { q: debouncedQuery }) : tr(BOARD_EMPTY_VIEW_KEYS[view])}</p>
            ) : items.length ? (
              <ul className={`dboard-list${listLoading ? ' is-loading' : ''}`}>
                {nestBoardList(items).map(({ item, depth }) => (
                  <BoardRow key={item.seq} appId={activeAppId} item={item} now={now} depth={depth} onChanged={() => setReloadTick(n => n + 1)} />
                ))}
              </ul>
            ) : (
              <p className="dboard-empty-line">
                {debouncedQuery
                  ? tr('decisionBoard.emptySearch', { q: debouncedQuery })
                  : tr(BOARD_EMPTY_VIEW_KEYS[view])}
              </p>
            )
          ) : null}
          {list && items.length && !overview ? <p className="dboard-legend">{tr('decisionBoard.legend')}</p> : null}
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
  /**
   * 刚写的内容因为这一项被管家改过（或已结束）没有存成草稿，已确认的部分收进历史。请求期间新增的内容还在补收时，
   * 页面据 dirty 状态改提示，避免把尚未确认的部分也说成已归档；owner 再动编辑器时提示消失。
   */
  archived: boolean;
  /**
   * 被拒、清空之后正在重新读这一项：这期间页面上还是旧的问题和选项，编辑区只读、提交按钮置灰，免得 owner 照着旧选项
   * 点了、读回来又被按新的一轮存下。
   */
  reloading: boolean;
  update(patch: Partial<DraftInput> | ((current: DraftInput) => DraftInput)): void;
  /** 立刻把未保存的改动存掉，返回服务端当前的草稿（空草稿 = null）。失败抛错。 */
  flush(): Promise<BoardDraft | null>;
  /** 用服务端的草稿重置编辑器（首次打开、提交之后）。 */
  reset(server: BoardDraft | null): void;
  /** 有改动还没被服务端确认。 */
  dirty(): boolean;
  /** 编辑器被清空的次数：上传开始时记下，传完时对不上就不往清空后的编辑器里塞图。 */
  generation(): number;
}

/**
 * 草稿编辑器：停顿后自动保存，离开页面时补存。`askKey` 是页面上这一项现在的这一轮拍板（详情接口的
 * draftAskKey），随每次保存带上。
 *
 * 管家在 owner 写草稿时改了状态或选项（或把这一项结束了），服务端拒绝这次保存（draft_outdated / item_ended），
 * 同时把这次发过去的内容收进这一项的历史。已确认的内容从编辑器清掉，不把写给旧问题的内容稍后又按新的一轮存掉；
 * `onOutdated` 重新读这一项。请求在路上时 owner 又打的几个字按旧的一轮补收，确认前保留，失败显示错误并可重试，不丢。
 */
function useDraftEditor(appId: string, seq: number, itemRev: number, optionKeys: readonly string[],
  askKey: string | undefined, onOutdated: () => Promise<unknown>): DraftEditor {
  const [draft, setDraft] = useState<DraftInput>(EMPTY_DRAFT);
  const [saved, setSaved] = useState<BoardDraft | null>(null);
  const [state, setState] = useState<DraftSaveState>('idle');
  const [error, setError] = useState('');
  const [archived, setArchived] = useState(false);
  const [reloading, setReloading] = useState(false);
  const latestRef = useRef<DraftInput>(EMPTY_DRAFT);
  /** 服务端手里的那份内容（最后一次保存成功时发出去的）。 */
  const ackRef = useRef<DraftInput>(EMPTY_DRAFT);
  const savedRef = useRef<BoardDraft | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const inflightRef = useRef<Promise<void> | null>(null);
  /** 第一笔已归档后，仍在补收请求期间新增内容的那一笔；失败保留内容，可用 flush 重试。 */
  const archivalRef = useRef<Promise<void> | null>(null);
  const archivedRetryRef = useRef<(() => Promise<void>) | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  /** 被拒、清空之后到重新读完这一项之前：不自动保存（那时页面上还是旧的一轮，存了还会被拒）。 */
  const reloadingRef = useRef(false);
  const revRef = useRef(itemRev);
  revRef.current = itemRev;
  const optionKeysRef = useRef(optionKeys);
  optionKeysRef.current = optionKeys;
  const askKeyRef = useRef(askKey);
  askKeyRef.current = askKey;
  const onOutdatedRef = useRef(onOutdated);
  onOutdatedRef.current = onOutdated;
  const saveOpts = (extra: { keepalive?: boolean } = {}) => ({ ...extra, ...(askKeyRef.current !== undefined ? { askKey: askKeyRef.current } : {}) });
  const flushRef = useRef<() => Promise<BoardDraft | null>>(async () => null);

  const settledState = (): DraftSaveState => (savedRef.current ? 'saved' : 'idle');
  // 管家改掉了选项、草稿里的选择已不存在（或这一项不在待拍板、没有可选的）：只发文字和图片，不让整份草稿存不进去。
  const payloadFor = (content: DraftInput): DraftInput => (content.choice && !optionKeysRef.current.includes(content.choice)
    ? { ...content, choice: undefined }
    : content);
  const stateRef = useRef<DraftSaveState>('idle');
  stateRef.current = state;

  const schedule = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void flushRef.current().catch(() => {}); }, AUTOSAVE_MS);
  }, []);

  const reloadArchived = () => {
    void onOutdatedRef.current().catch(() => {}).finally(() => {
      reloadingRef.current = false;
      if (mountedRef.current) setReloading(false);
      // 重新读这一项期间 owner 接着写了：按现在的一轮补存。
      if (mountedRef.current && !sameDraftContent(latestRef.current, ackRef.current)) schedule();
    });
  };

  /** 第一笔已确认归档；请求期间新增的内容必须等服务端确认后才能清，失败则留下并按同一轮重试。 */
  const archiveResidual = (residual: DraftInput, opts: { askKey?: string }): Promise<void> => {
    if (archivalRef.current) return archivalRef.current;
    const request = (async () => {
      if (mountedRef.current) { setState('saving'); setError(''); }
      try {
        try {
          await saveBoardDraft(appId, seq, payloadFor(residual), revRef.current, opts);
        } catch (err) {
          // 迟到保存的 409 是「已收进历史」的确认，不是失败；其它响应都不能当作已归档。
          if (!(err instanceof BoardRequestError && err.code === 'draft_outdated')) throw err;
        }
      } catch (err) {
        if (mountedRef.current) { setState('error'); setError(errorText(err)); }
        throw err;
      }
      archivedRetryRef.current = null;
      latestRef.current = EMPTY_DRAFT;
      ackRef.current = EMPTY_DRAFT;
      savedRef.current = null;
      if (!mountedRef.current) return;
      setDraft(EMPTY_DRAFT);
      setSaved(null);
      setState('idle');
      reloadArchived();
    })().finally(() => {
      if (archivalRef.current === request) archivalRef.current = null;
    });
    archivalRef.current = request;
    return request;
  };

  /** 已归档的 sent 可以清；在途新增部分继续保留到补收确认，失败时显示错误并允许 flush 重试。 */
  const discardArchived = (sent: DraftInput, opts: { askKey?: string }) => {
    window.clearTimeout(timerRef.current);
    generationRef.current += 1;
    const residual = sameDraftContent(latestRef.current, sent) ? null : latestRef.current;
    latestRef.current = residual ?? EMPTY_DRAFT;
    ackRef.current = EMPTY_DRAFT;
    savedRef.current = null;
    if (mountedRef.current) {
      setDraft(residual ?? EMPTY_DRAFT);
      setSaved(null);
      setState(residual ? 'saving' : 'idle');
      setError('');
      setArchived(true);
      reloadingRef.current = true;
      setReloading(true);
    }
    if (residual) {
      archivedRetryRef.current = () => archiveResidual(residual, opts);
      void archiveResidual(residual, opts).catch(() => {});
      return;
    }
    if (mountedRef.current) reloadArchived();
  };

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
    if (reloadingRef.current) {
      // 迟到补收失败：重试仍用拒绝那一轮的 askKey，不按页面上的新一轮存。
      const retry = archivedRetryRef.current;
      if (retry) await retry();
      return savedRef.current;
    }
    if (mountedRef.current) setState('saving');
    const opts = saveOpts();
    const request: Promise<void> = saveBoardDraft(appId, seq, payloadFor(snapshot), revRef.current, opts).then(next => {
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
      // 只有新 daemon 会回 draft_outdated，它回之前已经把这份内容收进了历史，清空输入框才不丢东西；旧 daemon 回的
      // item_ended 没有收，照旧报错、内容留在输入框里。
      if (err instanceof BoardRequestError && err.code === 'draft_outdated') {
        discardArchived(snapshot, opts);
      } else if (mountedRef.current) {
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
    setArchived(false);
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
  const generation = useCallback(() => generationRef.current, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timerRef.current);
      // 离开详情页（站内跳转）时把最后的改动存掉：等进行中的那笔落地后再补一笔。这一项刚被改过时服务端会拒、
      // 并把内容收进历史，所以也不会丢。
      const pending = archivalRef.current ?? inflightRef.current ?? Promise.resolve();
      void pending.catch(() => {}).then(() => {
        if (!sameDraftContent(latestRef.current, ackRef.current)) {
          void saveBoardDraft(appId, seq, payloadFor(latestRef.current), revRef.current, saveOpts({ keepalive: true })).catch(() => {});
        }
      });
    };
  }, [appId, seq]);

  useEffect(() => {
    // 关页面 / 刷新：页面马上就没了，用 keepalive 直接把最后的改动发出去；上一笔已经存失败时
    // 这一笔多半也会失败，请浏览器拦一下。
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (sameDraftContent(latestRef.current, ackRef.current)) return;
      void saveBoardDraft(appId, seq, payloadFor(latestRef.current), revRef.current, saveOpts({ keepalive: true })).catch(() => {});
      if (stateRef.current !== 'error') return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [appId, seq]);

  return { draft, saved, state, error, archived, reloading, update, flush, reset, dirty, generation };
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

function EventRow(props: { appId: string; event: BoardEvent; files: ReadonlyMap<string, BoardFile> }) {
  const tr = useT();
  const { event } = props;
  const images = event.fileIds.filter(id => eventFileKind(id, props.files) === 'image');
  const explainers = event.fileIds.filter(id => eventFileKind(id, props.files) !== 'image');
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
      {images.length ? (
        <div className="dboard-thumbs">
          {images.map(id => (
            <a key={id} className="dboard-thumb" href={boardFileUrl(props.appId, id)} target="_blank" rel="noopener noreferrer" title={tr('decisionBoard.openImage')}>
              <img src={boardFileUrl(props.appId, id)} alt="" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {explainers.length ? (
        <div className="dboard-event-files">
          {explainers.map(id => (
            <a key={id} className="dboard-link" href={boardFileUrl(props.appId, id)} target="_blank" rel="noopener noreferrer">
              {eventFileKind(id, props.files) === 'video' ? '🎬' : '📄'} {props.files.get(id)?.name}
            </a>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function ExplainerVideo(props: { url: string; name: string }) {
  const tr = useT();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <video className="dboard-explainer-video" src={props.url} controls preload="metadata" playsInline aria-label={props.name}
        onError={() => setFailed(true)} />
      {failed ? <p className="dboard-warn">{tr('decisionBoard.explainerVideoFailed')}</p> : null}
    </>
  );
}

function ExplainerDialog(props: { appId: string; explainer: BoardExplainer | null; onClose(): void }) {
  const tr = useT();
  const { explainer } = props;
  return (
    <ModalDialog open={!!explainer} className="dboard-explainer-dialog" aria-label={explainer?.name} onRequestClose={props.onClose}>
      {explainer ? (
        <>
          <div className="dboard-explainer-bar">
            <strong>{explainer.name}</strong>
            <a href={boardFileUrl(props.appId, explainer.id)} target="_blank" rel="noopener noreferrer">{tr('decisionBoard.explainerNewTab')}</a>
            <button type="button" onClick={props.onClose}>{tr('decisionBoard.close')}</button>
          </div>
          <iframe className="dboard-explainer-dialog-frame" src={boardFileUrl(props.appId, explainer.id)} sandbox={BOARD_EXPLAINER_SANDBOX}
            referrerPolicy="no-referrer" title={explainer.name} />
        </>
      ) : null}
    </ModalDialog>
  );
}

/**
 * 管家附的说明页和视频。说明页嵌在 sandbox iframe 里（完全限制，响应头另有 CSP sandbox），视频用页内播放器；
 * 飞书侧栏里新标签页不一定带得上登录态，所以页内就能看完。
 */
function ExplainerPanel(props: { appId: string; files: readonly BoardFile[] }) {
  const tr = useT();
  const [fullscreen, setFullscreen] = useState<BoardExplainer | null>(null);
  const explainers = boardExplainers(props.files);
  if (!explainers.length) return null;
  return (
    <section className="dboard-block dboard-explainers">
      <h2 className="dboard-block-title">
        {tr('decisionBoard.explainerTitle')}
        <small>{tr('decisionBoard.explainerHint')}</small>
      </h2>
      {explainers.map(x => {
        const url = boardFileUrl(props.appId, x.id);
        return (
          <figure key={x.id} className={`dboard-explainer is-${x.kind}`} data-file-id={x.id}>
            <figcaption className="dboard-explainer-head">
              <span className="dboard-explainer-name">{x.kind === 'video' ? '🎬' : '📄'} {x.name}</span>
              <span className="dboard-explainer-size">{formatBoardBytes(x.bytes)}</span>
              <span className="dboard-explainer-actions">
                {x.kind === 'html' ? (
                  <button type="button" className="dboard-text-btn" onClick={() => setFullscreen(x)}>{tr('decisionBoard.explainerFullscreen')}</button>
                ) : null}
                <a href={url} target="_blank" rel="noopener noreferrer">{tr('decisionBoard.explainerNewTab')}</a>
              </span>
            </figcaption>
            {x.kind === 'html' ? (
              <iframe className="dboard-explainer-frame" src={url} sandbox={BOARD_EXPLAINER_SANDBOX} referrerPolicy="no-referrer"
                loading="lazy" title={x.name} />
            ) : <ExplainerVideo url={url} name={x.name} />}
          </figure>
        );
      })}
      <ExplainerDialog appId={props.appId} explainer={fullscreen} onClose={() => setFullscreen(null)} />
    </section>
  );
}

function OptionList(props: { item: BoardItem; choice?: string; disabled?: boolean; onChoose(choice: string | undefined): void }) {
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
              disabled={props.disabled}
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

/** 详情页的上一项 / 下一项。到头的那个按钮置灰，按钮上直接写「已是第一项 / 已是最后一项」。 */
function ItemNav(props: { neighbors: BoardNeighbors | null; busy: boolean; onGo(target: number | undefined): void; placement: 'top' | 'bottom' }) {
  const tr = useT();
  if (!props.neighbors) return null;
  const { prev, next, position, total, view } = props.neighbors;
  return (
    <nav className={`dboard-item-nav dboard-item-nav-${props.placement}`} aria-label={tr('decisionBoard.navLabel')}>
      <button type="button" data-nav="prev" disabled={prev === undefined || props.busy} onClick={() => props.onGo(prev)}>
        {prev === undefined ? tr('decisionBoard.navFirst') : `‹ ${tr('decisionBoard.navPrev')}`}
      </button>
      <span className="dboard-item-nav-pos">
        {tr('decisionBoard.navPosition', { n: position, total, view: tr(BOARD_VIEW_LABEL_KEYS[view]) })}
      </span>
      <button type="button" data-nav="next" disabled={next === undefined || props.busy} onClick={() => props.onGo(next)}>
        {next === undefined ? tr('decisionBoard.navLast') : `${tr('decisionBoard.navNext')} ›`}
      </button>
    </nav>
  );
}

interface PendingImageUpload {
  key: string;
  preview: string;
  /** 上传完成、但迟到归档尚未确认时保留这些字段供失败重试。 */
  fileId?: string;
  askKey?: string;
  baseRev?: number;
  error?: string;
}

export function ItemDetailView(props: { appId: string; seq: number }) {
  const tr = useT();
  const { appId, seq } = props;
  const [detail, setDetail] = useState<BoardDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; notFound: boolean } | null>(null);
  const [submitSeqs, setSubmitSeqs] = useState<number[] | null>(null);
  const [uploads, setUploads] = useState<PendingImageUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  // 只有待拍板 / 待验收时能选选项：进行中、等待中的事项上留着的旧选项不再是要定的事（服务端也拒）。
  const deciding = detail?.item.state === 'decide' || detail?.item.state === 'accept';
  const optionKeys = useMemo(() => (deciding ? detail?.item.options.map(o => o.key) ?? [] : []), [deciding, detail?.item.options]);
  // 迟到的保存被拒、内容已收进历史：重新读这一项（失败时隔一会儿再读一次）。
  const reloadAfterArchiveRef = useRef<() => Promise<boolean>>(async () => false);
  const editor = useDraftEditor(appId, seq, detail?.item.rev ?? 0, optionKeys, detail?.draftAskKey, () => reloadAfterArchiveRef.current());
  const uploadingRef = useRef(0);
  uploadingRef.current = uploads.length;
  const editorStateRef = useRef(editor.state);
  editorStateRef.current = editor.state;
  // 迟到补收还没确认时也守离开：编辑器只读期间 dirty 表示这笔内容尚未归档/存下。
  const editorNeedsGuardRef = useRef(false);
  editorNeedsGuardRef.current = editor.reloading && editor.dirty();
  const [navList, setNavList] = useState<BoardNavList | null>(() => recallNavList());
  const [navigating, setNavigating] = useState(false);
  const neighbors = boardNeighbors(navList, appId, seq);

  /** resetDraft：'if-clean' = 读回来时编辑器里没有没存的改动才用服务端的草稿（别的标签页刚存的那份）。 */
  const load = useCallback(async (opts: { resetDraft: boolean | 'if-clean' }): Promise<boolean> => {
    try {
      const next = await fetchBoardItem(appId, seq);
      if (!mountedRef.current) return false;
      setDetail(next);
      setLoadError(null);
      if (opts.resetDraft === true || (opts.resetDraft === 'if-clean' && !editor.dirty())) editor.reset(next.draft ?? null);
      return true;
    } catch (err) {
      if (mountedRef.current) {
        setLoadError({ text: errorText(err), notFound: err instanceof BoardRequestError && err.code === 'item_not_found' });
      }
      return false;
    }
  }, [appId, seq, editor.reset, editor.dirty]);
  reloadAfterArchiveRef.current = async () => {
    if (await load({ resetDraft: 'if-clean' })) return true;
    await new Promise(resolve => window.setTimeout(resolve, 1500));
    return mountedRef.current ? load({ resetDraft: 'if-clean' }) : false;
  };

  useEffect(() => {
    mountedRef.current = true;
    void load({ resetDraft: true }).then(ok => {
      // 打开详情 = 看过了：汇总页那一行的 ● 熄掉。
      if (ok) void markBoardItemSeen(appId, seq).catch(() => {});
    });
    return () => { mountedRef.current = false; };
  }, [appId, seq]);

  // 没经过列表（飞书链接直接打开），或记下的列表里没有这一项：按这一项所在的视图取一份当切换范围。
  const loadedSeq = detail?.item.seq;
  const loadedState = detail?.item.state;
  useEffect(() => {
    if (loadedSeq === undefined || !loadedState || boardNeighbors(navList, appId, seq)) return;
    const view = viewForItemState(loadedState);
    let cancelled = false;
    void fetchBoardItems(appId, view).then(res => {
      if (cancelled || !mountedRef.current) return;
      const list = navListFrom(appId, view, undefined, res.items);
      rememberNavList(list);
      setNavList(list);
    }).catch(() => { /* 拿不到就不显示上一项 / 下一项，不影响拍板 */ });
    return () => { cancelled = true; };
  }, [appId, seq, loadedSeq]);

  /** 切到同一列表里的另一项：先把这一项的草稿存掉；存不进去时由离开确认问一句，不悄悄丢。 */
  async function goTo(target: number | undefined): Promise<void> {
    if (target === undefined || navigating) return;
    setNavigating(true);
    try {
      await editor.flush();
    } catch {
      // 保存失败：草稿状态是 error，下面的跳转会被离开确认拦下来问一句。
    }
    if (mountedRef.current) setNavigating(false);
    location.hash = boardItemHash(appId, target);
  }

  // 草稿没存进去、迟到补收未确认或图片还在传/归档：离开前问一句（其余情况离开时会自动补存）。
  useEffect(() => setLeaveGuard(() => (editorStateRef.current === 'error' || editorNeedsGuardRef.current || uploadingRef.current > 0)
    ? { title: tr('decisionBoard.leaveTitle'), message: tr('decisionBoard.leaveBody'), confirmLabel: tr('decisionBoard.leaveConfirm') }
    : null), [tr]);
  useEffect(() => {
    // hash 离开由 setLeaveGuard 守；刷新 / 关标签页也要覆盖上传中或迟到归档失败的图片。
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (uploadingRef.current === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** 迟到的图只收进历史；请求带 keepalive，成功才撤掉预览，失败保留文件 id / 旧 askKey 供原图重试。 */
  async function archiveLateImage(key: string, fileId: string, askKey: string, baseRev: number): Promise<void> {
    if (mountedRef.current) {
      setUploads(current => current.map(u => u.key === key ? { ...u, fileId, askKey, baseRev, error: undefined } : u));
    }
    try {
      await saveBoardDraft(appId, seq, { text: '', fileIds: [fileId] }, baseRev, { askKey, archive: true, keepalive: true });
    } catch (err) {
      if (mountedRef.current) {
        const message = errorText(err);
        setUploads(current => current.map(u => u.key === key ? { ...u, fileId, askKey, baseRev, error: message } : u));
      }
      return;
    }
    if (mountedRef.current) setUploads(current => current.filter(u => u.key !== key));
  }

  async function addImages(files: File[]): Promise<void> {
    if (!files.length || editor.reloading) return;
    const check = checkBoardImages(files, editor.draft.fileIds.length + uploadingRef.current);
    if (!check.ok) {
      const message = check.reason === 'type' ? tr('decisionBoard.imageType')
        : check.reason === 'size' ? tr('decisionBoard.imageSize')
          : tr('decisionBoard.imageCount', { n: BOARD_FILES_PER_DRAFT });
      toast(message, { kind: 'warning' });
      return;
    }
    // 传图途中这一项被管家改过、编辑器已清空（刚写的已收进历史）：传完的图不再塞进清空后的编辑器，
    // 按开始传时的那一轮只收进历史（不存成草稿），不悄悄丢掉。
    const generation = editor.generation();
    const askKeyAtStart = detail?.draftAskKey;
    const revAtStart = detail?.item.rev ?? 0;
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
      let retainForArchive = false;
      try {
        const uploaded = await uploadBoardImage(appId, {
          name: file.name || `image-${index + 1}.${file.type.split('/')[1] ?? 'png'}`,
          mimeType: file.type.toLowerCase(),
          dataBase64: dataUrl.slice(comma + 1),
        });
        if (editor.generation() !== generation) {
          if (askKeyAtStart !== undefined) {
            retainForArchive = true;
            await archiveLateImage(key, uploaded.id, askKeyAtStart, revAtStart);
          }
          return;
        }
        editor.update(current => current.fileIds.includes(uploaded.id) ? current : { ...current, fileIds: [...current.fileIds, uploaded.id] });
      } catch (err) {
        toast(tr('decisionBoard.imageUploadFailed', { error: errorText(err) }), { kind: 'error' });
      } finally {
        // 迟到归档由 archiveLateImage 自己收尾：失败不能再走这里把预览和重试信息删掉。
        if (!retainForArchive && mountedRef.current) setUploads(current => current.filter(u => u.key !== key));
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
  const ended = isBoardItemEnded(item.state);
  const hasAsk = !ended && (!!item.question?.trim() || (deciding && item.options.length > 0));
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
  const filesById = new Map(detail.files.map(f => [f.id, f] as const));

  return (
    <section className="page dboard-page dboard-detail" data-seq={seq}>
      {back}
      <ItemNav neighbors={neighbors} busy={navigating} onGo={target => void goTo(target)} placement="top" />
      {detail.parent ? (
        <a className="dboard-parent-link" href={boardItemHash(appId, detail.parent.seq)} data-parent={detail.parent.seq}>
          ↑ {tr('decisionBoard.parentOf', { seq: detail.parent.seq, title: detail.parent.title })}
        </a>
      ) : null}
      <header className="dboard-detail-head">
        <h1><span className="dboard-seq">#{item.seq}</span> {item.title}</h1>
        <StateChip state={item.state} stage={item.stage} />
      </header>
      <p className="dboard-detail-meta">{meta}</p>
      <p className="dboard-detail-track">
        <TrackingChips item={{ ...item, lastActivityAt: detail.lastActivityAt, ownActivityAt: detail.ownActivityAt, pendingDecisions: detail.pendingDecisions.length }} now={now} />
      </p>
      {/* 包一层块容器：.page 是 grid，按钮直接做格子会被拉满整行（文字居中、整行都能点到）。 */}
      {closableInChat(item.state) ? (
        <div>
          <CloseInChatButton appId={appId} item={item} disabled={uploads.length > 0}
            beforeClose={() => editor.flush()} onChanged={() => { editor.reset(null); void load({ resetDraft: true }); }} />
        </div>
      ) : null}
      {item.state === 'closed' ? <p className="dboard-detail-meta" role="status">{tr('decisionBoard.closeInChatDone')}</p> : null}
      <HintBanner hint={item.hint} />
      <TaskHintChip hint={detail.taskHint} banner />
      <ChatPanel seq={item.seq} view={itemChatView(item, detail.links)} />
      <TaskChatsPanel chats={detail.taskChats} links={detail.links} now={now} />
      <LinkChips links={nonChatLinks(detail.links)} />
      {item.summary?.trim() ? (
        <p className="dboard-summary"><span className="dboard-summary-label">{tr('decisionBoard.summaryLabel')}</span>{item.summary}</p>
      ) : null}
      <ExplainerPanel appId={appId} files={detail.files} />
      {loadError ? <p className="hint-warn">{tr('decisionBoard.loadFailed', { error: loadError.text })}</p> : null}

      {detail.children?.length ? (
        <section className="dboard-block dboard-children">
          <h2 className="dboard-block-title">
            {detail.childStats ? childProgressText(detail.childStats, tr).text : tr('decisionBoard.childrenTitle')}
            {readyToWrapUp({ state: item.state, childStats: detail.childStats })
              ? <span className="dboard-ready" data-ready="">✓ {tr('decisionBoard.readyToWrapUp')}</span> : null}
          </h2>
          <ul className="dboard-children-list">
            {detail.children.map(child => (
              <li key={child.seq}>
                <a className="dboard-child" href={boardItemHash(appId, child.seq)} data-child={child.seq}>
                  <span className="dboard-seq">#{child.seq}</span>
                  <span className="dboard-child-title">{child.title}</span>
                  <StateChip state={child.state} stage={child.stage} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
          {deciding ? <OptionList item={item} choice={editor.draft.choice} disabled={editor.reloading} onChoose={choice => editor.update({ choice })} /> : null}
          {deciding && recommendReason ? <p className="dboard-recommend">{recommendReason}</p> : null}
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

      {editor.archived ? (
        <p className="dboard-warn" role="status" data-draft-archived="">
          ⚠ {tr(editor.dirty() ? 'decisionBoard.draftArchivePendingNotice' : 'decisionBoard.draftArchivedNotice')}
        </p>
      ) : null}

      {!ended ? <section className="dboard-block dboard-decision">
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
            readOnly={editor.reloading}
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
              <span key={upload.key} className="dboard-thumb is-uploading" title={upload.error ?? tr('decisionBoard.uploading')}>
                <img src={upload.preview} alt="" />
                <span className="dboard-thumb-progress">
                  {upload.error ? tr('decisionBoard.imageArchiveFailed') : tr('decisionBoard.uploading')}
                </span>
              </span>
            ))}
            <button type="button" className="dboard-add-image" disabled={editor.reloading} onClick={() => fileInputRef.current?.click()}>
              {tr('decisionBoard.addImages')}
            </button>
            <span className="dboard-drop-hint">{tr('decisionBoard.dropHint')}</span>
          </div>
          {uploads.filter(upload => upload.error).map(upload => (
            <p className="dboard-warn" role="status" data-upload-error={upload.key} key={`${upload.key}-error`}>
              {tr('decisionBoard.imageArchiveFailed')}：{upload.error}{' '}
              <button type="button" className="dboard-text-btn" data-action="retry-archive" data-upload-key={upload.key}
                onClick={() => void archiveLateImage(upload.key, upload.fileId!, upload.askKey!, upload.baseRev!)}>
                {tr('decisionBoard.saveRetry')}
              </button>
            </p>
          ))}
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
            <button type="button" disabled={!ownDraft || editor.reloading} onClick={() => void clearDraft()}>{tr('decisionBoard.clearDraft')}</button>
            <button
              type="button"
              className="primary"
              disabled={scope.total === 0 || uploads.length > 0 || editor.reloading}
              onClick={() => void openSubmit()}
            >
              {submitLabel}
            </button>
          </div>
        </div>
        <ItemNav neighbors={neighbors} busy={navigating} onGo={target => void goTo(target)} placement="bottom" />
      </section> : null}

      {ended && ownDraft ? (
        // 管家改成已完成 / 已关闭时不清草稿：这份草稿不能再提交，也不能再改，只给看和清空，
        // 否则它会一直算在「提交 N 项」里，且在详情页上清不掉。
        <section className="dboard-block dboard-decision" data-ended-draft="">
          <h2 className="dboard-block-title">{tr('decisionBoard.decisionTitle')}</h2>
          <p className="dboard-warn">{tr('decisionBoard.endedDraft')}</p>
          {editor.draft.choice ? <p>{tr('decisionBoard.choiceLabel', { key: editor.draft.choice })}</p> : null}
          {editor.draft.text.trim() ? <p className="dboard-submit-item-text">{editor.draft.text}</p> : null}
          {editor.draft.fileIds.length ? <p className="dboard-muted">{tr('decisionBoard.imagesN', { n: editor.draft.fileIds.length })}</p> : null}
          <div className="dboard-decision-foot">
            <SaveStatus editor={editor} />
            <div className="dboard-decision-actions">
              <button type="button" data-action="clear-ended-draft" onClick={() => void clearDraft()}>{tr('decisionBoard.clearDraft')}</button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="dboard-block dboard-history">
        <h2 className="dboard-block-title">{tr('decisionBoard.historyTitle')}</h2>
        {detail.events.length ? (
          <ol className="dboard-events">
            {detail.events.map(event => <EventRow key={event.id} appId={appId} event={event} files={filesById} />)}
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
