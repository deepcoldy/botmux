/**
 * Legacy slash-route oracle — 今天（`feat/command_op` 基线，`origin/master` dc7b4e63 之上；2026-09-16 rebase 时把主干 #956 新增的 `/cleanup-wt` 同步进两张集合——这是基线前移，不是路由器改动）
 * daemon 两条入口对斜杠命令的路由判定，逐字转写成的**纯函数**。
 *
 * 用途：`docs/design/2026-09-11-command-router.md` §10 的 legacy oracle 差分。新路由器
 * 落地后，对同一组输入断言「新路由决策 == 本 oracle 决策」，oracle 拒绝而新路由接受的
 * 输入必须落在 §9 的「有意变化」表里。
 *
 * ⚠️ 规矩：**本文件不 import 任何 `src/` 模块**。它是冻结的老行为快照；一旦 import，
 * src 侧的改动会同步"修正"oracle，差分测试就退化成恒等式。所有集合、正则、解析器都是
 * 从 src 拷贝过来的字面量副本。src 改了 → 差分红灯 → 人来决定是"有意变化"还是回归，
 * 而不是让 oracle 自动跟随。
 *
 * 覆盖边界（**不**在 oracle 里）：
 * - 授权闸：`grantRestrictedSlashCommandText`、`canTalkForGroupSessions`、`canOperate`、
 *   `canRunDaemonCommand`、配额闸。它们只会把某个分支变成「回一句没权限」，不改变
 *   「这条消息归哪一层认领」。
 * - 上游层：`/summary` 正则、`matchCommandTrigger`、`parseTopicHeader`、commandTrigger
 *   模板渲染、messageListener、v3 saved workflow、workflow grill。oracle 的入参 `text`
 *   就是这些层跑完之后的**命令车道文本**（今天 daemon 里的 `cmdContent`）。
 * - `/fast` 的 `fastToggleUnsupportedBackend` 后端能力闸（riff / mojo / codexRpcInput）。
 * - `hasQueuedActivationAdmissionGate`（活 worker 上的排队激活提交闸，见下面「转写时拿不准」②）。
 *
 * 转写时拿不准、按下面口径钉死的地方（差分输入与断言都按这两条构造）：
 * ① **`existing_only` 与 `existing` 在 thread 且会话存在时同路径**：`src/daemon.ts:20247`
 *    的预建块排除条件是 `!existingDs && …`，所以会话已存在时，`EXISTING_SESSION_ONLY_*`
 *    命令与普通 daemon 命令都不预建、都直接落 `:20309` 的 `handleCommand`。oracle 仍把
 *    两者输出成不同的 `sessionPolicy`（`existing_only` 只看命令集合、`existing` 只看相位），
 *    那只是转写口径；**差分时视这两个值为等价**，新路由把哪条命令归到哪个名字都不算回归。
 * ② **`hasQueuedActivationAdmissionGate` 不建模**：`src/daemon.ts:20184` 在「worker 活着」
 *    的透传路径上多一条拒绝（`daemon.cmd_activation_pending`），依赖 ds 的排队激活内部
 *    状态而不是相位，任何相位的活 worker 都可能命中。**差分输入一律假定该闸未触发**；
 *    要覆盖它得另起一组以 ds 内部状态为坐标的用例，不在本 oracle 范围。
 */

// ─── 相位与输入/输出 ────────────────────────────────────────────────────────

/**
 * 会话相位的子集（设计文档 §5 的 `SessionPhase` 去掉 oracle 观测不到的格子）。
 * - `none`：thread 语境下表示 `activeSessions.get(sessionKey(anchor, larkAppId))` 缺席
 *   （`src/daemon.ts:20083` 的 `existingDs === undefined`）；new-topic 语境下恒成立。
 * - `pendingRepo`：有 `existingDs`，但 worker 还没起（`ds.worker === null`），且在等选仓 /
 *   建 worktree / 停起。
 * - `dormant`：有 `existingDs`、worker 也不在，但**不**在等选仓（restore 后等 refork、
 *   开场 fork 尚未发生）。在**路由判定**上与 `pendingRepo` 同形（`hasSession=true`、
 *   `workerIsLive=false`），分开只是为了让差分输入集覆盖设计文档 §5 的格子。
 * - `spawning` / `ready` / `running`：有 `existingDs` 且 worker 在（`ds.worker && !killed`）。
 *   三者在**路由判定**上今天完全同形，分开同样只为覆盖 §5 的格子。
 *
 * `src/core/session-phase.ts` 的 `SessionPhase` → `OraclePhase` 映射（差分夹具按此投影）：
 *   none                                  → none
 *   pendingRepo / worktreeCreating / queued → pendingRepo（三者都是「会话在、worker 不在」，
 *                                            路由层没有独立分支）
 *   dormant                               → dormant
 *   spawning / ready / running            → 同名
 *   closed                                → **不进 oracle**（会话不在 `activeSessions` 里，
 *                                            真要喂就按 `none` 投影）
 */
export type OraclePhase = 'none' | 'pendingRepo' | 'dormant' | 'spawning' | 'ready' | 'running';

export interface OracleInput {
  /** 已剥前导 @ 的命令车道文本（今天的 `cmdContent`）。 */
  text: string;
  context: 'new-topic' | 'thread';
  /** thread 语境下 `'none'` 表示该 anchor 尚无会话（`existingDs` 缺席）。
   *  new-topic 语境下本字段**被忽略**：那条路径压根不查 `activeSessions`。 */
  phase: OraclePhase;
  /** `resolvePassthroughCommands(larkAppId, cliIdOverride?)` 的结果（调用方按 bot/CLI 算好传入）。 */
  passthrough: ReadonlySet<string>;
  /** adapter `defaultPassthroughCommands`（`isInitialSessionPassthrough` 认的集合，
   *  `src/daemon.ts:17534`）。 */
  coldStartPassthrough: ReadonlySet<string>;
  senderIsBot: boolean;
  acceptSlashFromBots: boolean;
}

export type OracleDecision =
  | { kind: 'forward'; reason: 'no_slash' | 'discussion' | 'bot_gated' | 'unknown_slash' }
  | { kind: 'special'; cmd: string; content: string; handler: 'sessions' | 'vc-auth' | 'card' | 'cot' | 'term' }
  | { kind: 'passthrough'; cmd: string; content: string; delivery: 'cold_start' | 'existing' | 'reject_needs_session' | 'reject_needs_active_cli' }
  | { kind: 'daemon'; cmd: string; content: string; sessionPolicy: 'sessionless' | 'existing_only' | 'precreate' | 'existing' };

// ─── 冻结的集合（拷自 src，勿 import） ──────────────────────────────────────

/** 拷自 `src/core/passthrough-commands.ts:13`。 */
const DAEMON_COMMANDS: ReadonlySet<string> = new Set(['/close', '/cleanup-wt', '/restart', '/status', '/retry', '/help', '/cd', '/repo', '/rename', '/schedule', '/role', '/botconfig', '/skills', '/pair', '/login', '/adopt', '/detach', '/disconnect', '/oncall', '/project', '/group', '/g', '/relay', '/quote', '/fork', '/forklist', '/card', '/cot', '/term', '/list-slash-command', '/slash', '/subscribe-lark-doc', '/watch-comment', '/vc', '/insight', '/dashboard', '/sessions', '/vc-auth', '/issue', '/cli']);

/** 拷自 `src/core/passthrough-commands.ts:22`（注释省略，成员逐字）。
 *  oracle 本身不用它路由——路由用的是入参 `passthrough`（调用方跑
 *  `resolvePassthroughCommands` 算出来的）——导出只为差分夹具构造基础集。 */
export const ORACLE_PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set([
  '/compact', '/model', '/clear', '/plugin', '/usage',
  '/new',
  '/context', '/cost', '/mcp', '/diff',
  '/code-review', '/security-review', '/review',
  '/btw',
  '/effort',
  '/fast',
]);
export const ORACLE_DAEMON_COMMANDS = DAEMON_COMMANDS;

/** 拷自 `src/core/command-handler.ts:144`。 */
const SESSIONLESS_DAEMON_COMMANDS: ReadonlySet<string> = new Set(['/group', '/g', '/project', '/list-slash-command', '/slash', '/botconfig', '/dashboard', '/sessions', '/skills', '/vc-auth', '/watch-comment', '/issue', '/cleanup-wt']);

/** 拷自 `src/core/command-handler.ts:173`。 */
const EXISTING_SESSION_ONLY_DAEMON_COMMANDS: ReadonlySet<string> = new Set(['/rename', '/fork', '/forklist', '/quote']);

/** 拷自 `src/core/command-handler.ts:301`。 */
const MULTILINE_COMMANDS: ReadonlySet<string> = new Set(['/schedule', '/role', '/fork']);

/** 三个子集同样只导出给差分夹具（test/command-schema.test.ts 用它们钉 schema 推导结果）。 */
export const ORACLE_SESSIONLESS_DAEMON_COMMANDS = SESSIONLESS_DAEMON_COMMANDS;
export const ORACLE_EXISTING_SESSION_ONLY_DAEMON_COMMANDS = EXISTING_SESSION_ONLY_DAEMON_COMMANDS;
export const ORACLE_MULTILINE_COMMANDS = MULTILINE_COMMANDS;

// ─── 冻结的解析器（拷自 src，勿 import） ────────────────────────────────────

export interface SlashCommandInvocation {
  cmd: string;
  content: string;
}

/**
 * 逐字拷自 `src/core/command-handler.ts:335` `parseSlashCommandInvocation`。
 * 原注释保留要点：两端 trim（尾随换行会被 raw_input 原样打进 CLI，破坏其斜杠命令识别）；
 * 尖括号占位符当文档不当调用；多行仅 `MULTILINE_COMMANDS` 豁免，且"下面还有以 `/` 开头
 * 的行"一律当讨论文本。
 */
export function parseSlashCommandInvocationOracle(content: string): SlashCommandInvocation | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

  const lines = trimmed.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trimEnd();
  const [cmdRaw] = firstLine.split(/\s+/);
  const cmd = cmdRaw?.toLowerCase();
  if (!cmd) return null;

  // Treat angle-bracket placeholders as documentation, not an invocation.
  if (/<[^>\r\n]+>/.test(firstLine)) return null;

  const restNonBlank = lines.slice(1).map(l => l.trim()).filter(Boolean);
  if (restNonBlank.length > 0) {
    // A list of slash commands is almost certainly discussion / planning text.
    if (restNonBlank.some(l => l.startsWith('/'))) return null;
    if (!MULTILINE_COMMANDS.has(cmd)) return null;
  }

  return { cmd, content: trimmed };
}

/** 逐字拷自 `src/core/doc-watch-command.ts:15` `parseWatchSpec` +
 *  `:40` `parseDocWatchCommand` + `:56` `docWatchCommandNeedsSession`，
 *  只保留 `kind` 判定所需的部分（`/watch-comment` 是 `SESSIONLESS_*` 里唯一按 content
 *  分叉的命令）。 */
function docWatchCommandNeedsSession(content: string): boolean {
  const arg = content.replace(/^\/watch-comment(?:\s+|$)/i, '').trim();
  if (!arg) return false;                          // kind: 'usage'
  if (/^(list|列表)$/i.test(arg)) return false;     // kind: 'list'
  if (/^(off|stop|unwatch|退订)(?:\s+([\s\S]+))?$/i.test(arg)) return false; // kind: 'off'

  const hasAll = /(?:^|\s)--all(?:\s|$)/i.test(arg);
  const hasMentionsOnly = /(?:^|\s)--mentions-only(?:\s|$)/i.test(arg);
  if (hasAll && hasMentionsOnly) return false;     // kind: 'invalid' (conflicting_modes)

  const docRef = arg
    .replace(/(?:^|\s)--dir\s+\S+/gi, ' ')
    .replace(/(?:^|\s)--mentions-only(?=\s|$)/gi, ' ')
    .replace(/(?:^|\s)--all(?=\s|$)/gi, ' ')
    .trim();
  if (!docRef) return false;                       // kind: 'invalid' (missing_argument)
  return true;                                     // kind: 'watch'
}

/** 逐字拷自 `src/daemon.ts:4997` `isSessionlessCommandInvocation`。 */
function isSessionlessCommandInvocation(cmd: string, content: string): boolean {
  if (!SESSIONLESS_DAEMON_COMMANDS.has(cmd)) return false;
  if (cmd !== '/watch-comment') return true;
  return !docWatchCommandNeedsSession(content);
}

/** `existingDs` 是否存在（thread）。`new-topic` 路径不查 activeSessions，恒为"无"。 */
function hasSession(phase: OraclePhase): boolean {
  return phase !== 'none';
}

/** `deliverPassthroughToExistingSession`（`src/daemon.ts:17606`）首条判定在 `:17627`：
 *  `(ds.worker && !ds.worker.killed) || isSessionTransferring(ds)`：
 *  `pendingRepo` / `dormant` 相位 worker 不在（`worker: null` 或 `killed`），落到 `:17677` 的
 *  `cmd_needs_active_cli` 拒绝分支。`isSessionTransferring` 不在相位模型里，忽略。 */
function workerIsLive(phase: OraclePhase): boolean {
  return phase === 'spawning' || phase === 'ready' || phase === 'running';
}

// ─── 路由 ───────────────────────────────────────────────────────────────────

export function legacySlashRoute(input: OracleInput): OracleDecision {
  // ① bot 门。new-topic: src/daemon.ts:18393-18396（`senderIsBotForSlashGate &&
  //    !botAcceptsSlashFromBots` → invocation = null，整条落到普通消息转发）。
  //    thread: src/daemon.ts:20071-20073，同形。**在 parse 之前**，所以被门掉的
  //    bot 消息连"是不是命令"都不判。
  if (input.senderIsBot && !input.acceptSlashFromBots) {
    return { kind: 'forward', reason: 'bot_gated' };
  }

  // ② parse（src/core/command-handler.ts:335）。返回 null 的三种形状：不以 `/` 开头、
  //    首行含 `<…>` 占位符、多行且不豁免/后续行还有 `/` —— 后两者是"讨论文本"，
  //    第一种是"压根没有命令"。两者在 daemon 里都是同一个 fall-through，此处分开
  //    只为让差分能看清原因。
  const invocation = parseSlashCommandInvocationOracle(input.text);
  if (!invocation) {
    return {
      kind: 'forward',
      reason: input.text.trim().startsWith('/') ? 'discussion' : 'no_slash',
    };
  }
  const { cmd, content } = invocation;

  if (input.context === 'new-topic') {
    // ③ 新话题的五条前置特判，**全部在透传闸之前**（src/daemon.ts:18415 /18450 /18472
    //    /18484，透传闸在 :18488）。理由见各自注释：它们都不需要会话，走通用
    //    DAEMON_COMMANDS 块会预建一个 worker:null 的幽灵会话。
    if (cmd === '/sessions') return { kind: 'special', cmd, content, handler: 'sessions' };  // :18415
    if (cmd === '/vc-auth') return { kind: 'special', cmd, content, handler: 'vc-auth' };    // :18450
    if (cmd === '/card') return { kind: 'special', cmd, content, handler: 'card' };          // :18472
    if (cmd === '/cot') return { kind: 'special', cmd, content, handler: 'cot' };            // :18477
    if (cmd === '/term') return { kind: 'special', cmd, content, handler: 'term' };          // :18484

    // ④ 透传闸（src/daemon.ts:18488）。注意 `resolvePassthroughCommands(larkAppId)`
    //    **不传** cliIdOverride —— 新话题没有已冻结的会话 CLI，按 live bot 配置算。
    if (input.passthrough.has(cmd)) {
      // :18489 isInitialSessionPassthrough → 冷启动拉起会话并排队到 prompt_ready。
      if (input.coldStartPassthrough.has(cmd)) {
        return { kind: 'passthrough', cmd, content, delivery: 'cold_start' };
      }
      // :18526 `daemon.cmd_requires_session`。⚠️ 与 thread 路径同场景的文案不同
      //    （thread 用 `cmd_needs_active_cli`，:20216）。
      return { kind: 'passthrough', cmd, content, delivery: 'reject_needs_session' };
    }

    // ⑤ DAEMON_COMMANDS（src/daemon.ts:18529）。canRunDaemonCommand 授权闸（:18538）
    //    不在 oracle 范围。
    if (DAEMON_COMMANDS.has(cmd)) {
      if (isSessionlessCommandInvocation(cmd, content)) {                 // :18545
        return { kind: 'daemon', cmd, content, sessionPolicy: 'sessionless' };
      }
      if (EXISTING_SESSION_ONLY_DAEMON_COMMANDS.has(cmd)) {               // :18565
        return { kind: 'daemon', cmd, content, sessionPolicy: 'existing_only' };
      }
      // :18575 起无条件 `sessionStore.createSession(...)` + claim + handleCommand。
      // 新话题路径从不查 activeSessions，所以 `phase` 在这里被忽略，恒为 precreate。
      return { kind: 'daemon', cmd, content, sessionPolicy: 'precreate' };
    }

    // ⑥ 认出是 `/xxx` 但不属于任何集合 → 掉出 `if (invocation)` 块，当普通消息转发。
    return { kind: 'forward', reason: 'unknown_slash' };
  }

  // ── thread ──────────────────────────────────────────────────────────────
  // ③′ thread 的前置特判**只有两条**（src/daemon.ts:20090 /20113）。
  if (cmd === '/sessions') return { kind: 'special', cmd, content, handler: 'sessions' };    // :20090
  if (cmd === '/vc-auth') return { kind: 'special', cmd, content, handler: 'vc-auth' };      // :20113
  // ⚠️ `/card` `/cot` 在 thread 里**没有**前置特判：它们落到下面 DAEMON_COMMANDS 的
  //    普通分支（走 handleCommand 的 switch），无会话时会预建会话。`/term` 有特判，
  //    但位置在 DAEMON_COMMANDS 块**内部**（:20226），即在透传闸之后。

  // ④′ 透传闸（src/daemon.ts:20138）。`resolvePassthroughCommands(larkAppId,
  //    passthroughCliId)` 按**冻结的** `cliLaunchSnapshot.cliId` 求值（:20134）——
  //    调用方负责算好传进来。
  if (input.passthrough.has(cmd)) {
    if (!hasSession(input.phase) && input.coldStartPassthrough.has(cmd)) {
      // :20139 `!existingDs && threadChatId && isInitialSessionPassthrough`
      // （`threadChatId` 恒真，chat-scope 的缺席不在 oracle 建模范围）。
      return { kind: 'passthrough', cmd, content, delivery: 'cold_start' };
    }
    if (hasSession(input.phase)) {
      // :20183 `const ds = existingDs` → :20206 deliverPassthroughToExistingSession。
      // worker 在 → raw_input（`hasQueuedActivationAdmissionGate` 那条闸按头部口径②
      // 假定未触发）；worker 不在（pendingRepo / dormant 相位）→ :17677 拒绝。
      return {
        kind: 'passthrough',
        cmd,
        content,
        delivery: workerIsLive(input.phase) ? 'existing' : 'reject_needs_active_cli',
      };
    }
    // :20216 `else void sessionReply(... cmd_needs_active_cli ...)`
    return { kind: 'passthrough', cmd, content, delivery: 'reject_needs_active_cli' };
  }

  // ⑤′ DAEMON_COMMANDS（src/daemon.ts:20219）。
  if (DAEMON_COMMANDS.has(cmd)) {
    if (cmd === '/term') return { kind: 'special', cmd, content, handler: 'term' };          // :20226
    // canRunDaemonCommand 授权闸（:20238）不在 oracle 范围。
    // :20247 预建块的排除条件是 `!sessionless && !existingOnly`；:20302 再判 sessionless
    // 走 detached，其余落 :20309 handleCommand。三者的净效果与下面的顺序等价。
    if (isSessionlessCommandInvocation(cmd, content)) {
      return { kind: 'daemon', cmd, content, sessionPolicy: 'sessionless' };
    }
    if (EXISTING_SESSION_ONLY_DAEMON_COMMANDS.has(cmd)) {
      return { kind: 'daemon', cmd, content, sessionPolicy: 'existing_only' };
    }
    return {
      kind: 'daemon',
      cmd,
      content,
      sessionPolicy: hasSession(input.phase) ? 'existing' : 'precreate',
    };
  }

  return { kind: 'forward', reason: 'unknown_slash' };
}
