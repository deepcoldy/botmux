import type { ChildProcess } from 'node:child_process';
import type {
  CodexAppTurnInput,
  CliTurnPayload,
  ChatContext,
  CotEntry,
  Session,
  DaemonToWorker,
  LarkAttachment,
  LarkMention,
  DisplayMode,
  StreamStatus,
  VcMeetingImTurnOrigin,
} from '../types.js';
import type { CliUsageLimitState } from '../utils/cli-usage-limit.js';
import type { CodexServiceTierSnapshot } from '../services/codex-service-tier.js';

/** Frozen card state — cached content for historical streaming cards that can still be toggled. */
export interface FrozenCard {
  messageId: string;      // Lark message_id for PATCHing
  /** Stable visible destination of this card (`plain:oc_*`, `thread:om_*`, or
   *  `quote:om_*`). Chat-scope sessions can move between multiple Lark topics;
   *  cleanup must only withdraw predecessors from the same destination. */
  replyTargetKey?: string;
  content: string;        // frozen text snapshot — kept so "导出文字" still works on historical cards
  title: string;          // turn title at freeze time
  /** Legacy boolean expand/collapse — kept for migrating old persisted cards. */
  expanded?: boolean;
  /** Display mode at freeze time. If absent, derived from `expanded`. */
  displayMode?: DisplayMode;
  /** Latest uploaded image_key for the frozen card (only when displayMode === 'screenshot'). */
  imageKey?: string;
  /** Rendered service-tier badge (`⚡ priority`) captured at freeze time so a
   *  recalled Codex card keeps its per-turn tier instead of being re-decorated
   *  with the session's current tier. Absent = no badge. */
  codexServiceTierBadge?: string;
  /** Whether this historical turn deliberately completed with no reply. The
   *  value belongs to this frozen card, not to the session's latest turn. */
  silentIdle?: boolean;
}

/** Resolve effective display mode for a frozen card.
 *  Legacy persisted values (e.g. `'text'` from pre-v2.4 cards) map to
 *  `'screenshot'` so old cards still render meaningfully. */
export function frozenDisplayMode(fc: FrozenCard): DisplayMode {
  if (fc.displayMode === 'screenshot' || fc.displayMode === 'hidden') return fc.displayMode;
  return fc.expanded ? 'screenshot' : 'hidden';
}

/** Core session state — IM-agnostic.
 *  IM-specific rendering state (ImRenderState) is stored separately
 *  in the ImAdapter implementation (e.g. Map<string, ImRenderState>
 *  inside LarkImAdapter), NOT on this type. */
export interface DaemonSession {
  session: Session;
  worker: ChildProcess | null;   // fork'd worker process
  /** True after the current worker generation has completed init. Kept
   * separate from workerPort because backends without a Web Terminal still
   * emit screen/idle/screenshot updates and support native local attach. */
  workerReady?: boolean;
  workerPort: number | null;     // HTTP port for xterm.js
  workerToken: string | null;    // write token for xterm.js
  /** Independent read-only xterm capability. Optional for hydrated/legacy
   * sessions; live workers publish it with their ready event. */
  workerViewToken?: string | null;
  /** Latest process identity reported over the trusted worker IPC channel.
   * Used to quiesce legacy unconfined CLIs before device credentials exist. */
  localProcessAttestation?: {
    backendType: import('../adapters/backend/types.js').BackendType;
    credentialIsolated: boolean;
    cliPid?: number;
    cliProcStart?: string;
    workerGeneration?: number;
  };
  /** Monotonic within one daemon boot. Captured by durable delivery receipts
   *  so a terminal/exit from a replaced worker cannot settle a newer attempt. */
  workerGeneration?: number;
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';    // p2p chats need reply_in_thread to create topics
  /** Routing scope:
   *   'thread' → routing key = session.rootMessageId, replies use reply_in_thread=true
   *   'chat'   → routing key = chatId, replies are plain chat messages
   *  Must be set explicitly at session creation (no implicit default — every
   *  caller decides based on event context). Restored sessions without a
   *  persisted scope fall back to 'thread' in the restore path. */
  scope: 'thread' | 'chat';
  spawnedAt: number;
  cliVersion: string;
  lastMessageAt: number;
  hasHistory: boolean;   // true after CLI has run at least once for this session
  workingDir?: string;
  initConfig?: Extract<DaemonToWorker, { type: 'init' }>;   // stored for restart
  /**
   * Unprovable launcher-env keys this worker generation was ever HANDED, kept as
   * a monotonically growing set for the life of the generation.
   *
   * `initConfig.env` is only written at spawn/refork, and a live `/restart`
   * updates the worker's own copy without touching it — so neither the spawn-time
   * snapshot nor the current live bot config can answer "what is the running
   * child actually executing?". Three-phase counter-example: start clean → add
   * `LD_PRELOAD` and `/restart` (child now hooked) → clear the config WITHOUT
   * restarting. Both observable layers read clean while the child stays hooked,
   * and the device-isolation proof wrongly returned safe_remote.
   *
   * Monotonic on purpose: a value is only ever removed by starting a brand-new
   * worker generation (spawn/refork clears it). Clearing it when a *clean*
   * restart is merely SENT would reintroduce the same amnesia, because a restart
   * can fail or be coalesced and leave the dangerous child running.
   *
   * Only key NAMES are stored — never values — since the proof inspects names
   * only and these keys can carry credentials.
   */
  mojoAppliedUnprovableEnvKeys?: string[];
  /**
   * Same ledger, inherited from EVERY previous generation of this session.
   *
   * `forkWorker`'s double-fork guard sends `close` + `kill()` and then continues
   * synchronously to spawn the replacement — it never awaits the old worker's
   * exit. And even that exit would not be enough: the dangerous env acts on the
   * mojo CLI *child*, whose `kill()` is a bare SIGTERM with no escalation and no
   * wait, which a trapping/detached child survives (its descendants too). So no
   * observable exit signal proves the injected process is gone.
   *
   * Therefore monotonic for the life of the DaemonSession: parked on every
   * generation boundary, never released. Being in-memory, it disappears only when
   * the session ends or the daemon restarts. Cost: a session ever handed a
   * dangerous launcher env stays unprovable until it ends — an availability
   * trade, not a credential leak.
   */
  mojoRetiringUnprovableEnvKeys?: string[];
  /** Per-session snapshot of the final-answer feedback policy. New config takes
   * effect on the next new/restarted session, matching sandbox send-cred state. */
  feedbackPolicy?: import('../services/feedback-policy.js').FeedbackPolicy;
  /** Explicit per-trigger model override (trigger API `options.model`, codex
   *  family only). Outranks the bot's configured model at spawn; everything
   *  else resolves the model from the LIVE bot config on every spawn (see
   *  sessionAgentConfig), so a dashboard edit reaches long sessions.
   *
   *  **In-memory only, deliberately.** The public contract is per-trigger /
   *  fresh-spawn ("ignored when folding into an existing worker"), so it must
   *  not outlive this daemon's view of the session: persisting it — which is
   *  what the old `session.model` freeze did — turned a one-shot caller choice
   *  into a permanent override that a later dashboard change could not undo.
   *  Kept (not cleared after the first spawn) so a spawn retry or an in-boot
   *  re-fork of the same session launches identically. */
  spawnModelOverride?: string;
  /** True while this session's worker sits in the crash-loop park state: its CLI
   *  is dead, a diagnostic shell is parked, and the NEXT message makes the worker
   *  respawn the CLI itself from its own `lastInitConfig` snapshot — a launch with
   *  no restart IPC to refresh it. While set, message IPCs carry the freshly
   *  resolved launch model so that recovery does not relaunch on a stale one.
   *  Cleared when a worker generation reports ready. In-memory only. */
  crashDiagnosticParked?: boolean;
  /** Daemon-side bounded auto-retry state for TRANSIENT worker startup
   *  failures (e.g. "spawnSync tmux ETIMEDOUT" during a post-outage restart
   *  storm — see worker-startup-retry.ts). `attempts` counts the current
   *  failing streak; `timer` is the pending blank re-fork. Reset (timer
   *  cleared) when a worker generation reaches `ready`. In-memory only. */
  startupAutoRetry?: { attempts: number; timer?: NodeJS.Timeout };
  /** Dashboard「复现命令」：worker 在 `ready` 时上报的、该 session 本次冷启的近似
   *  可复现 CLI 调用（bin + argv + cwd + 权威注入 env）。**只驻内存、绝不落盘**
   *  ——命令含 provider token / 凭证 env，写进默认 0644 的 sessions-*.json 会让同机
   *  其他用户直接读到（绕过 dashboard cookie + loopback-HMAC）。worker 每次 ready
   *  都会重报，daemon 重启后自愈。仅有写权限的 dashboard 视图经 spawn-command 接口取。 */
  spawnCommand?: string;
  pendingRepo?: boolean;         // waiting for repo selection before spawning CLI
  /** One in-memory owner is preparing the pending repo's first worker. Kept
   *  separate from worktreeCreating because plain select, skip, and /repo can
   *  also await prompt context before the fork. */
  pendingRepoCommitInFlight?: boolean;
  /** A fresh live-route owner has been published but its opening input has not
   * reached the first fork yet. Same-anchor turns must buffer into the opening
   * input instead of reforking worker:null and overtaking it. In-memory only. */
  initialStartPending?: boolean;
  /** Restore quarantine: a durable activation-tail promotion failed transiently
   * during restoreActiveSessions, so the row was registered with its tail
   * un-promoted. The next fork boundary (toReattach blank fork / daemon inbound
   * refork) must retry the promotion BEFORE forking and skip a blank fork if it
   * still fails — never leave a live worker beside an unpromoted tail. Cleared
   * once promotion succeeds. In-memory only. */
  quarantinedActivationTailPromotion?: boolean;
  /** Generation token for the handler that atomically reserved a worker:null
   * refork. Later same-anchor handlers may prepare concurrently, but only this
   * owner may cross the fork boundary; followers buffer behind its gate. */
  initialStartClaimToken?: string;
  /** Number of activation-tail arrivals that reserved FIFO order before an
   * asynchronous prompt/sender build and have not yet durably admitted or
   * failed. An opening ACK must not clear the route while this is non-zero. */
  queuedActivationTailAdmissionsOutstanding?: number;
  /** An opening ACK (or ordinary cold-start handoff) observed while an
   * asynchronous tail admission was outstanding. The final settler replays
   * this release so a late durable successor cannot be stranded. */
  queuedActivationTailReleasePending?: { acknowledgedToken?: string };
  /** Retry timer for an ordinary cold-start handoff whose durable promotion
   * failed after all asynchronous admissions had settled. */
  queuedActivationTailReleaseRetryTimer?: ReturnType<typeof setTimeout>;
  repoCardMessageId?: string;    // message_id of the repo selection card — for withdrawal
  /**
   * Repo-select card message ids already consumed by a successful pending→worker
   * transition (or an explicit mid-session card switch). Stale clicks on these
   * cards must not be treated as a new mid-session switch that kills the just-
   * started worker — Feishu card withdraw is best-effort and may lag or fail.
   * In-memory only; not persisted.
   */
  consumedRepoCardMessageIds?: string[];
  worktreeCreating?: boolean;    // a worktree-open is in flight — dedups repeated card clicks / `/repo wt`
  pendingPrompt?: string;        // original user message to send after repo is selected
  /** Exact Lark message id whose user input is waiting for the first worker
   *  spawn. This is intentionally in-memory and must come from the accepted
   *  inbound event: restoring a session must never recover per-turn authority
   *  from an older persisted quote target. */
  pendingTurnId?: string;
  /** Clean Codex App text/context retained alongside pendingPrompt while repo
   * selection delays the first turn. The legacy enriched prompt remains the
   * compatibility source for every other CLI. */
  pendingCodexAppText?: string;
  /** Trusted, Botmux-authored instructions held out of the visible Codex App
   * user message while the first turn waits for repo selection/worktree setup. */
  pendingCodexAppApplicationContext?: string;
  pendingCodexAppMessageContext?: string;
  /** 入群自动开工首轮使用的群元数据；repo 选择或 auto-worktree 延迟启动时保留。 */
  pendingChatContext?: ChatContext;
  /** One-shot CLI slash command to send literally after the worker reports
   *  prompt_ready. Used when a new topic starts with an adapter-default
   *  passthrough command such as `/goal`: the CLI must see raw `/...`, not a
   *  botmux-wrapped `<user_message>`. In-memory only to avoid replaying after
   *  daemon restart. */
  pendingRawInput?: string;
  /** Exact accepted turn for pendingRawInput. Kept until prompt_ready delivers
   *  the literal command. Raw cold-start workers deliberately spawn without
   *  human turn authority; the worker rotates this turn immediately before
   *  the command is written to the CLI. */
  pendingRawTurnId?: string;
  /** Wrapped prompt for messages buffered while a pendingRawInput session
   *  waited for repo selection (pendingFollowUps / attachments). Built at the
   *  fork site (where prompt-building context lives) and delivered right
   *  after the raw input on prompt_ready, so the buffered messages queue as
   *  the next turn instead of being dropped. In-memory only, like
   *  pendingRawInput. */
  pendingFollowUpInput?: {
    userPrompt: string;
    cliInput: string;
    turnId?: string;
    codexAppInput?: CodexAppTurnInput;
    /** The clean-input feature gate was evaluated when this follow-up was
     * staged; prompt_ready must not re-read a later config value. */
    codexAppInputGateFrozen?: true;
  };
  pendingAttachments?: LarkAttachment[];
  pendingMentions?: LarkMention[];    // @mentions from initial message, used when building prompt after repo selection
  pendingSubstituteTrigger?: import('../types.js').SubstituteTrigger;
  /** Sender (open_id + type + resolved name/email) of the initial message — stashed
   *  so the deferred spawn after repo-selection still injects a <sender> tag
   *  matching the original caller, not the user who clicked the card. */
  pendingSender?: import('../im/lark/identity-cache.js').ResolvedSender;
  /** Frozen plain-human steer authorization for a NEW-TOPIC opening (R5-B1-1).
   * Set by the auto-create admission; buildReservedInitialInput COPIES it onto
   * the opening CliTurnPayload. Only `true`; forkReservedInitialSession (shared by
   * bot-added / scheduler / system bootstrap) never infers it. */
  pendingCodexAppSteerable?: true;
  pendingFollowUps?: string[];         // buffered follow-up messages (enriched) sent while waiting for repo selection
  /** Exact turn for a same-caller pendingRawInput follow-up batch. Cleared on
   *  mixed callers so the combined prompt fails closed instead of borrowing. */
  pendingFollowUpTurnId?: string;
  pendingFollowUpTurnIds?: string[];   // matching inbound ids; last id attributes a folded buffered batch
  pendingCodexAppFollowUps?: string[]; // matching raw user texts for clean Codex App materialization
  pendingCodexAppFollowUpContexts?: string[]; // matching metadata-only context; never duplicates the raw follow-up text
  /** Arrival-time clean-input decisions matching pendingCodexAppFollowUps.
   * Used only when a literal raw cold start must fold followers onto the same
   * text→Enter IPC boundary. */
  pendingCodexAppFollowUpGateAccepted?: boolean[];
  /** Exact turns that arrived while a previously attempted queued activation
   * was re-parked. They remain separate FIFO items behind the retained opening
   * payload and advance only after worker acceptance. In-memory only. */
  pendingQueuedActivationFollowUps?: Array<{
    userPrompt: string;
    cliInput: CliTurnPayload;
    turnId: string;
    dispatchAttempt?: number;
    /** Legacy volatile entries already crossed the clean-input gate when they
     * were staged. Migration must preserve that exact sidecar decision. */
    codexAppInputGateFrozen?: true;
  }>;
  /** Daemon-selected, app-scoped session owner. Frozen for the worker lifetime;
   *  not the current-turn sender. Absent for ownerless/foreign-bot sessions. */
  ownerOpenId?: string;          // receives owner-only links and controls write-enabled access
  streamCardId?: string;         // message_id of the streaming card in group (PATCHed with live output)
  streamCardNonce?: string;       // unique nonce for the current streaming card — embedded in button values to distinguish old vs current card
  /** Visible Lark destination of the live streaming card. Unlike
   * currentReplyTarget this remains bound to the card after a newer turn is
   * accepted, so parking cannot attribute the predecessor to the new topic. */
  streamCardReplyTargetKey?: string;
  streamCardPending?: boolean;    // true while the newest turn still needs its own streaming card
  /** Incremented for every worker status observation, including same-value
   *  edges. A screen update can land while the Feishu starting-card POST is
   *  in flight; the revision lets the POST completion distinguish that from
   *  the pre-turn cached idle state and immediately reconcile the new card. */
  streamCardStatusRevision?: number;
  /** Monotonic in-memory generation for accepted user turns. Card POST
   * completions use it to avoid clearing a newer turn's pending state. */
  streamCardTurnGeneration?: number;
  /** Exact newest turn awaiting its own streaming card. In-memory only. */
  streamCardPendingTurnId?: string;
  pendingLocalCliButtonRefresh?: boolean; // true when cli_session_id arrived while the streaming card POST was in flight
  pendingRiffUrlCardRefresh?: boolean; // true when riff_access_url arrived while the streaming card POST was in flight
  /** Set on sessions restored after a daemon restart: suppresses the automatic
   *  card post/patch from the recovery re-fork so a restart stays silent in the
   *  group (the owner gets a private DM summary instead). Cleared on the first
   *  real CLI input (rememberLastCliInput) — the next turn posts a card normally.
   *  In-memory only. See core/restart-report.ts. */
  suppressRecoveryCard?: boolean;
  /** Turn-exact ids for silent scheduled fires. Every worker→Lark output path
   *  checks its own turn id against this bounded in-memory registry, so a
   *  queued normal user turn cannot un-hush the schedule (or inherit its hush).
   *  Entries outlive turn_terminal briefly to cover trailing worker events and
   *  are pruned by age/size when new silent turns are armed. */
  silentScheduledTurns?: Map<string, number>;
  /** Turn-exact ids for loud external triggers whose connector opted into
   *  suppressFinalOutput. Only the daemon-rendered final_output reply is dropped
   *  (the streaming card / start notice still show); keyed on the trigger turn
   *  id so a normal user turn on the same session is unaffected. Bounded +
   *  age-pruned like silentScheduledTurns. */
  suppressedTriggerFinalTurns?: Map<string, number>;
  /** Session-scoped override: when true, the streaming card is posted/patched
   *  even if the bot has `disableStreamingCard` set. Flipped on by the `/card`
   *  command so a user can manually summon a live card in an otherwise-quiet
   *  session. In-memory only (resets on daemon restart). */
  streamingCardForced?: boolean;
  /** One-shot override for the native CoT (thinking process) message: when
   *  true, the bubble renders for the current/next turn even if the chat is
   *  in `noCotChats` or the bot-level `thinkingCard` switch is off. Flipped on
   *  by `/cot show`; auto-cleared when that turn settles (turn_terminal), so
   *  it is a single peek, not a toggle. In-memory only. */
  cotForced?: boolean;
  /** Latest `thinking_update` of the RUNNING turn, cached regardless of the
   *  CoT switches so `/cot show` can summon the bubble mid-turn with all
   *  thinking accumulated so far (the worker only emits on NEW entries — a
   *  bare force flag could otherwise miss a turn whose thinking already
   *  ended). Cleared on turn_terminal: a bubble created after its turn
   *  settled would never receive RUN_FINISHED and spin forever. */
  lastThinkingUpdate?: { entries: CotEntry[]; turnId: string; dispatchAttempt?: number };
  /** Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming
   *  card disabled). The bot reacts 冲! on each user message the moment it's accepted for the session
   *  (bound to the message, NOT a worker status edge — so type-ahead / busy-
   *  batched messages each get their own reaction). Every pending ✋ here is
   *  flipped to ✅ when the turn returns to idle. In-memory only (a daemon
   *  restart mid-turn just leaves a stale ✋ — purely cosmetic). */
  pendingAckReactions?: Array<{ messageId: string; reactionId?: string }>;
  /** Card body display mode. Default 'hidden'. When user clicks 显示输出, defaults to 'screenshot'. */
  displayMode?: DisplayMode;
  /** Latest uploaded screenshot image_key for the streaming card. */
  currentImageKey?: string;
  lastScreenContent?: string;    // last screen_update content — used to freeze card at idle
  lastScreenStatus?: StreamStatus;  // last screen_update status
  /** turnIds whose triggering Lark message explicitly @-mentioned this bot.
   *  Only positives are stored (absent === not mentioned), so the bounded FIFO
   *  (see recordTurnExplicitMention) is spent entirely on turns that can still
   *  owe a receipt — a long queue of un-@'d turns cannot evict a live one.
   *  Read at turn_terminal to decide whether a deliberately-silent turn owes an
   *  auto receipt. In-memory only: a daemon restart mid-turn skips the receipt. */
  turnExplicitMentions?: Set<string>;
  /** Set when the LAST completed turn ended as deliberate silence (worker
   *  terminal outputDisposition 'nothing_to_send'). Drives the idle-card label
   *  「已处理 · 判定无需回复」 instead of 「等待输入」 so users can tell "chose
   *  silence" from "stuck". Cleared by every new-turn entry point
   *  (beginNewTurn and both worker-exited re-fork branches). In-memory only. */
  silentIdleTurnId?: string;
  /** turnId of the most recently STARTED turn (beginNewTurn and both
   *  worker-exited re-fork branches). Lineage anchor for `silentIdleTurnId`: a
   *  turn_terminal that lands after a NEWER turn already opened — the normal
   *  type-ahead ordering, since the follow-up is admitted while the previous
   *  turn is still running — belongs to the PREVIOUS turn and must not relabel
   *  the live card. Left undefined for sessions driven only by HTTP/async
   *  triggers, where an unknown-lineage turn stays trusted. In-memory only. */
  currentTurnId?: string;
  /** Dedupe guard: turnIds whose silent-turn auto receipt was already posted
   *  (dispatchAttempt replays must not double-post). A bounded FIFO Set, not a
   *  single slot: replays can interleave with other turns (A₁ → B → A₂), and a
   *  one-slot guard would let A₂ re-post. An entry is claimed BEFORE the reply
   *  is sent and released if that send fails, so a later replay can compensate
   *  instead of losing the closure permanently. */
  silentReceiptTurnIds?: Set<string>;
  /** Latest model reported by the live executor. In-memory and rehydrated from
   *  the CLI transcript after worker restart; unlike Session.model it follows
   *  in-session `/model` switches. */
  activeModel?: string;
  /** Latest reasoning effort reported by the live executor. */
  activeReasoningEffort?: string;
  /** Runtime change arrived while a streaming-card POST was in flight. */
  pendingActiveRuntimeCardRefresh?: boolean;
  /** Queued suspend: the request arrived while the session was producing
   *  (working/analyzing), where killing the worker would drop that turn's reply.
   *  Record the reason instead and cash it in once screen_update settles into
   *  idle/limited (see worker-pool.ts runPendingSuspendIfSettled). In-memory
   *  only: lost on daemon restart, and the next `suspend all` cycle re-queues
   *  it — the cost is one cycle of delay, not a missed session. */
  pendingSuspendReason?: string;
  /** Worker generation that owned the queued suspend above. A claim is only
   *  ever about the generation that was producing when the request arrived, so
   *  it must not outlive it: once that worker is suspended (by ANY path) or
   *  exits, the goal state is reached and the claim is consumed. Without this,
   *  a claim whose fulfilment checkpoint never ran (worker crashed, or `/cd` /
   *  read-isolation switch suspended first) survives into the NEXT generation
   *  and suspends it on its first idle. See clearPendingSuspendClaim. */
  pendingSuspendGeneration?: number;
  /** Executor-observed Codex settings for this worker/rollout generation. */
  codexServiceTier?: CodexServiceTierSnapshot;
  /** Tier change arrived while a card POST was in-flight. */
  pendingCodexTierCardRefresh?: boolean;
  /** The currently referenced card has been frozen/parked for handoff. Tier
   * updates belong to the successor card and must not rewrite this snapshot. */
  parkedStreamCardNonce?: string;
  /** Riff AIO Sandbox web terminal link. When set, buildTerminalUrl returns
   *  this URL directly (bypassing the local terminal proxy) so the dashboard
   *  "Web终端" button opens the riff sandbox. In-memory only — re-sent by the
   *  worker on each task. */
  riffAccessUrl?: string;
  /** Remote explicit-close transaction: while present, no new input may be
   * admitted until cancellation commits or admission restoration is ACKed. */
  remoteCloseState?: {
    phase: 'preparing' | 'prepared' | 'abort_restored' | 'uncertain';
    requestId: string;
    taskId?: string;
    /** LOCAL subtree residual carried by a `prepared` proof, so a retry after a
     *  failed durable commit republishes the SAME residual close instead of
     *  degrading it to a plain `closed` (see Session.mojoCloseJournal). */
    localResidual?: 'local_subtree_unprovable_on_platform' | 'local_subtree_boundary_unproven';
  };
  /** Graceful-shutdown transaction for the exact remote worker generation. */
  remoteShutdownState?: {
    phase: 'preparing' | 'prepared';
    requestId: string;
    taskId?: string | null;
  };
  usageLimit?: CliUsageLimitState;
  usageLimitRetryTimer?: NodeJS.Timeout;
  /** Latch for the proactive rate/usage-limit owner notification: the
   *  usageLimitStateKey of the limit episode we already posted about. Exactly
   *  one owner notification per episode; reset to undefined by
   *  clearUsageLimitState (limit self-heal / turn end) so the next episode can
   *  notify again. In-memory only. */
  rateLimitNotifiedKey?: string;
  /** Interval that re-PATCHes the live streaming card with fresh Context/Token
   *  usage while a turn is executing (streaming display mode). Armed on the
   *  working edge, cleared on idle/turn-end/card removal. */
  usageRefreshTimer?: NodeJS.Timeout;
  lastUserPrompt?: string;
  lastCliInput?: string;
  lastCodexAppInput?: CodexAppTurnInput;
  replyThreadAliases?: { [rootMessageId: string]: { createdAt: string; lastUsedAt: string } };
  currentReplyTarget?: { rootMessageId: string; turnId: string; updatedAt: string; quoteOnly?: boolean; substitute?: boolean };
  /** One-shot runtime flag set by the daemon when creating a substitute
   *  (分身) session. The worker-pool consumes and clears it once the worker
   *  reports ready, triggering a one-time substitute control card post so the
   *  new session is immediately controllable. In-memory only (resets on daemon
   *  restart). See core/worker-pool.ts and the substitute session creation path. */
  pendingSubstituteControlCard?: boolean;
  currentTurnTitle?: string;      // title for the current turn's streaming card
  cardPatchInFlight?: boolean;    // true while a card PATCH is in-flight
  pendingCardJson?: string;       // queued card JSON — flushed when in-flight PATCH completes (latest wins)
  pendingCardId?: string;         // card message_id captured at schedule time — prevents stale reads when streamCardId changes between schedule and flush
  frozenCards?: Map<string, FrozenCard>;  // nonce → FrozenCard (historical cards' cached state for toggle)
  /** Wait Mode / HTTP Sync integration: pending Promise handlers for synchronous
   *  webhook triggers waiting for a response in this session. Key is turnId. */
  pendingWaitPromises?: Map<string, { resolve: (text: string) => void; reject?: (err: Error) => void }>;
  /** Async webhook trigger state keyed by triggerId. `sessionId` polling reads
   *  `latestAsyncTriggerId`; callers that need exact-match semantics can also
   *  pass the triggerId returned by the initial async activation response. */
  asyncTriggerResults?: Map<string, {
    status: 'pending' | 'completed' | 'failed';
    createdAt: number;
    completedAt?: number;
    failedAt?: number;
    content?: string;
    errorCode?: 'trigger_failed';
    terminalErrorCode?: string;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number };
  }>;
  latestAsyncTriggerId?: string;
  /** Set on a fresh async virtual turn dispatched under an at-most-once
   *  idempotency lease (options.idempotencyKey). Lets the worker-exit handler
   *  converge an INCOMPLETE idempotent async turn to a durable
   *  `dispatch_unknown` terminal: a worker that dies with no final_output leaves
   *  ds.worker=null but keeps the session in activeSessions + the async record
   *  `pending`, which would otherwise poll `running` forever and let a same-key
   *  retry reuse the dead session until the next daemon reconcile (codex #776
   *  round-6 finding #1). Keyed by triggerId so MULTIPLE concurrent keyed turns
   *  on ONE shared session each get their own convergence stamp — a single slot
   *  let a later turn's stamp clobber an earlier turn's, stranding the earlier
   *  turn `pending` forever on worker exit (codex #818 P1-1). Each entry is
   *  removed once its OWN turn completes (final_output / nothing-to-send) or is
   *  converged on worker exit; a fresh-session turn is just the 1-entry case. */
  idempotentAsyncTurns?: Map<string, {
    ownerLarkAppId: string;
    key: string;
    /** Store domain of the lease key (fresh async-virtual vs follow-up turn) so
     *  convergence looks the lease up under the correct unforgeable namespace. */
    kind: 'fresh' | 'turn';
    /** The worker generation this turn was dispatched on. The exit handler only
     *  converges when the DYING generation is this one (a later generation that
     *  completed and moved on must not be retro-failed). */
    workerGeneration: number;
    /** Set when a post-barrier fault occurred (a throw between the
     *  reserved→attempting barrier and a proven dispatch) AND the durable
     *  terminalize write itself then failed — so the lease is `attempting`, no
     *  durable async result exists, and NOTHING actually dispatched. For a LIVE
     *  shared-session turn the worker never exits, so worker-exit convergence
     *  never fires; the ONLY recovery is a same-key retry (or poll) re-attempting
     *  the strict terminalize. Marks this entry as "terminal write owed" so the
     *  retry pre-check reruns recordFailedStrict instead of `reuse`-ing forever
     *  (codex #818 P1-8). Absent = a normally-dispatched turn (converge on exit). */
    postBarrierFault?: true;
  }>;
  /** Stable turn ids whose automatic transcript fallback is capture/discard.
   *  turn_terminal clears the entry; bounded in trigger-session for crash
   *  paths that never produce a terminal. */
  suppressedFinalOutputTurns?: Map<string, number>;
  /** Worker-issued live turn registry used to authorize daemon-mediated exits
   * (ask/relay) that cannot trust a long-lived CLI's spawn-time env. */
  managedTurnOrigin?: {
    capability: string;
    /** Unguessable Seatbelt pane/profile authority channel. */
    originChannelId?: string;
    turnId?: string;
    dispatchAttempt?: number;
    /** Current human caller, carried over private worker IPC from the
     * daemon-authenticated input envelope. Never sourced from CLI env/files. */
    callerOpenId?: string;
    /** Linux pid:starttime identities already present in the CLI subtree when
     * this turn authority was published. Actor callers may not traverse one of
     * these old descendants; the long-lived CLI root itself is the exception. */
    preexistingProcessIdentities?: string[];
  };
  /** Authority snapshot captured when an explicit Lark IM message was
   * deterministically routed into this dedicated meeting receiver. */
  vcMeetingImTurnOrigin?: VcMeetingImTurnOrigin;
  /** message_id of the TUI prompt interactive card (if active) */
  tuiPromptCardId?: string;
  /** A final ScreenAnalyzer TUI answer has been dispatched and is waiting for
   * the worker's resolved/failed ACK. Claimed synchronously by card-handler so
   * duplicate clicks cannot inject a second key sequence into the same CLI. */
  tuiPromptProcessing?: boolean;
  /** turnId of the last stuck_warning posted — dedup so we don't spam the
   *  thread with repeated warnings for the same unresolved turn. */
  stuckWarningTurnId?: string;
  /** message_id of the stuck_warning interactive card (if active) */
  stuckWarningCardId?: string;
  /** Daemon-side monotonic counter for stuck_warning nonces. NEVER cleared —
   *  even when the active warning authority is dropped, the counter keeps
   *  climbing so a late POST result / ACK from a previous warning (nonce=N)
   *  can never match a newer warning that happened to reuse N after a clear.
   *  stuckWarningNonce (below) is the active warning's nonce and may clear. */
  stuckWarningNonceCounter?: number;
  /** Daemon-side monotonic nonce for the active stuck_warning. Bumped on every
   *  new warning so a late POST result or stale card click from a previous
   *  warning (or a previous worker generation) cannot resurrect authority. */
  stuckWarningNonce?: number;
  /** Page type of the active stuck-warning card ('hook review level 1' or
   *  'hook review level 2') — forwarded to the worker on card click so it can
   *  re-verify the current screen before injecting keys. */
  stuckWarningPageType?: string;
  /** When true, a card click has been dispatched to the worker and we are
   *  waiting for the tui_keys_delivered / stuck_warning_expired ACK. Blocks
   *  duplicate clicks from injecting keys twice. */
  stuckWarningProcessing?: boolean;
  /** Worker's cliLifetimeNonce at the time the stuck_warning was posted.
   *  Forwarded back to the worker in tui_keys so it can verify the backend
   *  hasn't been replaced within the same worker process. */
  stuckWarningCliLifetime?: number;
  /** Cached TUI prompt options — for dedup and for resolving after click */
  tuiPromptOptions?: Array<{ label?: string; text: string; selected: boolean; type?: string; keys?: string[] }>;
  tuiPromptMultiSelect?: boolean;
  tuiToggledIndices?: number[];  // tracks toggled options for multi-select card PATCH
  /** Agent-raised "needs human" signal (`botmux send --attention`). Non-blocking:
   *  the agent flags it hit a blocker only a human can clear (authorization,
   *  an irreversible decision, missing access) and goes on to end its turn.
   *  Feeds the dashboard needs-you column with the human-readable `reason`.
   *  Cleared when the user next replies to the session or when the session
   *  closes. Distinct from tuiPromptCardId (which is a
   *  rendered TUI menu detected by screen-analyzer) — this is deliberate,
   *  agent-initiated, and carries no rendered options. */
  agentAttention?: { kind: string; reason: string; at: number };
  /** 文档评论入口（/watch-comment / /subscribe-lark-doc）：本会话「来自文档评论的轮」的回复落点
   *  映射。key = turnId（= 触发评论的 reply_id/comment_id，随消息传给 worker 再
   *  随 final_output 传回）；value = 该回哪个文档的哪条评论。deliverFinalOutput
   *  命中后把正文发表为文档评论而非飞书卡片，并删除该项。仅内存（轮是瞬时的）。 */
  docCommentTurns?: Map<string, { fileToken: string; fileType: string; commentId: string; replyToOpenId?: string; replyToName?: string; replyId?: string; reactionId?: string }>;
  /** Last scoped dedupe key emitted via the bridge final_output pipeline.
   *  Format is `${sessionId}:${lastUuid || turnId}` so different sessions can
   *  never suppress each other's final_output payloads. */
  lastBridgeEmittedUuid?: string;
  /** Native Hermes messages.session_id values bound by this worker after
   *  seeing botmux-injected `<session_id>...` markers in Hermes state.db.
   *  Hermes `/clear` can rebind to a new native session while a completed
   *  turn from the previous source is still queued for emission, so the
   *  daemon keeps every source announced by the current worker. */
  hermesBridgeSourceSessionIds?: Set<string>;
  /** Flag flipped once this process lifecycle has already been reflected on the
   *  dashboard. A real close publishes `session.exited`; a deliberate suspend
   *  publishes `status=dormant`. The later child-process exit must not emit a
   *  second, contradictory close event. Reset when a new process is forked. */
  exitEventEmitted?: boolean;
  /** Present when this session was created via /adopt (shared observation mode).
   *  Either tmuxTarget (tmux) OR zellijSession+zellijPaneId (zellij) is set. */
  adoptedFrom?: {
    /** Source backend of the external session. Absent means legacy tmux metadata. */
    source?: 'tmux' | 'herdr' | 'zellij';
    tmuxTarget?: string;       // e.g. "0:2.0" — user's original tmux pane
    zellijSession?: string;    // zellij session name (zellij backend)
    zellijPaneId?: string;     // e.g. "terminal_1" — observe/drive target
    herdrSessionName?: string;
    herdrTarget?: string;
    herdrPaneId?: string;
    herdrAgentName?: string;
    herdrTerminalId?: string;
    originalCliPid?: number;   // CLI process PID in the user's pane, when the source exposes one
    sessionId?: string;       // CLI session ID (for takeover/resume)
    cliId?: import('../adapters/cli/types.js').CliId;  // recognized CLI type
    cwd: string;              // CLI working directory
    paneCols?: number;        // pane width at adopt time
    paneRows?: number;        // pane height at adopt time
  };
}

/** A non-null value means this remote generation is deliberately rejecting new
 * input until a close commit, remote shutdown commit, or ACKed admission restore. */
export function remoteRetirementAdmissionPhase(ds: DaemonSession): string | null {
  if (ds.remoteShutdownState) return `shutdown-${ds.remoteShutdownState.phase}`;
  if (ds.remoteCloseState) return `close-${ds.remoteCloseState.phase}`;
  if (ds.session.mojoCloseJournal) return `close-${ds.session.mojoCloseJournal.phase}`;
  return null;
}

/** Composite key for activeSessions — allows multiple bots to have independent
 *  sessions anchored on the same id. The first arg is the **routing anchor**:
 *  - thread-scope → rootMessageId
 *  - chat-scope   → chatId
 *  Lark message ids start with `om_` and chat ids with `oc_`, so collisions
 *  between the two address spaces are not possible. */
export function sessionKey(anchorId: string, larkAppId: string): string {
  return `${anchorId}::${larkAppId}`;
}

const CONSUMED_REPO_CARD_CAP = 16;

/** Record a repo-select card as already consumed. Correctness for stale clicks
 *  depends on this local mark — not on Feishu deleteMessage succeeding. */
export function markRepoCardConsumed(ds: DaemonSession, cardMessageId: string | undefined): void {
  if (!cardMessageId) return;
  const ids = ds.consumedRepoCardMessageIds ?? (ds.consumedRepoCardMessageIds = []);
  if (!ids.includes(cardMessageId)) ids.push(cardMessageId);
  if (ids.length > CONSUMED_REPO_CARD_CAP) ids.splice(0, ids.length - CONSUMED_REPO_CARD_CAP);
}

export function isRepoCardConsumed(ds: DaemonSession, cardMessageId: string | undefined): boolean {
  return !!cardMessageId && !!ds.consumedRepoCardMessageIds?.includes(cardMessageId);
}

/**
 * Whether a card callback may drive repo selection for this session.
 * Only the currently posted card (`ds.repoCardMessageId`) is valid — after it
 * is claimed/cleared, or after a daemon restart (field is in-memory), stale
 * Feishu cards must not mid-session-switch. Previously-consumed ids are also
 * rejected while the process is still up.
 */
export function isActiveRepoCard(ds: DaemonSession, cardMessageId: string | undefined): boolean {
  if (!cardMessageId) return false;
  if (isRepoCardConsumed(ds, cardMessageId)) return false;
  return ds.repoCardMessageId === cardMessageId;
}

/**
 * Atomically claim the session's current repo-select card for this action.
 * Succeeds only when `cardMessageId` is the live `ds.repoCardMessageId` (or
 * `cardMessageId` is omitted and a current card exists — text path withdrawing
 * the open card). On success: clears `repoCardMessageId` and marks consumed
 * BEFORE any killWorker / network await so concurrent callbacks cannot
 * double-switch. Returns the claimed id, or undefined if the action must not
 * proceed as a card-driven selection.
 */
export function claimCurrentRepoCard(ds: DaemonSession, cardMessageId: string | undefined): string | undefined {
  const current = ds.repoCardMessageId;
  if (!current) {
    // No live card — reject any card id (restart / already claimed). Text path
    // with no cardMessageId also gets undefined (caller proceeds without card).
    return undefined;
  }
  if (cardMessageId && cardMessageId !== current) return undefined;
  if (isRepoCardConsumed(ds, current)) {
    ds.repoCardMessageId = undefined;
    return undefined;
  }
  ds.repoCardMessageId = undefined;
  markRepoCardConsumed(ds, current);
  return current;
}

/** Resolve the routing anchor for an active session — chatId for chat-scope
 *  sessions, rootMessageId for thread-scope. Used to compute `sessionKey()` at
 *  storage and lookup time. */
export function sessionAnchorId(ds: DaemonSession): string {
  const deferredAnchor = ds.session.deferredScheduleRun?.routingAnchor;
  if (deferredAnchor) return deferredAnchor;
  return ds.scope === 'chat' ? ds.chatId : ds.session.rootMessageId;
}

/** Resolve a persisted session's daemon routing anchor without first building
 * a DaemonSession. Deferred schedule runs are isolated even though their
 * visible delivery surface is a chat. */
export function storedSessionAnchorId(
  session: Pick<Session, 'scope' | 'chatId' | 'rootMessageId' | 'deferredScheduleRun'>,
): string {
  return session.deferredScheduleRun?.routingAnchor
    ?? (session.scope === 'chat' ? session.chatId : session.rootMessageId);
}

/** Storage key for the daemon-owned activeSessions map. A VC meeting agent is
 * now an ordinary chat-scope session in its listener group (Plan B): it is keyed
 * by the normal `(chatId, appId)` slot so plain IM and meeting transcripts both
 * fold into the one session. The `vcMeetingReceiver` marker is retained as pure
 * delivery/meeting-output metadata and no longer affects routing. */
export function activeSessionKey(ds: DaemonSession): string {
  return sessionKey(sessionAnchorId(ds), ds.larkAppId);
}

/** A session whose only IM surface is a Feishu document comment thread.
 * `doc:` is an internal virtual address, not a real Lark chat_id, so rich
 * cards and other chat API calls must never target it. */
export function isDocNativeSession(ds: Pick<DaemonSession, 'scope' | 'chatId'>): boolean {
  return ds.scope === 'chat' && ds.chatId.startsWith('doc:');
}

/** A session created by the HTTP control API (`waitForFinalOutput` /
 * `asyncReturnSessionId`) whose `chatId` is a synthetic `http_async_*` /
 * `http_wait_*` address, NOT a real Lark chat. Any Feishu chat API call
 * targeting it (sendMessage / card / reply / roster probe) would fail — these
 * sessions are request/response only and must never touch Lark transport.
 * Tolerates a nullish chatId (returns false — a missing surface is not an
 * HTTP virtual chat), so callers converging onto this predicate can pass an
 * optional chatId without a separate `?.` guard. */
export function isHttpVirtualSession(chatId: string | undefined | null): boolean {
  if (!chatId) return false;
  return chatId.startsWith('http_async_') || chatId.startsWith('http_wait_');
}

/** Central Lark-transport capability gate for a live session. Returns false —
 * meaning "no Feishu side effects are permitted for this session" — when either
 * the owning bot is core-only (`apiOnly`, never connected to Feishu) OR the
 * session's surface is a synthetic HTTP virtual chat. Every auxiliary-UI /
 * reply / card / roster seam should fail-closed on `!larkTransportEnabled(...)`
 * instead of re-deriving the condition, so a new no-Feishu surface is covered
 * everywhere by construction. `doc:` sessions keep their own dedicated routing
 * (comment API), so they are intentionally NOT folded in here.
 *
 * `chatId` is REQUIRED-but-nullable on purpose: a caller holding an optional
 * chatId may pass `undefined`/`null` (tolerated — see isHttpVirtualSession),
 * but OMITTING the key entirely stays a compile error. This is a fail-closed
 * gate, and a forgotten `chatId` would land on the permissive side (an
 * apiOnly-less object would read as "transport enabled"), so the missing-key
 * case must not typecheck. Do not relax to `chatId?:`. */
export function larkTransportEnabled(
  ds: { chatId: string | null | undefined; apiOnly?: boolean },
): boolean {
  if (ds.apiOnly === true) return false;
  if (isHttpVirtualSession(ds.chatId)) return false;
  return true;
}
