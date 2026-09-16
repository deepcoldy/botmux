/**
 * 命令路由器 —— 斜杠命令的**分类层**（设计 docs/design/2026-09-11-command-router.md R1 / §5）。
 *
 * 输入是命令车道文本（今天 daemon 里剥掉前导 @ 之后的 `cmdContent`）加四样上下文：入口
 * （新话题 / thread）、会话相位（session-phase.ts）、按 bot/CLI 算好的透传集、发送方是不是
 * bot。输出是一条**决策**：这条消息归谁认领、以什么会话政策处理。执行仍在 daemon 两条入口
 * 里，路由器只回答"是什么"，不做效果。
 *
 * PR-2 的约定：**决策与今天逐字一致**（零语义变化），差分由 test/legacy-oracle 的冻结 oracle
 * 穷举验证；唯一的有意变化（thread 入口 `/card` `/cot` 收敛为前置特判）登记在差分测试的
 * INTENTIONAL 名单。相位在这里只用两个谓词：有没有会话（sessionPolicy 的 precreate/existing）、
 * 有没有活 worker（级联识别闸）；"透传送不送得进去"由执行段按 `ds.worker` 实时判，不在这里
 * 按相位重复猜——§5 矩阵里 worktreeCreating / queued 两格的"拒"因此**没有**被编码。
 *
 * 纯函数：不读配置、不碰会话表。透传集由调用方按入口口径求值（新话题按 live bot 配置；
 * thread 按冻结的 `cliLaunchSnapshot.cliId`，见 R2）后传入。
 */
import {
  DAEMON_COMMANDS,
  EXISTING_SESSION_ONLY_DAEMON_COMMANDS,
  MULTILINE_COMMANDS,
  ROUTE_SPECIAL_COMMANDS,
  SESSIONLESS_DAEMON_COMMANDS,
  type CommandSpecialHandler,
} from './command-schema.js';
import { docWatchCommandNeedsSession } from './doc-watch-command.js';
import { phaseHasLiveWorker, phaseHasSession, type SessionPhase } from './session-phase.js';

export interface SlashCommandInvocation {
  cmd: string;
  content: string;
}

/** Parse a user-authored slash command after leading @mentions have already
 *  been stripped. Messages that look like command examples or command lists
 *  are intentionally left for the CLI instead of being intercepted by the
 *  daemon; otherwise discussion text such as `/adopt <pane>` can accidentally
 *  trigger real daemon actions. */
export function parseSlashCommandInvocation(content: string): SlashCommandInvocation | null {
  // trim BOTH ends: a trailing newline/space rides into the returned `content`
  // and, for a passthrough command relayed verbatim to the CLI (raw_input), gets
  // typed as a literal trailing newline — which breaks the CLI's slash-command
  // detection (it sees a multi-line message, not a `/cmd`). Internal newlines for
  // MULTILINE_COMMANDS are preserved (trim only touches the ends).
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

/**
 * `/watch-comment <doc>` 是会话型操作：即使命令族的 list/off/pending 可以无会话
 * 运行，真正开始监听时也要创建/复用当前话题 session 并立即预热 CLI。
 */
export function isSessionlessCommandInvocation(cmd: string, content: string): boolean {
  if (!SESSIONLESS_DAEMON_COMMANDS.has(cmd)) return false;
  if (cmd !== '/watch-comment') return true;
  return !docWatchCommandNeedsSession(content);
}

export type RouteContext = 'new-topic' | 'thread';

export interface SlashRouteInput {
  /** 命令车道文本：已剥前导 @（今天的 `cmdContent`）。 */
  text: string;
  context: RouteContext;
  /** 新话题入口恒为 `none`（那条路径不查 activeSessions）；thread 入口按 `deriveSessionPhase(existingDs)`。 */
  phase: SessionPhase;
  /** `resolvePassthroughCommands(...)` 的结果，按入口口径求值（R2）。 */
  passthrough: ReadonlySet<string>;
  /** adapter `defaultPassthroughCommands`——无会话时允许冷启动的透传命令（`/goal`）。 */
  coldStartPassthrough: ReadonlySet<string>;
  senderIsBot: boolean;
  acceptSlashFromBots: boolean;
  /** 这个会话能不能跑 runtime 级联（§6）：非 riff/mojo 后端、非 adopt 会话。缺省 = 不能。 */
  cascadeCapable?: boolean;
  /** 消息带附件时不切级联（附件跟正文走一条路），整条按今天转发。 */
  hasAttachments?: boolean;
}

/** runtime 级联的一项：透传命令行，或最后的正文。 */
export type CascadeItem =
  | { kind: 'passthrough'; cmd: string; content: string }
  | { kind: 'body'; text: string };

export type SlashRouteDecision =
  /** 交给 CLI 当普通消息：没有命令 token / 讨论文本 / bot 发送方被门掉 / 认不出的 `/xxx`
   *  （后者带上 `cmd`：入口的 grant 限制闸对认不出的斜杠命令同样要查，与改造前一致）。 */
  | { kind: 'forward'; reason: 'no_slash' | 'discussion' | 'bot_gated' }
  | { kind: 'forward'; reason: 'unknown_slash'; cmd: string }
  /** 路由入口的前置特判处理器，不进 handleCommand、不建会话。 */
  | { kind: 'special'; cmd: string; content: string; handler: CommandSpecialHandler }
  /** 透传给 CLI：`cold_start` = 无会话但允许冷启动拉起会话；`to_session` = 交给执行段——有活 worker 就
   *  送 raw_input，否则回"需要活跃 CLI"（执行段按 `ds.worker` 实时判，路由器不重复按相位猜）。 */
  | { kind: 'passthrough'; cmd: string; content: string; delivery: 'cold_start' | 'to_session' }
  /** botmux 自己的命令，带无会话时的会话政策。 */
  | { kind: 'daemon'; cmd: string; content: string; sessionPolicy: 'sessionless' | 'existing_only' | 'precreate' | 'existing' }
  /** runtime 级联（PR-3）：≥1 条透传命令行 + 可选正文，按书写顺序逐条等 CLI 空闲后送出（§6）。 */
  | { kind: 'cascade'; items: CascadeItem[] }
  /** 级联形状成立，但该会话跑不了（riff / mojo / adopt）：fail closed，回一句"请分条发送"。 */
  | { kind: 'cascade_unsupported'; items: CascadeItem[] };

/**
 * runtime 级联的形状（R3 / §4 会话内文法）：连续的前缀块里每一行都是一条透传命令行
 * （单行形态能过 parseSlashCommandInvocation、且 cmd 在透传集里），从第一条不以命令
 * 开头的行起是正文；正文**不能**以 `/` 开头（那是一条 daemon / 未知命令行，不是正文），
 * 空行只在前缀块内跳过。至少 1 条透传 + 至少 2 项才算级联（单条透传走今天的路径）。
 * 返回 null 表示不是级联，调用方按今天的 forward 处理。
 */
export function parseRuntimeCascade(text: string, passthrough: ReadonlySet<string>): CascadeItem[] | null {
  const lines = text.trim().split(/\r?\n/);
  const items: CascadeItem[] = [];
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    if (!line.startsWith('/')) break;
    const single = parseSlashCommandInvocation(line);
    if (!single || !passthrough.has(single.cmd)) {
      // 前缀块里出现非透传的命令行（daemon 命令 / 未知 / 占位符）→ 不是级联。
      return null;
    }
    items.push({ kind: 'passthrough', cmd: single.cmd, content: single.content });
  }
  if (items.length === 0) return null;
  if (i < lines.length) {
    const body = lines.slice(i).join('\n').trim();
    if (body.startsWith('/')) return null;
    if (body) items.push({ kind: 'body', text: body });
  }
  return items.length >= 2 ? items : null;
}

/** 带 cmd/content 的三类决策（special / passthrough / daemon）——入口里按命令执行的那一段只认这三类。 */
export type SlashCommandDecision = Extract<SlashRouteDecision, { cmd: string; content: string }>;

export function isCommandDecision(decision: SlashRouteDecision): decision is SlashCommandDecision {
  return decision.kind === 'special' || decision.kind === 'passthrough' || decision.kind === 'daemon';
}

export function classifySlash(input: SlashRouteInput): SlashRouteDecision {
  // ① bot 门：在 parse 之前——被门掉的 bot 消息连"是不是命令"都不判。
  if (input.senderIsBot && !input.acceptSlashFromBots) {
    return { kind: 'forward', reason: 'bot_gated' };
  }

  // ② parse：不以 `/` 开头是"没有命令"；占位符/多行是"讨论文本"。
  const invocation = parseSlashCommandInvocation(input.text);
  if (!invocation) {
    if (!input.text.trim().startsWith('/')) return { kind: 'forward', reason: 'no_slash' };
    // 多行被今天的解析器判成"讨论文本"的，只在「thread + 活 worker + 无附件」下再试一次
    // 级联形状（PR-3 唯一的语义变化，§9）；其它相位/入口维持今天的整条转发。
    if (input.context === 'thread' && phaseHasLiveWorker(input.phase) && !input.hasAttachments) {
      const items = parseRuntimeCascade(input.text, input.passthrough);
      if (items) return input.cascadeCapable ? { kind: 'cascade', items } : { kind: 'cascade_unsupported', items };
    }
    return { kind: 'forward', reason: 'discussion' };
  }
  const { cmd, content } = invocation;
  // ③ 前置特判（不进 handleCommand、不建会话）。在透传闸之前判，与透传集恒不相交，
  //    所以先后顺序不可观测。
  const special = ROUTE_SPECIAL_COMMANDS.get(cmd);
  if (special) return { kind: 'special', cmd, content, handler: special };

  // ④ 透传闸（先于 DAEMON_COMMANDS；两集合恒不相交，顺序因此不可观测）。
  if (input.passthrough.has(cmd)) {
    const hasSession = phaseHasSession(input.phase);
    if (!hasSession && input.coldStartPassthrough.has(cmd)) {
      return { kind: 'passthrough', cmd, content, delivery: 'cold_start' };
    }
    return { kind: 'passthrough', cmd, content, delivery: 'to_session' };
  }

  // ⑤ DAEMON_COMMANDS。
  if (DAEMON_COMMANDS.has(cmd)) {
    if (isSessionlessCommandInvocation(cmd, content)) {
      return { kind: 'daemon', cmd, content, sessionPolicy: 'sessionless' };
    }
    if (EXISTING_SESSION_ONLY_DAEMON_COMMANDS.has(cmd)) {
      return { kind: 'daemon', cmd, content, sessionPolicy: 'existing_only' };
    }
    return { kind: 'daemon', cmd, content, sessionPolicy: phaseHasSession(input.phase) ? 'existing' : 'precreate' };
  }

  // ⑥ 认出是 `/xxx` 但不属于任何集合 → 当普通消息转发（cmd 留给入口的 grant 限制闸）。
  return { kind: 'forward', reason: 'unknown_slash', cmd };
}
