/**
 * Who executes each goal node of a bot-executed run (design 2026-11-03 §6,
 * D3): the roster the Architect may pick from, the bots the user named in the
 * spec (`assignee`), the one-line reasons the Architect writes, and the Gate-2
 * "node → executing bot" summary.
 *
 * Host-side only (kept out of the workflow-core bundle): it reads bot configs
 * and display names; the live §6.1 probe is injected.
 */

import type { BotConfig } from '../../bot-registry.js';
import { isV3SupportedCli, type Spec } from './contract.js';
import { isGoalNode, isLoopNode, type V3Dag } from './dag.js';
import {
  describeV3BotEligibilityCode,
  judgeV3BotEligibility,
  type V3BotEligibilityProbe,
  type V3NodeExecutorTarget,
} from './node-executor-mode.js';

/** One bot the Architect may assign. Deliberately only these fields: no
 *  secrets, working directories or sandbox configuration (§6.1). */
export interface V3RosterBot {
  larkAppId: string;
  name: string;
  cli: string;
  model?: string;
  /** The bot's configured capability label (`botmux bots list`), if any. */
  role?: string;
  /** The bot running the workflow (executes its own nodes in-process). */
  main?: true;
}

/** A configured bot that cannot execute nodes in this run's chat right now. */
export interface V3RosterExclusion {
  larkAppId: string;
  name: string;
  why: string;
}

export interface V3BotRoster {
  mainLarkAppId: string;
  bots: V3RosterBot[];
  excluded: V3RosterExclusion[];
}

const MAX_ROLE_CHARS = 120;
const MAX_REASON_CHARS = 200;
const ROSTER_PROBE_CONCURRENCY = 4;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Why a bot can never execute a workflow node, from its config alone (the
 *  same rules the Gate-2 snapshot freeze enforces). */
function staticExclusion(bot: BotConfig): string | undefined {
  if (!isV3SupportedCli(bot.cliId)) return `CLI ${bot.cliId} 不能执行工作流节点`;
  if (bot.disableCliBypass === true) return '关闭了 CLI bypass，不能执行工作流节点';
  if (bot.codexProfile) return '配置了 Codex profile，不能执行工作流节点';
  return undefined;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The bots that can execute a node of a run in this chat right now (§6.1):
 * the main bot, plus every configured bot that passes the read-only checks
 * (supported CLI with bypass, daemon online, in the chat, opens topic
 * sessions). No chat grant is written here — approve-dag does that for the
 * bots actually assigned.
 */
export async function buildV3BotRoster(input: {
  orchestratorAppId: string;
  bots: readonly BotConfig[];
  probe: V3BotEligibilityProbe;
  nameOf: (larkAppId: string) => string;
  roleOf?: (larkAppId: string) => string | undefined;
}): Promise<V3BotRoster> {
  const seen = new Set<string>();
  const unique = input.bots.filter((bot) => {
    if (!bot.larkAppId || seen.has(bot.larkAppId)) return false;
    seen.add(bot.larkAppId);
    return true;
  });
  const ordered = [
    ...unique.filter((bot) => bot.larkAppId === input.orchestratorAppId),
    ...unique.filter((bot) => bot.larkAppId !== input.orchestratorAppId),
  ];
  const verdicts = await mapLimited(ordered, ROSTER_PROBE_CONCURRENCY, async (bot): Promise<string | undefined> => {
    const fixed = staticExclusion(bot);
    if (fixed) return fixed;
    if (bot.larkAppId === input.orchestratorAppId) return undefined;
    const problem = await judgeV3BotEligibility(bot.larkAppId, input.probe, { grant: false });
    return problem
      ? describeV3BotEligibilityCode(problem.code) + (problem.detail ? `（${problem.detail}）` : '')
      : undefined;
  });
  const roster: V3BotRoster = { mainLarkAppId: input.orchestratorAppId, bots: [], excluded: [] };
  ordered.forEach((bot, index) => {
    const name = input.nameOf(bot.larkAppId);
    const why = verdicts[index];
    if (why) {
      // Probe details are external error text: one line, bounded.
      roster.excluded.push({ larkAppId: bot.larkAppId, name, why: oneLine(why, MAX_REASON_CHARS) });
      return;
    }
    const role = input.roleOf?.(bot.larkAppId);
    roster.bots.push({
      larkAppId: bot.larkAppId,
      name,
      cli: bot.cliId,
      ...(bot.model ? { model: bot.model } : {}),
      ...(role?.trim() ? { role: oneLine(role, MAX_ROLE_CHARS) } : {}),
      ...(bot.larkAppId === input.orchestratorAppId ? { main: true as const } : {}),
    });
  });
  return roster;
}

// ─── The bots the user named (spec `assignee`) ───────────────────────────

export type V3AssigneeTarget =
  | { kind: 'bot'; larkAppId: string }
  | { kind: 'unknown' }
  | { kind: 'ambiguous'; larkAppIds: string[] };

function normalName(name: string): string {
  return name.trim().replace(/^@+/, '').trim().toLowerCase();
}

/**
 * Resolve a user-named bot: an exact larkAppId first, then a unique match on
 * any of its names (the Lark app name in bots-info, the dashboard display
 * name, the process name), case-insensitively and ignoring a leading "@".
 */
export function resolveV3Assignee(
  assignee: string,
  bots: readonly BotConfig[],
  nameOf: (larkAppId: string) => string,
): V3AssigneeTarget {
  const exact = bots.find((bot) => bot.larkAppId === assignee.trim());
  if (exact) return { kind: 'bot', larkAppId: exact.larkAppId };
  const wanted = normalName(assignee);
  if (!wanted) return { kind: 'unknown' };
  const matches = [...new Set(bots
    .filter((bot) => [nameOf(bot.larkAppId), bot.displayName, bot.name]
      .some((name) => typeof name === 'string' && normalName(name) === wanted))
    .map((bot) => bot.larkAppId))];
  if (matches.length === 1) return { kind: 'bot', larkAppId: matches[0]! };
  return matches.length === 0 ? { kind: 'unknown' } : { kind: 'ambiguous', larkAppIds: matches };
}

/** A sketch's named bot as the Architect is told about it. */
export interface V3SketchAssignee {
  sketchId: string;
  assignee: string;
  target: V3AssigneeTarget;
  /** Set when the named bot exists but is not on the roster. */
  unavailable?: string;
}

/** Everything the Architect needs to assign bots (absent = not a bot run). */
export interface V3ArchitectBotAssignment {
  roster: V3BotRoster;
  assignees: V3SketchAssignee[];
}

export function planV3SketchAssignees(
  spec: Spec,
  roster: V3BotRoster,
  bots: readonly BotConfig[],
  nameOf: (larkAppId: string) => string,
): V3SketchAssignee[] {
  const onRoster = new Set(roster.bots.map((bot) => bot.larkAppId));
  const excluded = new Map(roster.excluded.map((entry) => [entry.larkAppId, entry.why]));
  return spec.nodes.flatMap((sketch) => {
    if (!sketch.assignee) return [];
    const target = resolveV3Assignee(sketch.assignee, bots, nameOf);
    const unavailable = target.kind === 'bot' && !onRoster.has(target.larkAppId)
      ? excluded.get(target.larkAppId) ?? '当前不能执行节点'
      : undefined;
    return [{ sketchId: sketch.sketchId, assignee: sketch.assignee, target, ...(unavailable ? { unavailable } : {}) }];
  });
}

/** Problems for goal-node bot selectors outside the roster (an omitted
 *  selector means the main bot). The Architect is told to use roster
 *  larkAppIds only; anything else is sent back to it. */
export function v3RosterSelectorProblems(dag: V3Dag, roster: V3BotRoster): string[] {
  const allowed = new Set(roster.bots.map((bot) => bot.larkAppId));
  const problems: string[] = [];
  const check = (nodeId: string, selector: string | undefined) => {
    if (selector !== undefined && !allowed.has(selector)) {
      problems.push(`节点 ${nodeId} 的 bot "${selector}" 不在可用 Bot 名单里（只能用：${[...allowed].join(', ')}）`);
    }
  };
  for (const node of dag.nodes) {
    if (isGoalNode(node)) check(node.id, node.bot);
    if (isLoopNode(node)) {
      for (const body of node.body.nodes) check(`${node.id}.${body.id}`, body.bot ?? node.bot);
    }
  }
  return problems;
}

/** Goal nodes of `dag` as "node → app id" (omitted selector = main bot). */
function dagTargets(dag: V3Dag, mainLarkAppId: string): V3NodeExecutorTarget[] {
  const out: V3NodeExecutorTarget[] = [];
  for (const node of dag.nodes) {
    if (isGoalNode(node)) out.push({ nodeId: node.id, larkAppId: node.bot ?? mainLarkAppId });
    if (isLoopNode(node)) {
      for (const body of node.body.nodes) {
        out.push({
          nodeId: `${node.id}.${body.id}`,
          larkAppId: body.bot ?? node.bot ?? mainLarkAppId,
          loop: { loopId: node.id, bodyNodeId: body.id },
        });
      }
    }
  }
  return out;
}

/** §6.2: a named bot that is on the roster MUST execute its sketch's node.
 *  Problems send the dag back to the Architect; named bots that cannot be
 *  used are only flagged at Gate-2. */
export function v3AssigneeProblems(dag: V3Dag, assignment: V3ArchitectBotAssignment): string[] {
  const targets = dagTargets(dag, assignment.roster.mainLarkAppId);
  const problems: string[] = [];
  for (const entry of assignment.assignees) {
    if (entry.target.kind !== 'bot' || entry.unavailable) continue;
    const wanted = entry.target.larkAppId;
    const named = `sketch ${entry.sketchId} 点名「${entry.assignee}」（${wanted}）`;
    const nodes = nodesForSketch(targets, entry.sketchId);
    if (nodes.length === 0) {
      problems.push(`${named}，但没有 id 为 ${entry.sketchId} 的节点（实现它的节点要沿用 sketchId）`);
      continue;
    }
    for (const node of nodes.filter((candidate) => candidate.larkAppId !== wanted)) {
      problems.push(`${named}，但节点 ${node.nodeId} 交给了 ${node.larkAppId}`);
    }
  }
  return problems;
}

// ─── Reasons (architect-notes.md) and the Gate-2 summary ─────────────────

const ASSIGNMENT_HEADING_RE = /^#{1,6}\s*bot assignments\b/i;
const HEADING_RE = /^#{1,6}\s/;
const ASSIGNMENT_LINE_RE = /^\s*[-*]\s+`?([A-Za-z0-9._#-]+)`?\s*(?:→|->)\s*`?([^`:：]+?)`?\s*[:：]\s*(.+?)\s*$/;

/** nodeId → (bot as written, reason) from the notes' `## Bot assignments`
 *  section. Lines elsewhere in the notes are never read. */
export function parseV3AssignmentReasons(notes: string): Map<string, { bot: string; reason: string }> {
  const reasons = new Map<string, { bot: string; reason: string }>();
  let inSection = false;
  for (const line of notes.split(/\r?\n/)) {
    if (HEADING_RE.test(line)) {
      inSection = ASSIGNMENT_HEADING_RE.test(line);
      continue;
    }
    if (!inSection) continue;
    const match = ASSIGNMENT_LINE_RE.exec(line);
    if (!match || reasons.has(match[1]!)) continue;
    const reason = oneLine(match[3]!, MAX_REASON_CHARS);
    if (reason) reasons.set(match[1]!, { bot: match[2]!.trim(), reason });
  }
  return reasons;
}

export type V3AssigneeCheck =
  | { sketchId: string; assignee: string; status: 'honoured'; larkAppId: string; nodeIds: string[] }
  /** The name matches no configured bot, or several. */
  | { sketchId: string; assignee: string; status: 'unresolved'; why: string }
  /** The named bot does not execute the sketch's node(s); `nodeIds` empty
   *  when no node carries the sketch's id. */
  | { sketchId: string; assignee: string; status: 'not-honoured'; larkAppId: string; nodeIds: string[]; why?: string };

/** The nodes implementing a sketch: the top-level goal node, or the loop
 *  body node, whose own id is the sketch's id (the Architect is told to keep
 *  it). Node ids may contain dots, so a top-level `code.review` is not
 *  `review`. */
function nodesForSketch(targets: readonly V3NodeExecutorTarget[], sketchId: string): V3NodeExecutorTarget[] {
  return targets.filter((target) => (target.loop ? target.loop.bodyNodeId : target.nodeId) === sketchId);
}

/** Did the frozen assignment follow every bot the user named? */
export function checkV3Assignees(input: {
  spec: Spec;
  targets: readonly V3NodeExecutorTarget[];
  bots: readonly BotConfig[];
  nameOf: (larkAppId: string) => string;
  /** Why a named bot cannot execute nodes, when known. */
  unavailableWhy?: (larkAppId: string) => string | undefined;
}): V3AssigneeCheck[] {
  return input.spec.nodes.flatMap((sketch): V3AssigneeCheck[] => {
    if (!sketch.assignee) return [];
    const base = { sketchId: sketch.sketchId, assignee: sketch.assignee };
    const target = resolveV3Assignee(sketch.assignee, input.bots, input.nameOf);
    if (target.kind === 'unknown') return [{ ...base, status: 'unresolved', why: '不是本机配置的 Bot' }];
    if (target.kind === 'ambiguous') {
      return [{ ...base, status: 'unresolved', why: `有多个 Bot 叫这个名字（${target.larkAppIds.join(', ')}），请改用 larkAppId` }];
    }
    // No corresponding node = not honoured (another node on that bot proves
    // nothing about this sketch).
    const nodes = nodesForSketch(input.targets, sketch.sketchId);
    const honoured = nodes.length > 0 && nodes.every((node) => node.larkAppId === target.larkAppId);
    if (honoured) {
      return [{ ...base, status: 'honoured', larkAppId: target.larkAppId, nodeIds: nodes.map((node) => node.nodeId) }];
    }
    const why = input.unavailableWhy?.(target.larkAppId);
    return [{
      ...base,
      status: 'not-honoured',
      larkAppId: target.larkAppId,
      nodeIds: nodes.filter((node) => node.larkAppId !== target.larkAppId).map((node) => node.nodeId),
      ...(why ? { why } : {}),
    }];
  });
}

/**
 * The Gate-2 "node → executing bot" lines of a bot run (§6.2/§6.3): bot name
 * and CLI, the Architect's reason, and a ⚠️ on every named bot that is not
 * honoured.
 */
export function formatV3Gate2BotPlan(input: {
  targets: readonly V3NodeExecutorTarget[];
  orchestratorAppId: string;
  nameOf: (larkAppId: string) => string;
  cliOf: (larkAppId: string) => string | undefined;
  reasons: ReadonlyMap<string, { bot: string; reason: string }>;
  assignees: readonly V3AssigneeCheck[];
}): string {
  const notHonouredByNode = new Map<string, Extract<V3AssigneeCheck, { status: 'not-honoured' }>>();
  for (const check of input.assignees) {
    if (check.status !== 'not-honoured') continue;
    for (const nodeId of check.nodeIds) notHonouredByNode.set(nodeId, check);
  }
  const named = (check: { assignee: string }) => `点名「${check.assignee}」`;
  const lines = ['执行方式：节点交给群里的 Bot 执行（每个节点开一个节点话题）'];
  for (const target of input.targets) {
    const name = input.nameOf(target.larkAppId);
    const cli = input.cliOf(target.larkAppId);
    const detail = [cli, target.larkAppId === input.orchestratorAppId ? '主 Bot 自己' : undefined].filter(Boolean).join('，');
    const written = input.reasons.get(target.nodeId);
    const reasonMatches = written
      && [target.larkAppId, name].some((candidate) => normalName(candidate) === normalName(written.bot));
    const missed = notHonouredByNode.get(target.nodeId);
    lines.push(
      `- ${missed ? '⚠️ ' : ''}${target.nodeId} → ${name}${detail ? `（${detail}）` : ''}` +
      (reasonMatches ? `：${written.reason}` : '') +
      (missed ? ` —— ${named(missed)}未满足${missed.why ? `：${missed.why}` : ''}` : ''),
    );
  }
  for (const check of input.assignees) {
    if (check.status === 'unresolved') {
      lines.push(`- ⚠️ ${check.sketchId}：${named(check)}未生效：${check.why}`);
    } else if (check.status === 'not-honoured' && check.nodeIds.length === 0) {
      lines.push(`- ⚠️ ${check.sketchId}：${named(check)}未满足：没有节点交给 ${input.nameOf(check.larkAppId)}${check.why ? `（${check.why}）` : ''}`);
    }
  }
  const flagged = input.assignees.filter((check) => check.status !== 'honoured').length;
  if (flagged > 0) lines.push(`⚠️ 有 ${flagged} 处点名没有满足（见上方 ⚠️），批准前请向用户说明。`);
  return lines.join('\n');
}
