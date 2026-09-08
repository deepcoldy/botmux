/**
 * cot-subject.ts — 工具调用的「一行主题」提取（command / file_path / …）。
 *
 * 转写层（claude-transcript / codex-transcript）与气泡渲染层（cot-message）共用，
 * 避免两份 `COT_SUBJECT_FIELDS`。零依赖：转写解析器要求 dependency-free，本模块
 * 只用语言内建。
 *
 * 为什么主题要在转写层、截断之前提取：气泡的工具节点标题是「类别 · 主题」，而
 * 飞书渲染器不画 TOOL_CALL_ARGS，标题是唯一载体。转写层把 args 截到 600 字符再
 * 交给渲染层解析，长命令 / heredoc / 大 content 的 Write 一截就 parse 失败，正则
 * 回捞也救不回超长 command，标题退化成裸「执行命令」。所以主题必须从**未截断的
 * 完整 input** 上取，随 CotEntry 下发；渲染层只做 80 字符的显示截断。
 */

/** 按「对人类读者辨识度」排序的字段：`command` 覆盖 Claude 的 Bash 与 Codex 的
 *  local_shell_call action；`description` / `prompt` 兜住没有路径或命令的子代理 /
 *  任务类调用。 */
export const COT_SUBJECT_FIELDS = [
  'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'subject',
  'description', 'prompt',
] as const;

/** 标题里主题的显示上限：标题是气泡里单行不折行的文本，这是布局约束，不是数据约束。 */
export const COT_TOOL_TITLE_SUBJECT_MAX_CHARS = 80;

/** 随 IPC 下发的主题传输上限。display 只要 80，但语言高亮要看 full 的尾部扩展名；
 *  路径远不会超过 1000，命令超过时尾部被切也不影响标题。 */
export const COT_SUBJECT_MAX_CHARS = 1_000;

export interface ToolSubject { display: string; full: string }

/** 多行脚本折叠成单行：标题是一行不折行的文本。 */
export function collapseSubject(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 从已解析的 input 对象取主题（Claude tool_use.input / codex action /
 *  JSON.parse(arguments)）。按 COT_SUBJECT_FIELDS 优先级；数组值取末元素
 *  （local_shell_call 的 `command` 是 ["bash","-lc","…"]，脚本在最后，拼 argv 只会
 *  把它淹在样板里）；无命中返回 ''。 */
export function subjectFromInputObject(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const o = input as Record<string, unknown>;
  const pick = COT_SUBJECT_FIELDS
    .map(k => o[k])
    .find(v => (typeof v === 'string' && v.trim().length > 0) || (Array.isArray(v) && v.length > 0));
  if (pick === undefined) return '';
  const subject = Array.isArray(pick)
    ? String(pick[pick.length - 1] ?? '').trim()
    : String(pick).trim();
  return collapseSubject(subject);
}

const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/m;

/**
 * 从 args 字符串取主题：`{` 开头 → 尝试 JSON.parse 走对象路径；parse 失败视为被
 * 截断的 JSON → 正则回捞；非 JSON 裸字符串（codex custom_tool_call 的脚本 /
 * patch 文本）→ apply_patch 形态抽第一条文件路径，否则整体折叠。
 * 所有「拿不到可用主题」的路径都返回 ''，调用方保留裸类别标签。
 */
export function subjectFromArgsString(args: string): string {
  const raw = args.trim();
  if (raw.length === 0) return '';
  if (raw.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object') return subjectFromInputObject(parsed);
    // 被截断的 JSON：渲染 `{"command":` 残片比什么都不渲染更糟，但前导字段通常
    // 幸存，先回捞一个再放弃。
    return recoverSubjectFromTruncatedJson(raw) ?? '';
  }
  if (raw.startsWith('*** Begin Patch')) {
    const m = raw.match(APPLY_PATCH_FILE_RE);
    if (m) return collapseSubject(m[1]);
  }
  return collapseSubject(raw);
}

/** 从中途被切断的 JSON 里回捞第一个优先字段。只匹配完整的 `"key":"value"`，
 *  值被切在字符串中间的直接跳过，不渲染半截。 */
export function recoverSubjectFromTruncatedJson(raw: string): string | undefined {
  for (const key of COT_SUBJECT_FIELDS) {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) continue;
    let value: string;
    try { value = JSON.parse(`"${m[1]}"`); } catch { continue; } // 坏转义 → 跳过
    const collapsed = collapseSubject(value);
    if (collapsed.length > 0) return collapsed;
  }
  return undefined;
}

/** 传输层截断（保留末尾省略号标记，与 truncateForCot 同形）。 */
export function boundSubjectForTransport(full: string): string {
  return full.length > COT_SUBJECT_MAX_CHARS ? `${full.slice(0, COT_SUBJECT_MAX_CHARS)}…` : full;
}

/** 显示层：`display` 按标题布局上限截断，`full` 原样（供语言高亮看扩展名）。 */
export function boundSubjectForTitle(full: string): ToolSubject {
  const f = collapseSubject(full);
  if (f.length === 0) return { display: '', full: '' };
  const display = f.length > COT_TOOL_TITLE_SUBJECT_MAX_CHARS
    ? `${f.slice(0, COT_TOOL_TITLE_SUBJECT_MAX_CHARS)}…`
    : f;
  return { display, full: f };
}
