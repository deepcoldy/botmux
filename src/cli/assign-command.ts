/**
 * `botmux assign` CLI 参数解析与人类可读格式化（纯函数，无副作用）。
 *
 * 子命令：
 *   botmux assign status [--json]
 *   botmux assign recommend --task "..." [--task-file <path>] [--prefer/--only/--exclude ...] [--no-llm] [--json]
 *   botmux assign run --task "..." [--task-file <path>] [--title "..."] [--mode group|topic]
 *                     [--chat-id <oc_...>] [--working-dir <path>]
 *                     [--prefer/--only/--exclude ...] [--reason "..."] [--no-llm] [--session-id <id>] [--json]
 *   botmux assign history [--limit N] [--bot <ref>] [--json]
 */

import {
  costTierLabelZh,
  exclusionCodeLabelZh,
  type CandidateEvaluation,
  type TaskRoutingDecision,
  type TaskRoutingDispatchMode,
  type TaskRoutingRecord,
} from '../core/task-routing/model.js';

export type AssignSubcommand = 'status' | 'recommend' | 'run' | 'history';

export interface ParsedAssignArgs {
  subcommand: AssignSubcommand;
  help: boolean;
  json: boolean;
  noLlm: boolean;
  task?: string;
  taskFile?: string;
  title?: string;
  mode: TaskRoutingDispatchMode;
  chatId?: string;
  workingDir?: string;
  prefer?: string;
  only: string[];
  exclude: string[];
  reason?: string;
  sessionId?: string;
  limit: number;
  botFilter?: string;
}

export type AssignArgsParseResult =
  | { ok: true; value: ParsedAssignArgs }
  | { ok: false; error: string };

export const ASSIGN_HELP_TEXT = `botmux assign — 智能任务分配（结合画像、实时状态与兜底链为任务挑选并派发 Bot）

用法:
  botmux assign status [--json]
      查看所有本机 Bot 的分配画像与实时状态（含参与池与被排除原因）

  botmux assign recommend --task "<任务描述>" [--task-file <path>]
                          [--prefer <bot>] [--only <bot>...] [--exclude <bot>...]
                          [--no-llm] [--json]
      只出选人建议、兜底顺序与理由（零副作用，不建群、不派发）

  botmux assign run --task "<任务描述>" [--task-file <path>]
                    [--title "<标题>"]
                    [--mode group|topic] [--chat-id <oc_...>] [--working-dir <path>]
                    [--prefer <bot>] [--only <bot>...] [--exclude <bot>...]
                    [--reason "<理由>"] [--no-llm] [--session-id <id>] [--json]
      选人并直接派发；首选不可用或启动失败时按候选链自动兜底，记录完整理由与换人过程。
      高权限动作：仅允许 owner 本人发起的回合、管家会话或本机 CLI 直接调用。

  botmux assign history [--limit <N>] [--bot <ref>] [--json]
      查看最近的分配记录、排除原因与兜底链路

说明:
  - 默认关闭：需先在 Dashboard 设置开启全局「Bot 任务分配」，并在目标 Bot 配置中开启「参与自动任务分配」
    （也可在配置文件中设置 taskRouting.enabled=true；管家与 apiOnly 默认排除）。
  - --mode group（默认）：在目标 Bot 上新建任务群并直接开工（复用 Bot 的 autoWorktree）。
  - --mode topic：在已有群内委派给 botmux dispatch 开子话题派发。
  - <bot> 引用支持 larkAppId、显示名或唯一 CLI 名；重名时请用 larkAppId。
`;

function takeValue(argv: readonly string[], idx: number, flag: string, eqValue?: string): { ok: true; value: string; nextIdx: number } | { ok: false; error: string } {
  const val = eqValue !== undefined ? eqValue : argv[idx + 1];
  if (val === undefined || val === '') {
    return { ok: false, error: `${flag} 需要一个非空值` };
  }
  return { ok: true, value: val, nextIdx: eqValue !== undefined ? idx : idx + 1 };
}

export function parseAssignArgs(argv: readonly string[]): AssignArgsParseResult {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    return {
      ok: true,
      value: {
        subcommand: 'status',
        help: true,
        json: false,
        noLlm: false,
        mode: 'group',
        only: [],
        exclude: [],
        limit: 20,
      },
    };
  }

  const rawSub = argv[0]!;
  if (rawSub !== 'status' && rawSub !== 'recommend' && rawSub !== 'run' && rawSub !== 'history') {
    return { ok: false, error: `未知子命令：${rawSub}（支持 status | recommend | run | history）` };
  }

  const out: ParsedAssignArgs = {
    subcommand: rawSub,
    help: false,
    json: false,
    noLlm: false,
    mode: 'group',
    only: [],
    exclude: [],
    limit: 20,
  };

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    out.help = true;
    return { ok: true, value: out };
  }

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    const eq = token.indexOf('=');
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    const eqVal = eq >= 0 ? token.slice(eq + 1) : undefined;

    if (flag === '--json' && eq < 0) { out.json = true; continue; }
    if (flag === '--no-llm' && eq < 0) { out.noLlm = true; continue; }

    if (flag === '--task') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.task = r.value; i = r.nextIdx; continue;
    }
    if (flag === '--task-file') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.taskFile = r.value; i = r.nextIdx; continue;
    }
    if (flag === '--title') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.title = r.value; i = r.nextIdx; continue;
    }
    if (flag === '--mode') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      const m = r.value.trim().toLowerCase();
      if (m !== 'group' && m !== 'topic') {
        return { ok: false, error: `--mode 只支持 group 或 topic，收到：${r.value}` };
      }
      out.mode = m; i = r.nextIdx; continue;
    }
    if (flag === '--chat-id') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.chatId = r.value.trim(); i = r.nextIdx; continue;
    }
    if (flag === '--working-dir' || flag === '--cwd' || flag === '--dir') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.workingDir = r.value.trim(); i = r.nextIdx; continue;
    }
    if (flag === '--prefer') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.prefer = r.value.trim(); i = r.nextIdx; continue;
    }
    if (flag === '--only') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.only.push(r.value.trim()); i = r.nextIdx; continue;
    }
    if (flag === '--exclude') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.exclude.push(r.value.trim()); i = r.nextIdx; continue;
    }
    if (flag === '--reason') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.reason = r.value.trim(); i = r.nextIdx; continue;
    }
    if (flag === '--session-id') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.sessionId = r.value.trim(); i = r.nextIdx; continue;
    }
    if (flag === '--limit') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      const n = Number(r.value);
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        return { ok: false, error: '--limit 必须是 1..200 的整数' };
      }
      out.limit = n; i = r.nextIdx; continue;
    }
    if (flag === '--bot') {
      const r = takeValue(rest, i, flag, eqVal);
      if (!r.ok) return r;
      out.botFilter = r.value.trim(); i = r.nextIdx; continue;
    }

    return { ok: false, error: `未知参数：${token}` };
  }

  // Subcommand-specific checks
  if ((out.subcommand === 'recommend' || out.subcommand === 'run') && !out.task && !out.taskFile) {
    return { ok: false, error: `${out.subcommand} 需要提供 --task "<描述>" 或 --task-file <路径>` };
  }
  if (out.task && out.taskFile) {
    return { ok: false, error: '--task 与 --task-file 不能同时指定' };
  }
  if (out.subcommand !== 'run' && (out.title || out.workingDir || out.chatId || out.reason)) {
    return { ok: false, error: `--title/--working-dir/--chat-id/--reason 仅用于 assign run` };
  }
  if (out.subcommand !== 'history' && out.botFilter) {
    return { ok: false, error: '--bot 仅用于 assign history 过滤' };
  }

  return { ok: true, value: out };
}

// ─── Human-Readable Formatters ───────────────────────────────────────────────

function formatCandidateLine(c: CandidateEvaluation, idx?: number): string {
  const prefix = idx !== undefined ? `${idx + 1}. ` : '· ';
  const tier = costTierLabelZh(c.costTier);
  const model = c.model ? `/${c.model}` : '';
  const status = c.eligible
    ? c.runtimeSummary
    : `${exclusionCodeLabelZh(c.exclusionCode ?? 'offline')}（${c.exclusionReason ?? c.runtimeSummary}）`;
  const head = `${prefix}${c.name} [${c.larkAppId}] (${c.cliId}${model} · ${tier}档) — ${status}`;
  const notes: string[] = [];
  if (c.strengths) notes.push(`   擅长：${c.strengths}`);
  if (c.limitations) notes.push(`   限制：${c.limitations}`);
  return [head, ...notes].join('\n');
}

export function formatAssignStatus(input: {
  enabled: boolean;
  matcherMode: string;
  matcherBotAppId?: string;
  policy?: string;
  eligible: readonly CandidateEvaluation[];
  excluded: readonly CandidateEvaluation[];
}): string {
  const lines: string[] = [
    `任务分配状态：${input.enabled ? '已开启' : '已关闭'} | 裁判模式：${input.matcherMode}${input.matcherBotAppId ? ` (${input.matcherBotAppId})` : ''}`,
  ];
  if (input.policy) lines.push(`全局原则：${input.policy}`);

  lines.push('', `可用候选（${input.eligible.length}）：`);
  if (input.eligible.length === 0) {
    lines.push('  （无可用候选）');
  } else {
    input.eligible.forEach((c, i) => lines.push(formatCandidateLine(c, i)));
  }

  lines.push('', `已排除 / 未参与（${input.excluded.length}）：`);
  if (input.excluded.length === 0) {
    lines.push('  （无）');
  } else {
    input.excluded.forEach(c => lines.push(formatCandidateLine(c)));
  }
  return lines.join('\n');
}

export function formatAssignRecommend(decision: TaskRoutingDecision): string {
  const lines: string[] = [];
  if (decision.selectedAppId) {
    lines.push(`推荐 Bot：${decision.selectedName} [${decision.selectedAppId}]`);
    lines.push(`匹配方式：${decision.matcherKind} | 信心：${decision.confidence}`);
    lines.push(`理由：${decision.reason}`);
    if (decision.fallbackOrder.length > 1) {
      const names = decision.fallbackOrder.map(id => {
        const hit = decision.candidates.find(c => c.larkAppId === id);
        return hit ? `${hit.name}(${id})` : id;
      });
      lines.push(`兜底顺序：${names.join(' → ')}`);
    }
  } else {
    lines.push(`无可用推荐 Bot：${decision.reason}`);
  }

  if (decision.candidates.length > 0) {
    lines.push('', `候选列表（${decision.candidates.length}）：`);
    decision.candidates.forEach((c, i) => lines.push(formatCandidateLine(c, i)));
  }
  if (decision.excluded.length > 0) {
    lines.push('', `已排除（${decision.excluded.length}）：`);
    decision.excluded.forEach(c => lines.push(formatCandidateLine(c)));
  }
  return lines.join('\n');
}

export function formatAssignRun(result: {
  ok: boolean;
  record: TaskRoutingRecord;
  chatId?: string;
  sessionId?: string;
  rootMessageId?: string;
  shareLink?: string | null;
  error?: string;
  settlementWarning?: string;
}): string {
  const r = result.record;
  const lines: string[] = [
    result.ok
      ? `✅ 已派发给 ${r.selectedName ?? r.selectedAppId} [${r.selectedAppId}]（记录 ${r.id}，模式 ${r.mode}）`
      : `❌ 派发失败（记录 ${r.id}）：${result.error ?? r.error ?? '未知错误'}`,
    `匹配方式：${r.matcherKind} | 信心：${r.confidence}`,
    `理由：${r.reason}`,
  ];
  if (result.chatId) lines.push(`目标群：${result.chatId}${result.shareLink ? ` (${result.shareLink})` : ''}`);
  if (result.settlementWarning) lines.push(`⚠️ ${result.settlementWarning}`);
  if (result.sessionId) lines.push(`目标会话：${result.sessionId}`);
  if (result.rootMessageId) lines.push(`目标话题根：${result.rootMessageId}`);
  if (r.attempts.length > 0) {
    lines.push('执行链路：');
    for (const a of r.attempts) {
      lines.push(`  - [${a.outcome}] ${a.name} (${a.appId})：${a.reason}`);
    }
  }
  if (r.excluded.length > 0) {
    lines.push('排除候选：');
    for (const ex of r.excluded) {
      lines.push(`  - ${ex.name} (${ex.larkAppId})：${exclusionCodeLabelZh(ex.exclusionCode ?? 'offline')} — ${ex.exclusionReason ?? ''}`);
    }
  }
  return lines.join('\n');
}

export function formatAssignHistory(records: readonly TaskRoutingRecord[]): string {
  if (records.length === 0) return '暂无任务分配记录。';
  const lines: string[] = [`最近 ${records.length} 条任务分配记录：`];
  for (const r of records) {
    const time = new Date(r.createdAt).toISOString().replace('T', ' ').slice(0, 19);
    const target = r.selectedName ? `${r.selectedName}(${r.selectedAppId})` : '无';
    const switched = r.attempts.filter(a => a.outcome !== 'dispatched').length;
    const switchNote = switched > 0 ? `（兜底切换 ${switched} 次）` : '';
    lines.push(`- [${time}] ${r.id} | ${r.outcome}${switchNote} | ${r.mode} → ${target}`);
    lines.push(`  任务：${r.taskSummary}`);
    lines.push(`  理由：${r.reason}`);
    if (r.targetChatId) lines.push(`  落点：chat=${r.targetChatId}${r.targetSessionId ? ` session=${r.targetSessionId}` : ''}`);
    if (r.attempts.length > 1) {
      const chain = r.attempts.map(a => `${a.name}:${a.outcome}(${a.reason})`).join(' → ');
      lines.push(`  尝试链：${chain}`);
    }
  }
  return lines.join('\n');
}
