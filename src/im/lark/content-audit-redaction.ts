import { isLarkContentAuditError } from './content-audit.js';

/**
 * 飞书内容安全审计（230028 等）拒收后的「自动打码 + 重发一次」。
 *
 * 零注入 / 转写回复模式下，最终回复由 daemon 从 transcript 自动收取后外发，
 * 模型看不到发送失败，没法像 `botmux send` 那样按错误提示自己改。现网被拦的
 * 回复几乎全是 git 作者 / 提交者 / Co-Authored-By 里的邮箱（飞书返回
 * `contain sensitive data: EMAIL_ADDRESS`），所以这里按飞书给出的敏感类型把
 * 对应片段替换成等长的 `*`，只改**这次发送的副本**，再重发一次。
 *
 * 只动文本节点：卡片 JSON / post 富文本先解析，再只改承载正文的字符串，
 * 结构键（tag、element_id、回调 value 等）原样保留；`<at …>…</at>` mention
 * 标记不参与打码，URL 只打其中的邮箱。
 */

export type SensitiveCategory = 'email' | 'phone' | 'idCard' | 'bankCard';

export const ALL_SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = ['email', 'phone', 'idCard', 'bankCard'];

export type RedactionHits = Record<SensitiveCategory, number>;

function emptyHits(): RedactionHits {
  return { email: 0, phone: 0, idCard: 0, bankCard: 0 };
}

function totalHits(hits: RedactionHits): number {
  return hits.email + hits.phone + hits.idCard + hits.bankCard;
}

// ─── 敏感类型解析 ────────────────────────────────────────────────────────────

/** 从错误对象上收集飞书返回的 msg 文本（axios response.data.msg、LarkApiError.larkMsg、message）。 */
function larkErrorTexts(err: unknown): string[] {
  if (!err || typeof err !== 'object') return typeof err === 'string' ? [err] : [];
  const e = err as Record<string, any>;
  const texts = [e.response?.data?.msg, e.response?.data?.error?.message, e.larkMsg, e.msg, e.message];
  return texts.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function categoryForType(type: string): SensitiveCategory | undefined {
  if (/EMAIL|MAIL_?ADDR/.test(type)) return 'email';
  if (/PHONE|MOBILE|TELEPHONE|\bTEL\b/.test(type)) return 'phone';
  // 证件号先判：ID_CARD_NUMBER 里也有 CARD_NUM。
  if (/(?:^|_)ID_?(?:CARD|NUM)|IDENTITY|CITIZEN|RESIDENT/.test(type)) return 'idCard';
  if (/BANK|CREDIT|DEBIT|CARD_?(?:NO|NUM)/.test(type)) return 'bankCard';
  return undefined;
}

export interface ContentAuditSensitiveTypes {
  /** 飞书返回的原始类型名（如 EMAIL_ADDRESS）；拿不到时为空。 */
  types: string[];
  /** 要打码的类别；类型缺失或出现无法识别的类型时为全部类别。 */
  categories: SensitiveCategory[];
  /** 类别是否由飞书返回的类型精确确定（false = 按全部类型兜底）。 */
  exact: boolean;
}

/** 解析 `contain sensitive data: EMAIL_ADDRESS, PHONE_NUMBER` 一类的拒收原因。 */
export function contentAuditSensitiveTypes(err: unknown): ContentAuditSensitiveTypes {
  const types = new Set<string>();
  for (const text of larkErrorTexts(err)) {
    const match = /sensitive data\s*[:：]\s*([A-Za-z0-9_]+(?:\s*[,，|/;&]\s*[A-Za-z0-9_]+)*)/i.exec(text);
    if (!match) continue;
    for (const raw of match[1].split(/[,，|/;&]/)) {
      const type = raw.trim().toUpperCase();
      if (type) types.add(type);
    }
  }
  const list = [...types];
  const categories = new Set<SensitiveCategory>();
  let exact = list.length > 0;
  for (const type of list) {
    const category = categoryForType(type);
    if (category) categories.add(category);
    else exact = false;
  }
  return {
    types: list,
    categories: exact ? ALL_SENSITIVE_CATEGORIES.filter(category => categories.has(category)) : [...ALL_SENSITIVE_CATEGORIES],
    exact,
  };
}

// ─── 纯文本打码 ──────────────────────────────────────────────────────────────

/**
 * 邮箱：`local@domain.tld`。只把 local part 和 `@` 换成 `*`、保留域名——没有 `@`
 * 就不再是邮箱，能过审；域名还能看出是 GitHub noreply 还是个人邮箱，阅读影响小。
 *
 * 防误伤：
 * - local part 前面不能紧贴邮箱字符或单个 `/`（`@scope/pkg@1.2.3` 的 `pkg` 前是 `/`）；
 *   `ssh://git@host` 的 `://` 和截断写法 `<...abc@host>` 的 `.` 不在此列，照常打码；
 * - 顶级域必须是 2 位以上字母，排除 `bun@1.4.3`、`pkg@^2.0.0` 等版本号；
 * - 域名字符不含 `{`，排除 `HEAD@{1}`、`stash@{0}` 等 reflog 写法；
 * - 装饰器 `@Component`、包名 `@types/node` 没有 local part，天然不匹配；
 * - 顶级域是常见源码 / 资源扩展名（`.ts`/`.py`/`.png`…，如 `icon@2x.png`）时不算邮箱；
 * - Kotlin 标签写法 `this@MainActivity.x` / `super@Foo.bar` 不算邮箱。
 */
const EMAIL_RE = /(?<![A-Za-z0-9_%+\-])(?<!(?:^|[^/])\/)([A-Za-z0-9_%+\-]+(?:\.[A-Za-z0-9_%+\-]+)*)@((?:[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?\.)+([A-Za-z]{2,24}))(?![A-Za-z0-9\-]|\.[A-Za-z0-9])/g;
const CODE_EXTENSION_TLDS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'cpp', 'hpp', 'cc', 'md', 'mdx', 'yml', 'yaml', 'toml', 'lock', 'sh', 'txt', 'css', 'scss', 'html', 'vue', 'svelte',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'pdf',
]);
const CODE_LABEL_LOCALS = new Set(['this', 'super']);

/**
 * 中国大陆手机号（可带 +86 / 86 前缀，允许 3-4-4 的空格或连字符分组）与带区号的座机号。
 * 数字类规则的前缀只排除字母数字、`.`、`+`、`-`、`/`（路径里的数字基本是 ID）；
 * `手机:138…`、`Tel:+86…`、`#138…` 这类紧跟冒号 / 井号的写法照常打码。
 */
const MOBILE_RE = /(?<![\w.+\-/])(?:(?:\+|00)?86[\s\-]?)?1[3-9]\d(?:\d{8}|[\s\-]\d{4}[\s\-]\d{4})(?![\w\-]|\.\d)/g;
const LANDLINE_RE = /(?<![\w.+\-/])0\d{2,3}-\d{7,8}(?![\w\-]|\.\d)/g;
/** 18 位居民身份证号（含出生日期段 + GB 11643 校验位）。 */
const ID_CARD_RE = /(?<![\w.+\-/])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\w\-]|\.\d)/g;
/**
 * 银行卡号：常见卡组织前缀（银联 62、Visa 4、Mastercard 51-55/2221-2720、
 * Amex 34/37）+ Luhn 校验，可 4 位一组。飞书消息 / 话题 ID 是 7 开头的 19 位
 * 雪花数，不在这些前缀里，避免把长数字 ID 当卡号。
 */
const BANK_CARD_RE = /(?<![\w.+\-/])(?:\d{4}[\s\-]){3,4}\d{1,7}(?![\w\-]|\.\d)|(?<![\w.+\-/])\d{15,19}(?![\w\-]|\.\d)/g;

/** 特殊片段：mention 标记（整体保留）与 URL（只打邮箱，不碰数字）。 */
const PROTECTED_RE = /<at\b[^>]*>[\s\S]*?<\/at>|<at\b[^>]*\/?>|\bhttps?:\/\/[^\s<>()"'`\]]+/gi;

/**
 * 打码时先写占位符，最后按所在位置换成 `*`：Markdown 正文里连续的 `*` 会被当成
 * 粗体 / 斜体 / 分隔线吞掉，所以代码区以外写成转义的 `\*`（渲染出来仍是等长的 `*`），
 * 代码区与纯文本里直接写 `*`。
 */
const MASK = '\uE000';
const MASK_RE = /\uE000/g;

function stars(length: number): string {
  return MASK.repeat(length);
}

function maskDigits(value: string): string {
  return value.replace(/\d/g, MASK);
}

/** Markdown 代码区：围栏代码块与行内代码（反引号内 `*` 不会被解析）。 */
const MARKDOWN_CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

function finalizeMask(text: string, markdown: boolean): string {
  if (!text.includes(MASK)) return text;
  if (!markdown) return text.replace(MASK_RE, '*');
  let out = '';
  let last = 0;
  for (const match of text.matchAll(MARKDOWN_CODE_RE)) {
    const start = match.index ?? 0;
    out += text.slice(last, start).replace(MASK_RE, '\\*') + match[0].replace(MASK_RE, '*');
    last = start + match[0].length;
  }
  return out + text.slice(last).replace(MASK_RE, '\\*');
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function bankCardPrefix(digits: string): boolean {
  if (/^62/.test(digits)) return digits.length >= 16 && digits.length <= 19;
  if (/^4/.test(digits)) return digits.length === 16 || digits.length === 19;
  if (/^5[1-5]/.test(digits)) return digits.length === 16;
  const head4 = Number(digits.slice(0, 4));
  if (head4 >= 2221 && head4 <= 2720) return digits.length === 16;
  if (/^3[47]/.test(digits)) return digits.length === 15;
  return false;
}

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK = '10X98765432';

function idCardChecksumValid(id: string): boolean {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * ID_CARD_WEIGHTS[i];
  return ID_CARD_CHECK[sum % 11] === id[17].toUpperCase();
}

function redactSegment(text: string, categories: ReadonlySet<SensitiveCategory>, hits: RedactionHits): string {
  let out = text;
  if (categories.has('email')) {
    out = out.replace(EMAIL_RE, (match, local: string, _domain: string, tld: string) => {
      if (CODE_EXTENSION_TLDS.has(tld.toLowerCase()) || CODE_LABEL_LOCALS.has(local)) return match;
      hits.email++;
      return stars(local.length + 1) + match.slice(local.length + 1);
    });
  }
  // 身份证先于银行卡：18 位身份证本身也可能凑巧过 Luhn。
  if (categories.has('idCard')) {
    out = out.replace(ID_CARD_RE, match => {
      if (!idCardChecksumValid(match)) return match;
      hits.idCard++;
      return stars(match.length);
    });
  }
  if (categories.has('bankCard')) {
    out = out.replace(BANK_CARD_RE, match => {
      const digits = match.replace(/[\s\-]/g, '');
      if (digits.length < 15 || digits.length > 19 || !bankCardPrefix(digits) || !luhnValid(digits)) return match;
      hits.bankCard++;
      return maskDigits(match);
    });
  }
  if (categories.has('phone')) {
    out = out.replace(MOBILE_RE, match => { hits.phone++; return maskDigits(match); });
    out = out.replace(LANDLINE_RE, match => { hits.phone++; return maskDigits(match); });
  }
  return out;
}

/**
 * 对一段文本按类别打码；mention 标记原样保留，URL 只打邮箱。纯文本里是等长替换；
 * `markdown: true` 时代码区以外的打码写成 `\*`，渲染后同样是等长的 `*`。
 */
export function redactSensitiveText(
  text: string,
  categories: readonly SensitiveCategory[] = ALL_SENSITIVE_CATEGORIES,
  hits: RedactionHits = emptyHits(),
  options: { markdown?: boolean } = {},
): { text: string; hits: RedactionHits } {
  const wanted = new Set(categories);
  if (wanted.size === 0 || !text) return { text, hits };
  let out = '';
  let last = 0;
  const urlCategories = new Set<SensitiveCategory>(wanted.has('email') ? ['email'] : []);
  for (const match of text.matchAll(PROTECTED_RE)) {
    const start = match.index ?? 0;
    // mention 标记整体保留；URL 里的数字基本是 ID / 路径，只处理其中的邮箱。
    const kept = /^<at\b/i.test(match[0]) ? match[0] : redactSegment(match[0], urlCategories, hits);
    out += redactSegment(text.slice(last, start), wanted, hits) + kept;
    last = start + match[0].length;
  }
  out += redactSegment(text.slice(last), wanted, hits);
  return { text: finalizeMask(out, options.markdown === true), hits };
}

// ─── 消息体打码（只改文本节点） ───────────────────────────────────────────────

/** 结构键：值是标识符 / 枚举 / 资源 key，不是给人看的正文。 */
const STRUCTURAL_KEYS = new Set([
  'tag', 'element_id', 'name', 'data_type', 'width', 'text_size', 'text_align', 'text_color', 'color',
  'background_style', 'img_key', 'image_key', 'file_key', 'template_id', 'template_version_name', 'uuid',
  'schema', 'user_id', 'open_id', 'union_id', 'chat_id', 'message_id', 'type', 'mode', 'style', 'size',
  'icon', 'token', 'direction', 'layout', 'flex_mode', 'horizontal_align', 'vertical_align', 'padding',
  'margin', 'height', 'lines', 'emoji_type', 'language',
]);
/** 子树整体跳过：卡片回调载荷、交互行为。改了会让按钮回调失效。 */
const SKIPPED_SUBTREES = new Set(['value', 'behaviors', 'config', 'confirm_value', 'form_value']);
/** 链接字段：只处理 mailto: 邮箱，不碰数字（URL 里的数字基本都是 ID）。 */
const LINK_KEYS = new Set(['href', 'url', 'pc_url', 'android_url', 'ios_url', 'default_url']);

/** 承载 Markdown 的节点：卡片 markdown / lark_md、post 的 md。 */
const MARKDOWN_TAGS = new Set(['markdown', 'lark_md', 'md']);

function redactNode(
  node: unknown, key: string | undefined, categories: readonly SensitiveCategory[], hits: RedactionHits,
  markdown = false,
): unknown {
  if (typeof node === 'string') {
    if (key && STRUCTURAL_KEYS.has(key)) return node;
    if (key && LINK_KEYS.has(key)) {
      if (!/^mailto:/i.test(node) || !categories.includes('email')) return node;
      const target = node.slice('mailto:'.length);
      return 'mailto:' + redactSensitiveText(target, ['email'], hits).text;
    }
    return redactSensitiveText(node, categories, hits, { markdown }).text;
  }
  if (Array.isArray(node)) return node.map(item => redactNode(item, key, categories, hits, markdown));
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const isMarkdownNode = typeof record.tag === 'string' && MARKDOWN_TAGS.has(record.tag);
    // 表格单元格按列的 data_type 决定是否按 Markdown 渲染。
    const markdownColumns = record.tag === 'table' && Array.isArray(record.columns)
      ? new Set((record.columns as Array<Record<string, unknown>>)
        .filter(column => column?.data_type === 'lark_md' || column?.data_type === 'markdown')
        .map(column => String(column.name)))
      : undefined;
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      if (SKIPPED_SUBTREES.has(childKey)) { out[childKey] = child; continue; }
      if (markdownColumns && childKey === 'rows' && Array.isArray(child)) {
        out[childKey] = child.map(row => row && typeof row === 'object' && !Array.isArray(row)
          ? Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([cell, value]) =>
            [cell, redactNode(value, undefined, categories, hits, markdownColumns.has(cell))]))
          : redactNode(row, childKey, categories, hits));
        continue;
      }
      const childMarkdown = isMarkdownNode && (childKey === 'content' || childKey === 'text');
      out[childKey] = redactNode(child, childKey, categories, hits, childMarkdown);
    }
    return out;
  }
  return node;
}

function appendCardNote(card: Record<string, any>, note: string): boolean {
  const bodyElements = card.body && typeof card.body === 'object' && Array.isArray(card.body.elements)
    ? card.body.elements as unknown[] : undefined;
  if (bodyElements) {
    const element = { tag: 'markdown', element_id: 'botmux_audit_redacted', text_size: 'notation', content: `<font color='grey'>${note}</font>` };
    // 放在签名页脚（hr + footer）之前，读起来紧跟正文。
    const footerIndex = bodyElements.findIndex(item => (item as any)?.element_id === 'botmux_reply_footer');
    let at = footerIndex >= 0 ? footerIndex : bodyElements.length;
    if (at > 0 && (bodyElements[at - 1] as any)?.tag === 'hr' && footerIndex >= 0) at -= 1;
    bodyElements.splice(at, 0, element);
    return true;
  }
  if (Array.isArray(card.elements)) {
    card.elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: note }] });
    return true;
  }
  return false;
}

function appendPostNote(post: Record<string, any>, note: string): boolean {
  let appended = false;
  const visit = (locale: any) => {
    if (locale && typeof locale === 'object' && Array.isArray(locale.content)) {
      locale.content.push([{ tag: 'text', text: note }]);
      appended = true;
    }
  };
  if (Array.isArray(post.content)) visit(post);
  else for (const value of Object.values(post.post && typeof post.post === 'object' ? post.post : post)) visit(value);
  return appended;
}

export interface RedactedLarkMessage {
  content: string;
  hits: RedactionHits;
  total: number;
}

/**
 * 按消息类型对**发送副本**打码：
 * - `text`：content 是纯文本（client 负责包成 `{"text":…}`）；
 * - `interactive` / `post`：content 是 JSON，解析后只改文本节点再序列化；
 * - 其它类型（file / image …）或 JSON 解析失败：不处理，返回 undefined。
 * 命中数为 0 时也返回结果，由调用方决定是否重发。
 */
export function redactLarkMessageContent(
  content: string,
  msgType: string | undefined,
  categories: readonly SensitiveCategory[],
  note?: string,
): RedactedLarkMessage | undefined {
  const type = msgType ?? 'text';
  const hits = emptyHits();
  if (type === 'text') {
    const redacted = redactSensitiveText(content, categories, hits).text;
    const total = totalHits(hits);
    return { content: total > 0 && note ? `${redacted}\n${note}` : redacted, hits, total };
  }
  if (type !== 'interactive' && type !== 'post') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const redacted = redactNode(parsed, undefined, categories, hits) as Record<string, any>;
  const total = totalHits(hits);
  if (total > 0 && note) {
    if (type === 'interactive') appendCardNote(redacted, note);
    else appendPostNote(redacted, note);
  }
  return { content: JSON.stringify(redacted), hits, total };
}

// ─── 发送包装：拒收 → 打码 → 重发一次 ─────────────────────────────────────────

const REDACTION_OUTCOME = Symbol.for('botmux.contentAuditRedaction');

export interface ContentAuditRedactionOutcome {
  /** 是否真的打码并重发过（false = 没找到可打码的内容，没有重发）。 */
  retried: boolean;
  types: string[];
  hits: RedactionHits;
}

/** 读取 {@link sendWithContentAuditRedaction} 挂在最终错误上的打码结果。 */
export function contentAuditRedactionOutcome(err: unknown): ContentAuditRedactionOutcome | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return (err as Record<symbol, ContentAuditRedactionOutcome | undefined>)[REDACTION_OUTCOME];
}

function markOutcome(err: unknown, outcome: ContentAuditRedactionOutcome): void {
  if (!err || typeof err !== 'object') return;
  try {
    Object.defineProperty(err, REDACTION_OUTCOME, { value: outcome, configurable: true, enumerable: false });
  } catch { /* frozen error: caller falls back to the generic notice */ }
}

function describeHits(hits: RedactionHits): string {
  return (Object.entries(hits) as Array<[SensitiveCategory, number]>)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${category}:${count}`)
    .join(',') || 'none';
}

/**
 * 发送一次；若被飞书内容安全审计拒收，则按拒收原因里的敏感类型打码副本后
 * **最多重发一次**。日志只记类型、命中条数与重发结果，绝不记原文。
 *
 * - 重发沿用调用方的 provider uuid：飞书 uuid 只对「成功发送」去重，被拒的
 *   请求不占用；同一 uuid 也让崩溃后的重放落在同一条消息上。
 * - 按精确类型打不到任何内容时，退回全部类型再试；仍为 0 则不重发（同样的
 *   内容必然再被拒），原错误抛回调用方。
 * - 最终抛出的错误上挂 {@link contentAuditRedactionOutcome}，供调用方选择提示文案。
 */
export async function sendWithContentAuditRedaction<T>(opts: {
  content: string;
  msgType: string | undefined;
  send: (content: string) => Promise<T>;
  note: string;
  log?: (line: string) => void;
}): Promise<T> {
  try {
    return await opts.send(opts.content);
  } catch (err) {
    if (!isLarkContentAuditError(err)) throw err;
    const parsed = contentAuditSensitiveTypes(err);
    let redacted = redactLarkMessageContent(opts.content, opts.msgType, parsed.categories, opts.note);
    if (redacted && redacted.total === 0 && parsed.exact) {
      redacted = redactLarkMessageContent(opts.content, opts.msgType, ALL_SENSITIVE_CATEGORIES, opts.note);
    }
    const types = parsed.types.length ? parsed.types.join(',') : 'unknown';
    if (!redacted || redacted.total === 0) {
      opts.log?.(`content audit auto-redact skipped: types=${types} msgType=${opts.msgType ?? 'text'} hits=none`);
      markOutcome(err, { retried: false, types: parsed.types, hits: redacted?.hits ?? emptyHits() });
      throw err;
    }
    const hits = describeHits(redacted.hits);
    try {
      const result = await opts.send(redacted.content);
      opts.log?.(`content audit auto-redact resent: types=${types} msgType=${opts.msgType ?? 'text'} hits=${hits} result=delivered`);
      return result;
    } catch (retryErr) {
      const stillAudit = isLarkContentAuditError(retryErr);
      opts.log?.(`content audit auto-redact resent: types=${types} msgType=${opts.msgType ?? 'text'} hits=${hits} `
        + `result=${stillAudit ? 'still_blocked' : 'failed'}`);
      markOutcome(retryErr, { retried: true, types: parsed.types, hits: redacted.hits });
      throw retryErr;
    }
  }
}
