/**
 * `/flow …` 话题命令的纯解析器（M2 触发绑定）。daemon 在两处（新话题 / thread 内）调用，
 * 解析结果交给 FlowRunManager；这里不碰 IO。
 *
 *   /flow run <script.mjs> [--input <json>] [--concurrency N] [--max-duration-min N]
 *   /flow ls
 *   /flow inspect <runId>
 *   /flow resume <runId>
 *   /flow cancel <runId>
 *   /flow signal <runId> <identity> <json>
 *   /flow help
 */

export type FlowSlashCommand =
  | { kind: 'run'; script: string; input: unknown; concurrency?: number; maxDurationMin?: number }
  | { kind: 'ls' }
  | { kind: 'inspect'; runId: string }
  | { kind: 'resume'; runId: string }
  | { kind: 'cancel'; runId: string }
  | { kind: 'signal'; runId: string; identity: string; value: unknown }
  | { kind: 'help' }
  | { kind: 'invalid'; error: string };

export const FLOW_USAGE = [
  '用法：',
  '/flow run <脚本.mjs> [--input <json>] [--concurrency N] [--max-duration-min N]',
  '    脚本路径相对本话题工作目录；进度、决策、信号卡都发在本话题里',
  '/flow ls                      本机器人的 run 列表',
  '/flow inspect <runId>         run 详情',
  '/flow resume <runId>          恢复已中断的 run',
  '/flow cancel <runId>          取消（运行中或已中断的）run',
  '/flow signal <runId> <identity> <json>   终端式提交信号（卡片投递失败时用）',
].join('\n');

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 只认 `/flow` 开头（大小写不敏感）；不是本命令返回 null。 */
export function parseFlowSlashCommand(content: string): FlowSlashCommand | null {
  const trimmed = content.trim();
  const m = /^\/flow(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  if (rest.length === 0) return { kind: 'help' };
  const tokens = tokenize(rest);
  const verb = (tokens[0] ?? '').toLowerCase();
  switch (verb) {
    case 'help':
    case '--help':
      return { kind: 'help' };
    case 'ls':
    case 'list':
      return { kind: 'ls' };
    case 'inspect':
    case 'show':
    case 'status': {
      const runId = tokens[1];
      if (!runId || !RUN_ID_RE.test(runId)) return { kind: 'invalid', error: 'inspect 需要 <runId>' };
      return { kind: 'inspect', runId };
    }
    case 'resume': {
      const runId = tokens[1];
      if (!runId || !RUN_ID_RE.test(runId)) return { kind: 'invalid', error: 'resume 需要 <runId>' };
      return { kind: 'resume', runId };
    }
    case 'cancel': {
      const runId = tokens[1];
      if (!runId || !RUN_ID_RE.test(runId)) return { kind: 'invalid', error: 'cancel 需要 <runId>' };
      return { kind: 'cancel', runId };
    }
    case 'signal': {
      const runId = tokens[1];
      const identity = tokens[2];
      if (!runId || !RUN_ID_RE.test(runId) || !identity) return { kind: 'invalid', error: 'signal 需要 <runId> <identity> <json>' };
      const jsonText = restAfter(rest, 3);
      if (!jsonText) return { kind: 'invalid', error: 'signal 需要 JSON 载荷' };
      try {
        return { kind: 'signal', runId, identity, value: JSON.parse(jsonText) as unknown };
      } catch {
        return { kind: 'invalid', error: '载荷不是合法 JSON' };
      }
    }
    case 'run': {
      const script = tokens[1];
      if (!script || script.startsWith('--')) return { kind: 'invalid', error: 'run 需要 <脚本路径>' };
      if (script.includes('\0')) return { kind: 'invalid', error: '脚本路径非法' };
      const out: Extract<FlowSlashCommand, { kind: 'run' }> = { kind: 'run', script, input: null };
      for (let i = 2; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok === '--input') {
          // JSON 里可能有空格：取 --input 之后到行尾（或下一个 -- 选项前）的原文
          const text = restAfterFlag(rest, '--input');
          if (text === null) return { kind: 'invalid', error: '--input 需要 JSON' };
          try {
            out.input = JSON.parse(text) as unknown;
          } catch {
            return { kind: 'invalid', error: '--input 不是合法 JSON' };
          }
          break; // --input 吃掉行尾；其它选项须放在它前面
        }
        if (tok === '--concurrency') {
          const n = Number(tokens[++i]);
          if (!Number.isInteger(n) || n < 1 || n > 16) return { kind: 'invalid', error: '--concurrency 需要 1–16 的整数' };
          out.concurrency = n;
          continue;
        }
        if (tok === '--max-duration-min') {
          const n = Number(tokens[++i]);
          if (!Number.isFinite(n) || n <= 0) return { kind: 'invalid', error: '--max-duration-min 需要正数' };
          out.maxDurationMin = n;
          continue;
        }
        return { kind: 'invalid', error: `未知选项 ${tok}` };
      }
      return out;
    }
    default:
      return { kind: 'invalid', error: `未知子命令 ${verb}` };
  }
}

/** shell 风格分词：支持单/双引号。 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur.length > 0) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur.length > 0) out.push(cur);
  return out;
}

/** 第 n 个空白分隔 token 之后的原文（保留 JSON 里的空格与引号）。 */
function restAfter(s: string, n: number): string | null {
  let i = 0;
  let count = 0;
  while (count < n) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) return null;
    while (i < s.length && !/\s/.test(s[i]!)) i++;
    count++;
  }
  const rest = s.slice(i).trim();
  return rest.length > 0 ? rest : null;
}

function restAfterFlag(s: string, flag: string): string | null {
  const idx = s.indexOf(flag);
  if (idx === -1) return null;
  const rest = s.slice(idx + flag.length).trim();
  return rest.length > 0 ? rest : null;
}
