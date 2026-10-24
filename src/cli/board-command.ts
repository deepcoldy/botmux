/**
 * `botmux board …`：管家写决策看板的 CLI。只在管家 bot 的会话里可用；请求经会话鉴权 IPC
 * 发给本 bot 的 daemon（看板唯一写入方）。选项和关联原样传 spec 字符串，由 daemon 统一解析，
 * 两边的报错口径一致。
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { DASHBOARD_IMAGE_MAX_BYTES } from '../core/dashboard-images.js';

export const BOARD_CLI_USAGE = `botmux board — 决策看板（只在管家 bot 的会话里可用）

用法:
  botmux board guide                                    打印管家规则（预置 + owner 自定义）
  botmux board list [--view decide|active|all] [--json] 列事项（默认 all），每行带飞书里打开的链接
  botmux board show <编号|key> [--json]                  一项的全部字段、关联、最近历史、未执行的决定
  botmux board add <标题> [字段…]                        新建；带 --key 且已存在时按 set 更新
  botmux board set <编号|key> [字段…] [--clear-ask]      改字段；改状态和待拍板内容会自动进历史
  botmux board history <编号|key> <一句话> [--handled]   追加历史；--handled = 这项最近一批决定已执行
  botmux board attach <编号|key> <图片>... [--note 说明] 附截图（png / jpg / gif / webp）
  botmux board pending [--json]                         owner 已提交、还没标记执行的决定

字段:
  --key <去重键>          如 pr:owner/repo#12；同 key 重复 add 不会重复建
  --state <状态>          decide 待拍板 | accept 待验收 | active 进行中 | waiting 等待中 | done 已完成 | closed 已关闭
  --stage <阶段>          自由文本，如 在审 / 在修 / 可合 / 等作者
  --kind <类型>  --repo <仓库>  --summary <一句话>  --progress <当前进展>
  --ask <要 owner 定的问题>
  --option "A=做法 → 结果和风险"   可重复；给 --option 就整组替换原有选项
  --recommend <选项键>  --reason <推荐理由>
  --link kind=ref[|标签]  可重复：pr=owner/repo#12 | issue=owner/repo#3 | commit=owner/repo@sha
                          | chat=oc_… | thread=oc_…/omt_… | session=<会话id> | doc=https://… | url=https://…
  --note <一句话>         同时往历史里记一句
  --title <新标题>        仅 set

编号写 12 或 #12 都行。所有子命令加 --json 输出完整 JSON。`;

const VALUE_FLAGS = new Set([
  '--view', '--key', '--state', '--stage', '--kind', '--repo', '--summary', '--progress', '--ask',
  '--option', '--recommend', '--reason', '--link', '--note', '--title', '--session-id',
]);
const BOOL_FLAGS = new Set(['--json', '--handled', '--clear-ask', '--help', '-h']);

/** 字段 flag → daemon 侧 patch 字段名。 */
const FIELD_FLAGS: Record<string, string> = {
  '--key': 'key', '--state': 'state', '--stage': 'stage', '--kind': 'kind', '--repo': 'repo',
  '--summary': 'summary', '--progress': 'progress', '--ask': 'question', '--recommend': 'recommend',
  '--reason': 'recommendReason', '--note': 'note', '--title': 'title',
};

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export const BOARD_ACTIONS = ['guide', 'list', 'show', 'add', 'set', 'history', 'attach', 'pending'] as const;
export type BoardAction = typeof BOARD_ACTIONS[number];

export interface ParsedBoardCli {
  action: BoardAction;
  json: boolean;
  sessionId?: string;
  /** 发给 daemon 的请求体（attach 的图片在 {@link readBoardAttachFiles} 里补上）。 */
  request: Record<string, unknown>;
  attachPaths: string[];
}

interface Tokens { flags: Map<string, string[]>; bools: Set<string>; positionals: string[] }

function tokenize(args: string[]): Tokens | { error: string } {
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (BOOL_FLAGS.has(name)) { bools.add(name); continue; }
      if (!VALUE_FLAGS.has(name)) return { error: `未知参数: ${name}` };
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined) return { error: `${name} 缺少值` };
      flags.set(name, [...(flags.get(name) ?? []), value]);
      continue;
    }
    positionals.push(arg);
  }
  return { flags, bools, positionals };
}

export function parseBoardArgs(argv: string[]): { ok: true; help: true } | { ok: true; help?: false; parsed: ParsedBoardCli } | { ok: false; error: string } {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') return { ok: true, help: true };
  if (!(BOARD_ACTIONS as readonly string[]).includes(sub)) return { ok: false, error: `不认识的子命令: ${sub}` };
  const action = sub as BoardAction;
  const t = tokenize(rest);
  if ('error' in t) return { ok: false, error: t.error };
  if (t.bools.has('--help') || t.bools.has('-h')) return { ok: true, help: true };
  const single = (flag: string): string | undefined => {
    const values = t.flags.get(flag);
    return values?.length ? values[values.length - 1] : undefined;
  };
  const request: Record<string, unknown> = { action };
  const attachPaths: string[] = [];
  const pos = t.positionals;
  const fieldsFromFlags = () => {
    const fields: Record<string, string> = {};
    for (const [flag, field] of Object.entries(FIELD_FLAGS)) {
      const v = single(flag);
      if (v !== undefined) fields[field] = v;
    }
    return fields;
  };
  const allowOnly = (allowed: string[]): string | undefined => {
    for (const flag of t.flags.keys()) if (!allowed.includes(flag)) return `${action} 不支持 ${flag}`;
    return undefined;
  };
  switch (action) {
    case 'guide':
    case 'pending': {
      const bad = allowOnly(['--session-id']);
      if (bad) return { ok: false, error: bad };
      if (pos.length) return { ok: false, error: `${action} 不接受位置参数` };
      break;
    }
    case 'list': {
      const bad = allowOnly(['--view', '--session-id']);
      if (bad) return { ok: false, error: bad };
      const view = single('--view');
      if (view && !['decide', 'active', 'all'].includes(view)) return { ok: false, error: '--view 只能是 decide / active / all' };
      if (view) request.view = view;
      break;
    }
    case 'show': {
      const bad = allowOnly(['--session-id']);
      if (bad) return { ok: false, error: bad };
      if (pos.length !== 1) return { ok: false, error: '用法: botmux board show <编号|key>' };
      request.ref = pos[0];
      break;
    }
    case 'add':
    case 'set': {
      if (action === 'add') {
        if (pos.length !== 1) return { ok: false, error: '用法: botmux board add <标题> [字段…]（标题含空格请加引号）' };
        request.title = pos[0];
        if (t.flags.has('--title')) return { ok: false, error: 'add 的标题写在位置参数里，不用 --title' };
        if (t.bools.has('--clear-ask')) return { ok: false, error: 'add 不支持 --clear-ask' };
      } else {
        if (pos.length !== 1) return { ok: false, error: '用法: botmux board set <编号|key> [字段…]' };
        request.ref = pos[0];
        if (t.bools.has('--clear-ask')) request.clearAsk = true;
      }
      if (t.flags.has('--view')) return { ok: false, error: `${action} 不支持 --view` };
      request.fields = fieldsFromFlags();
      if (t.flags.get('--option')?.length) request.options = t.flags.get('--option');
      if (t.flags.get('--link')?.length) request.links = t.flags.get('--link');
      if (action === 'set' && Object.keys(request.fields as object).length === 0 && !request.options && !request.links && !request.clearAsk) {
        return { ok: false, error: 'set 至少要改一个字段' };
      }
      break;
    }
    case 'history': {
      const bad = allowOnly(['--session-id']);
      if (bad) return { ok: false, error: bad };
      if (pos.length < 2) return { ok: false, error: '用法: botmux board history <编号|key> <一句话> [--handled]' };
      request.ref = pos[0];
      request.text = pos.slice(1).join(' ');
      if (t.bools.has('--handled')) request.handled = true;
      break;
    }
    case 'attach': {
      const bad = allowOnly(['--note', '--session-id']);
      if (bad) return { ok: false, error: bad };
      if (pos.length < 2) return { ok: false, error: '用法: botmux board attach <编号|key> <图片>... [--note 说明]' };
      request.ref = pos[0];
      attachPaths.push(...pos.slice(1));
      const note = single('--note');
      if (note) request.note = note;
      break;
    }
  }
  if (t.bools.has('--handled') && action !== 'history') return { ok: false, error: `${action} 不支持 --handled` };
  if (t.bools.has('--clear-ask') && action !== 'set') return { ok: false, error: `${action} 不支持 --clear-ask` };
  const sessionId = single('--session-id');
  return {
    ok: true,
    parsed: { action, json: t.bools.has('--json'), ...(sessionId ? { sessionId } : {}), request, attachPaths },
  };
}

/** 读截图文件 → `{name, mimeType, dataBase64}`；只认扩展名，文件头由 daemon 再验一次。 */
export function readBoardAttachFiles(paths: string[], read: (p: string) => Buffer = p => readFileSync(p),
  size: (p: string) => number = p => statSync(p).size): { ok: true; files: Array<{ name: string; mimeType: string; dataBase64: string }> } | { ok: false; error: string } {
  const files: Array<{ name: string; mimeType: string; dataBase64: string }> = [];
  for (const p of paths) {
    const mimeType = IMAGE_MIME[extname(p).toLowerCase()];
    if (!mimeType) return { ok: false, error: `只支持 png / jpg / gif / webp：${p}` };
    let bytes: number;
    try { bytes = size(p); } catch { return { ok: false, error: `读不到文件：${p}` }; }
    if (bytes > DASHBOARD_IMAGE_MAX_BYTES) return { ok: false, error: `图片超过 10MB：${p}` };
    files.push({ name: basename(p), mimeType, dataBase64: read(p).toString('base64') });
  }
  return { ok: true, files };
}

interface ListItem { seq: number; title: string; stateLabel?: string; stage?: string; pendingDecisions?: number; appLink?: string; url?: string }

/** 给人（和模型）读的输出；--json 时调用方直接打印原始 JSON。 */
export function formatBoardResult(action: BoardAction, body: Record<string, unknown>): string {
  const linkOf = (o: { appLink?: string; url?: string }) => o.appLink ?? o.url ?? '';
  switch (action) {
    case 'guide':
      return String(body.guide ?? '');
    case 'list': {
      const items = (body.items ?? []) as ListItem[];
      const counts = body.counts as { decide?: number; active?: number; all?: number } | undefined;
      const head = counts ? `待你拍板 ${counts.decide ?? 0} · 进行中 ${counts.active ?? 0} · 全部 ${counts.all ?? 0}` : '';
      if (!items.length) return [head, '（没有事项）'].filter(Boolean).join('\n');
      return [head, ...items.map(i => {
        const pending = i.pendingDecisions ? ` ⏳${i.pendingDecisions} 个决定待执行` : '';
        const link = linkOf(i);
        return `#${i.seq} ${i.stateLabel ?? ''}${i.stage ? `·${i.stage}` : ''} ${i.title}${pending}${link ? `  ${link}` : ''}`;
      })].filter(Boolean).join('\n');
    }
    case 'add':
    case 'set': {
      const item = body.item as ListItem | undefined;
      if (!item) return JSON.stringify(body);
      const verb = action === 'add' ? (body.created === false ? '已存在，已更新' : '已创建') : '已更新';
      const link = linkOf(item);
      return `#${item.seq} ${verb}：${item.title}（${item.stateLabel ?? ''}${item.stage ? `·${item.stage}` : ''}）${link ? `\n${link}` : ''}`;
    }
    case 'history': {
      const handled = Number(body.handledDecisions ?? 0);
      return `#${body.seq} 已记入历史${handled ? `，标记 ${handled} 个决定已执行` : ''}`;
    }
    case 'attach': {
      const files = (body.files ?? []) as unknown[];
      return `#${body.seq} 已附 ${files.length} 张图`;
    }
    case 'pending': {
      const decisions = (body.decisions ?? []) as Array<{ batchId: number; seq: number; title: string; choice?: string; choiceLabel?: string; text: string; images: number; itemChangedSinceDecision?: boolean }>;
      if (!decisions.length) return '没有待执行的决定';
      return decisions.map(d => {
        const lines = [`批次 #${d.batchId} · #${d.seq} ${d.title}`];
        lines.push(`  选：${d.choice ? `${d.choice}${d.choiceLabel ? ` ${d.choiceLabel}` : ''}` : '未选'}`);
        if (d.text.trim()) lines.push(`  说明：${d.text.trim().split('\n').join('\n    ')}`);
        if (d.images) lines.push(`  附图：${d.images} 张（随批次消息附上）`);
        if (d.itemChangedSinceDecision) lines.push('  注意：owner 提交后这项又被改过，执行前先 show 看最新内容');
        return lines.join('\n');
      }).join('\n');
    }
    case 'show':
    default:
      return JSON.stringify(body, null, 2);
  }
}
