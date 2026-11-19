/**
 * 决策看板附件的口径：哪些类型能附、多大、怎么认文件头、HTML 说明页用什么响应头、视频的 Range 怎么切。
 * CLI、daemon、Dashboard 和网页共用这一份，所以不 import 任何 node 模块（网页会把它打进 bundle）。
 *
 * 截图（png / jpg / gif / webp）沿用 dashboard-images.ts 的老口径，这里只管「图文说明」：
 *   - HTML 说明页：单个文件，图片内嵌成 data URL。bot 生成的内容，所以按不可信页面对待——响应头带
 *     `Content-Security-Policy: sandbox`（不给 allow-same-origin，文档是不透明源：读不到控制台的
 *     cookie / localStorage，也带不上控制台的凭据），外链资源一律拦掉，只放 data: 图片和内联样式。
 *   - 视频：mp4 / webm，按 Range 分段回，手机上能拖进度条。
 */

export type BoardFileKind = 'image' | 'html' | 'video';

const IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** 图文说明：MIME → 落盘扩展名。 */
export const BOARD_EXPLAINER_EXT: Readonly<Record<string, string>> = {
  'text/html': '.html',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

/** CLI 按扩展名认图文说明（文件头由 daemon 再验一次）。 */
export const BOARD_EXPLAINER_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const BOARD_HTML_MAX_BYTES = 10 * 1024 * 1024;
export const BOARD_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** 一次 attach 最多带几个图文说明（截图另算，沿用每次 8 张）。 */
export const BOARD_EXPLAINERS_PER_ATTACH = 4;
/**
 * daemon 每次给视频最多回这么多字节（不带 Range、open-ended 的 `bytes=0-` 也一样，一律回 206）：
 * Dashboard 收 daemon 的响应时没有背压，切小块让每个在途请求最多占这么多内存；浏览器的播放器按
 * Content-Range 接着要下一段，要整份的下载由 Dashboard 按块拼。
 */
export const BOARD_VIDEO_RANGE_CHUNK = 2 * 1024 * 1024;

/** CLI 与 daemon 之间上传图文说明的请求头（正文是文件原始字节）。 */
export const BOARD_UPLOAD_HEADERS = {
  name: 'x-botmux-file-name',
  ref: 'x-botmux-board-ref',
  capability: 'x-botmux-origin-capability',
  turnId: 'x-botmux-origin-turn-id',
  dispatchAttempt: 'x-botmux-origin-dispatch-attempt',
} as const;

/**
 * HTML 说明页的 CSP。`sandbox` 不带任何 allow-*：不跑脚本、不能提交表单、不能弹窗、不能导航顶层页面，
 * 文档是不透明源。default-src 'none' 拦掉所有外链（含 fetch / XHR / 字体 / iframe），只放内嵌的
 * data: 图片和内联样式。
 */
export const BOARD_HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox";

export function boardFileKind(mime: string): BoardFileKind | undefined {
  const m = mime.toLowerCase();
  if (IMAGE_MIMES.includes(m)) return 'image';
  if (m === 'text/html') return 'html';
  if (m === 'video/mp4' || m === 'video/webm') return 'video';
  return undefined;
}

export function isBoardExplainerMime(mime: string): boolean {
  const kind = boardFileKind(mime);
  return kind === 'html' || kind === 'video';
}

export function boardExplainerMaxBytes(mime: string): number {
  return boardFileKind(mime) === 'video' ? BOARD_VIDEO_MAX_BYTES : BOARD_HTML_MAX_BYTES;
}

const MB = 1024 * 1024;

/** 超限时给管家的话：写明上限和怎么压。 */
export function boardExplainerTooLargeText(mime: string, path: string): string {
  if (boardFileKind(mime) === 'video') {
    return `视频超过 ${BOARD_VIDEO_MAX_BYTES / MB}MB：${path}（先压到 720p：ffmpeg -i <原视频> -vf scale=-2:720 -c:v libx264 -crf 28 -movflags +faststart -an <输出>.mp4）`;
  }
  return `说明页超过 ${BOARD_HTML_MAX_BYTES / MB}MB：${path}（图片内嵌成 data URL 后整个文件不能超过 ${BOARD_HTML_MAX_BYTES / MB}MB，截图先缩小或转成 jpg）`;
}

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

/**
 * 文件头核验（不信扩展名和 MIME）：mp4 第 4–8 字节是 `ftyp`；webm 以 EBML 头 1A 45 DF A3 开头；
 * HTML 去掉 BOM 和空白后第一个字符是 `<`。`head` 取文件开头至少 64 字节。
 */
export function sniffBoardExplainer(mime: string, head: Uint8Array): boolean {
  const m = mime.toLowerCase();
  if (m === 'video/mp4') return head.length >= 12 && ascii(head, 4, 8) === 'ftyp';
  if (m === 'video/webm') return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  if (m === 'text/html') {
    let i = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
    while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
    return head[i] === 0x3c;
  }
  return false;
}

// 下面的校验跑在 daemon 的事件循环上，输入是不可信的几 MB 文本：只用线性扫描和不会回溯成平方的正则
// （相邻的可空量词、`[^>]*` 后再接字符类这类写法，一个 150KB 的恶意文件就能卡住 daemon 好几秒）。

const isHtmlSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
const isAsciiAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** 从 `&#` 处解一个数字字符引用（浏览器在属性值里也解，分号可省、前导零不限）；不是引用返回 null。 */
function numericCharRef(text: string, at: number): { code: number; next: number } | null {
  let i = at + 2;
  const hex = text.charCodeAt(i) === 0x78 || text.charCodeAt(i) === 0x58;
  if (hex) i++;
  const from = i;
  let code = 0;
  for (;; i++) {
    const c = text.charCodeAt(i);
    const d = c >= 0x30 && c <= 0x39 ? c - 0x30
      : hex && c >= 0x61 && c <= 0x66 ? c - 0x57
      : hex && c >= 0x41 && c <= 0x46 ? c - 0x37
      : -1;
    if (d < 0) break;
    code = Math.min(code * (hex ? 16 : 10) + d, 0x110000);
  }
  if (i === from) return null;
  if (text.charCodeAt(i) === 0x3b) i++;
  return { code, next: i };
}

/**
 * 从属性值开头（引号之后或无引号值的第一个字符）起，解码后去掉首尾空白是否恰好等于 want（ASCII 不分大小写）。
 * 对不上就立刻返回，所以每次只看到下一个 `http-equiv` 之前。
 */
function attrValueIs(text: string, from: number, quote: number, want: string): boolean {
  let matched = 0;
  let i = from;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (quote ? c === quote : isHtmlSpace(c) || c === 0x3e) break;
    i++;
    if (c === 0x26 && text.charCodeAt(i) === 0x23) {
      const ref = numericCharRef(text, i - 1);
      if (ref) {
        c = ref.code;
        i = ref.next;
      }
    }
    if (isHtmlSpace(c) && (matched === 0 || matched === want.length)) continue;
    if (matched === want.length) return false;
    if ((c >= 0x41 && c <= 0x5a ? c + 0x20 : c) !== want.charCodeAt(matched)) return false;
    matched++;
  }
  return matched === want.length;
}

/**
 * 有没有 `http-equiv=refresh`。不靠切标签：浏览器认出的每个 meta refresh 都得在源码里原样写出属性名
 * `http-equiv`（属性名不解字符引用），属性值怎么切只看它后面的字符，所以逐个检查每处 `http-equiv` 后面的值，
 * 就不会被引号里的 `>`、注释、`<script>` 之类的上下文骗过；代价是正文里原样写出这个属性也会被拦。
 */
function hasMetaRefresh(text: string): boolean {
  const name = /http-equiv/gi;
  for (let m = name.exec(text); m; m = name.exec(text)) {
    let i = m.index + m[0].length;
    while (isHtmlSpace(text.charCodeAt(i))) i++;
    if (text.charCodeAt(i) !== 0x3d) continue;
    i++;
    while (isHtmlSpace(text.charCodeAt(i))) i++;
    const q = text.charCodeAt(i);
    const quote = q === 0x22 || q === 0x27 ? q : 0;
    if (attrValueIs(text, quote ? i + 1 : i, quote, 'refresh')) return true;
  }
  return false;
}

/**
 * 说明页正文的硬性要求：UTF-8（按 `text/html; charset=utf-8` 回）；不能有 meta refresh——Chromium 在
 * 沙箱里会拦它，但不是每个内核都拦，拦不住时它能把框内页面自动跳到别的网站。其余写法（脚本、外链）由 CSP 拦，不拒收。
 */
export function checkBoardExplainerHtml(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: '说明页要用 UTF-8 编码' };
  }
  if (hasMetaRefresh(text)) {
    return { ok: false, reason: '说明页里不能有 <meta http-equiv="refresh">（会把页面自动跳走）；正文里要提到它，把等号写成 &#61;' };
  }
  return { ok: true, text };
}

const EXTERNAL_REF_RE = /\b(?:src|href|srcset|poster|data|action)\s*=\s*(?:["']\s*)?(?:https?:)?\/\//gi;
const EXTERNAL_CSS_RE = /url\(\s*(?:["']\s*)?(?:https?:)?\/\/|@import\b/gi;
const EVENT_ATTR_RE = /\son[a-z]+\s*=/gi;

/** 有没有写在标签里的 `on…=` 事件属性（正文里的 "one = two" 不算）。光标只往前走，整体线性。 */
function hasEventAttr(text: string): boolean {
  let lastLt = -1;
  let lastGt = -1;
  let cursor = 0;
  for (let m = EVENT_ATTR_RE.exec(text); m; m = EVENT_ATTR_RE.exec(text)) {
    for (; cursor < m.index; cursor++) {
      const c = text.charCodeAt(cursor);
      if (c === 0x3c) lastLt = cursor;
      else if (c === 0x3e) lastGt = cursor;
    }
    if (lastLt > lastGt && isAsciiAlpha(text.charCodeAt(lastLt + 1))) {
      EVENT_ATTR_RE.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/** 给管家的提示（不拒收）：在看板上不会生效的写法。 */
export function boardExplainerHtmlWarnings(text: string): string[] {
  const warnings: string[] = [];
  const external = (text.match(EXTERNAL_REF_RE)?.length ?? 0) + (text.match(EXTERNAL_CSS_RE)?.length ?? 0);
  if (external > 0) warnings.push(`有 ${external} 处外链资源（网址图片、CDN 样式或字体、外部链接），看板上会被拦掉；图片请内嵌成 data URL，链接挂到事项的 --link 上`);
  if (/<script\b/i.test(text) || hasEventAttr(text)) warnings.push('页面里的脚本在看板上不会执行，交互请改用纯 HTML / CSS（如 <details>）');
  return warnings;
}

/** 文件名：只留文件名本身，去掉奇怪字符，扩展名按 MIME 定。 */
export function normalizeBoardFileName(raw: unknown, mime: string, fallback: string): string {
  const ext = BOARD_EXPLAINER_EXT[mime.toLowerCase()] ?? '';
  const base = typeof raw === 'string' ? raw.trim().split(/[\\/]/).pop() ?? '' : '';
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80) || fallback;
  return `${stem}${ext}`;
}

export type ByteRangeResult =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const SINGLE_RANGE_RE = /^\s*bytes\s*=\s*(\d{0,15})\s*-\s*(\d{0,15})\s*$/i;

/**
 * 不管文件多大，{@link parseByteRange} 都会把它当一段 Range（回 206 或 416，不会退回整份 200）。
 * Dashboard 只把这种 Range 原样转给 daemon，别的一律换成按块拼整份。
 */
export function isSingleByteRange(header: string): boolean {
  const m = SINGLE_RANGE_RE.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return false;
  return m[1] === '' || m[2] === '' || Number(m[1]) <= Number(m[2]);
}

/**
 * 解析单段 `Range: bytes=…`（RFC 9110 §14.1.2）。返回的 end 含在内，并按 maxChunk 截短。
 * 不认的写法（别的单位、多段、语法错）返回 none，由调用方当没带 Range 处理；起点越过文件尾返回 unsatisfiable。
 */
export function parseByteRange(header: string | undefined, size: number, maxChunk = Number.POSITIVE_INFINITY): ByteRangeResult {
  if (!header) return { kind: 'none' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'none' };
  const num = (s: string): number | null => {
    if (s.length > 15) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  };
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = num(m[2]!);
    if (suffix === null) return { kind: 'none' };
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    const first = num(m[1]!);
    const last = m[2] === '' ? size - 1 : num(m[2]!);
    if (first === null || last === null) return { kind: 'none' };
    if (m[2] !== '' && last < first) return { kind: 'none' };
    if (first >= size) return { kind: 'unsatisfiable' };
    start = first;
    end = Math.min(last, size - 1);
  }
  if (end - start + 1 > maxChunk) end = start + maxChunk - 1;
  return { kind: 'range', start, end };
}
