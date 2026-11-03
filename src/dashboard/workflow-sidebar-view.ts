/**
 * 工作流侧边栏的服务端投影（设计 2026-11-03 §11.3 / §11.4）。
 *
 * 两种受众、两份数据，都在服务端定形，不靠前端隐藏：
 *   - 管理员：与 `GET /api/v3/runs/:id` 同一份 `RunView`（含终端 / 日志入口），外加落点链接；
 *   - 本群成员：按白名单**重新构造**的精简视图——节点名、目标、负责 Bot、状态、耗时、落点。
 *     不含终端、日志、产物、参数值、错误详情。用白名单而不是从 RunView 里删字段：以后
 *     RunView 多出任何字段，成员视图也不会跟着多出来。
 *
 * 流程版本历史要等「运行中修改流程」落地后才有数据，现在不出这一块。
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { readJournal } from '../workflows/v3/journal.js';
import { foldV3ExternalAttempts } from '../workflows/v3/external-attempt-ledger.js';
import { isValidRunId, projectRun, type RunAttemptOutcome, type RunNodeView, type RunView } from '../workflows/v3/ops-projection.js';
import { readRunEnvelope } from '../workflows/v3/run-envelope.js';
import type { V3NodeStatus } from '../workflows/v3/orchestrator.js';
import type { V3RunStatus } from '../workflows/v3/state.js';
import { chatAppLink, threadAppLink, type Brand } from '../im/lark/lark-hosts.js';

/** 成员视图里目标文字的上限：交接卡放不下全文时也只露出这么长的预览。 */
export const WORKFLOW_SIDEBAR_MEMBER_GOAL_MAX_CHARS = 600;

export interface WorkflowSidebarRun {
  runId: string;
  runDir: string;
  /** 主 Bot：run.json 冻结的 chatBinding.larkAppId。 */
  mainLarkAppId: string;
  chatId?: string;
  nodeExecutor?: 'bot';
  title: string;
}

export type WorkflowSidebarRunLookup =
  | { kind: 'ok'; run: WorkflowSidebarRun }
  | { kind: 'missing' }
  | { kind: 'invalid' };

/** 读 run 的不可变绑定（run.json）；没有绑定主 Bot 的 run 不能从侧栏入口打开。 */
export function readWorkflowSidebarRun(runsDir: string, runId: string): WorkflowSidebarRunLookup {
  if (!isValidRunId(runId)) return { kind: 'missing' };
  const root = resolve(runsDir);
  const runDir = resolve(root, runId);
  if (runDir === root || !runDir.startsWith(root + sep)) return { kind: 'missing' };
  try {
    if (!lstatSync(runDir).isDirectory()) return { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
  const read = readRunEnvelope(runDir, runId);
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind === 'invalid') return { kind: 'invalid' };
  const binding = read.envelope.chatBinding;
  const mainLarkAppId = binding?.larkAppId?.trim();
  if (!mainLarkAppId) return { kind: 'invalid' };
  let title = runId;
  try {
    const spec = JSON.parse(readFileSync(join(runDir, 'spec.json'), 'utf-8')) as { title?: unknown };
    if (typeof spec.title === 'string' && spec.title.trim()) title = spec.title.trim().slice(0, 200);
  } catch { /* display only */ }
  return {
    kind: 'ok',
    run: {
      runId,
      runDir,
      mainLarkAppId,
      ...(binding?.chatId ? { chatId: binding.chatId } : {}),
      ...('nodeExecutor' in read.envelope && read.envelope.nodeExecutor === 'bot' ? { nodeExecutor: 'bot' as const } : {}),
      title,
    },
  };
}

export interface WorkflowSidebarLanding {
  /** 节点话题（目前 bot 执行模式只有这一种落点）。 */
  placement: 'topic' | 'main';
  /** 打开落点：知道话题 id 时直达话题，否则打开所在群。 */
  url?: string;
  /** 交接消息发出的时间，方便在群里找到它。 */
  handoffAt?: number;
}

/** 每个节点（含循环体实例）最近一次交接的落点。 */
function readLandings(run: WorkflowSidebarRun, brand: Brand): Map<string, WorkflowSidebarLanding> {
  const out = new Map<string, WorkflowSidebarLanding>();
  if (run.nodeExecutor !== 'bot' || !run.chatId) return out;
  const journalPath = join(run.runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return out;
  let attempts: ReturnType<typeof foldV3ExternalAttempts>;
  try {
    attempts = foldV3ExternalAttempts(readJournal(journalPath));
  } catch {
    return out;
  }
  for (const attempt of attempts.values()) {
    if (attempt.phase === 'dispatched') continue;
    // RunView keys nodes (and loop-body instances) by the dispatch nodeId; in
    // journal order, so the latest handoff wins.
    out.set(attempt.nodeId, {
      placement: attempt.placement === 'main' ? 'main' : 'topic',
      url: attempt.threadId ? threadAppLink(run.chatId, attempt.threadId, brand) : chatAppLink(run.chatId, brand),
      ...(attempt.sentAt !== undefined ? { handoffAt: attempt.sentAt } : {}),
    });
  }
  return out;
}

export interface WorkflowSidebarRunMeta {
  runId: string;
  title: string;
  /** The app id is for admins only; members get the display name. */
  mainBot: { larkAppId?: string; name?: string };
  /** 打开 run 所在的群。 */
  chatUrl?: string;
}

export interface WorkflowSidebarAdminPayload {
  ok: true;
  audience: 'admin';
  run: WorkflowSidebarRunMeta;
  view: RunView;
  landings: Record<string, WorkflowSidebarLanding>;
}

export interface WorkflowSidebarMemberNode {
  id: string;
  status: V3NodeStatus;
  depends: string[];
  goal?: string;
  bot?: { name?: string; cliId?: string };
  host?: { executor: string };
  startedAt?: number;
  endedAt?: number;
  gateSince?: number;
  attempts: Array<{ startedAt: number; endedAt?: number; outcome?: RunAttemptOutcome }>;
  isLoop?: true;
  loop?: { loopId: string; iteration: number; bodyNodeId: string };
  loopState?: {
    iteration: number;
    maxIterations?: number;
    granted: number;
    lastDecision?: 'exit' | 'continue' | 'exhausted';
    decisions: Array<{ iteration: number; decision: 'exit' | 'continue' | 'exhausted' }>;
    bodyTemplate: Array<{ id: string; depends: string[] }>;
  };
  landing?: WorkflowSidebarLanding;
}

export interface WorkflowSidebarMemberView {
  runId: string;
  runStatus: V3RunStatus;
  nodes: WorkflowSidebarMemberNode[];
  generatedAt: number;
}

export interface WorkflowSidebarMemberPayload {
  ok: true;
  audience: 'member';
  run: WorkflowSidebarRunMeta;
  view: WorkflowSidebarMemberView;
}

export interface WorkflowSidebarProjectOptions {
  brand: Brand;
  botName?: (larkAppId: string) => string | undefined;
  now?: () => number;
}

function runMeta(run: WorkflowSidebarRun, opts: WorkflowSidebarProjectOptions, audience: 'admin' | 'member'): WorkflowSidebarRunMeta {
  const name = opts.botName?.(run.mainLarkAppId);
  return {
    runId: run.runId,
    title: run.title,
    mainBot: { ...(audience === 'admin' ? { larkAppId: run.mainLarkAppId } : {}), ...(name ? { name } : {}) },
    ...(run.chatId ? { chatUrl: chatAppLink(run.chatId, opts.brand) } : {}),
  };
}

function clipGoal(goal: string): string {
  const chars = Array.from(goal.trim());
  return chars.length <= WORKFLOW_SIDEBAR_MEMBER_GOAL_MAX_CHARS
    ? chars.join('')
    : `${chars.slice(0, WORKFLOW_SIDEBAR_MEMBER_GOAL_MAX_CHARS).join('')}…`;
}

/** 管理员视图：完整 RunView（同 Dashboard 详情页）+ 落点。 */
export function projectWorkflowSidebarAdmin(
  run: WorkflowSidebarRun,
  opts: WorkflowSidebarProjectOptions,
): WorkflowSidebarAdminPayload {
  const view = projectRun(run.runId, run.runDir, { botName: opts.botName, now: opts.now });
  return {
    ok: true,
    audience: 'admin',
    run: runMeta(run, opts, 'admin'),
    view,
    landings: Object.fromEntries(readLandings(run, opts.brand)),
  };
}

/**
 * 成员视图：逐字段白名单。目标只给已经交接过的节点（交接卡里本来就发过），并截到交接卡
 * 预览的长度；未开始的节点只显示名字和状态。
 */
export function projectWorkflowSidebarMember(
  run: WorkflowSidebarRun,
  opts: WorkflowSidebarProjectOptions,
): WorkflowSidebarMemberPayload {
  const full = projectRun(run.runId, run.runDir, { botName: opts.botName, now: opts.now });
  const landings = readLandings(run, opts.brand);
  const nodes = full.nodes.map((node: RunNodeView): WorkflowSidebarMemberNode => {
    const landing = landings.get(node.id);
    const handedOff = landing !== undefined;
    return {
      id: node.id,
      status: node.status,
      depends: [...node.depends],
      ...(handedOff && node.goal ? { goal: clipGoal(node.goal) } : {}),
      ...(node.bot && (node.bot.name || node.bot.cliId) ? {
        bot: {
          ...(node.bot.name ? { name: node.bot.name } : {}),
          ...(node.bot.cliId ? { cliId: node.bot.cliId } : {}),
        },
      } : {}),
      ...(node.host ? { host: { executor: node.host.executor } } : {}),
      ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
      ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
      ...(node.gateSince !== undefined ? { gateSince: node.gateSince } : {}),
      attempts: node.attempts.map((attempt) => ({
        startedAt: attempt.startedAt,
        ...(attempt.endedAt !== undefined ? { endedAt: attempt.endedAt } : {}),
        ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
      })),
      ...(node.isLoop ? { isLoop: true as const } : {}),
      ...(node.loop ? { loop: { loopId: node.loop.loopId, iteration: node.loop.iteration, bodyNodeId: node.loop.bodyNodeId } } : {}),
      ...(node.loopState ? {
        loopState: {
          iteration: node.loopState.iteration,
          ...(node.loopState.maxIterations !== undefined ? { maxIterations: node.loopState.maxIterations } : {}),
          granted: node.loopState.granted,
          ...(node.loopState.lastDecision ? { lastDecision: node.loopState.lastDecision } : {}),
          decisions: node.loopState.decisions.map((d) => ({ iteration: d.iteration, decision: d.decision })),
          bodyTemplate: node.loopState.bodyTemplate.map((t) => ({ id: t.id, depends: [...t.depends] })),
        },
      } : {}),
      ...(landing ? { landing } : {}),
    };
  });
  return {
    ok: true,
    audience: 'member',
    run: runMeta(run, opts, 'member'),
    view: { runId: full.runId, runStatus: full.runStatus, nodes, generatedAt: full.generatedAt },
  };
}
