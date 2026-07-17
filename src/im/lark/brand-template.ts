import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface DirMeta { url?: string; name?: string }

let cache: { path: string; mtimeMs: number; meta: DirMeta } | null = null;

/**
 * `~` 展开。session.workingDir 可能是**字面量** `~/...`：oncall 绑定（oncallChats /
 * defaultOncall）落盘时存的就是原始字符串，而 resolvePinnedWorkingDir 走 oncallEntry
 * 那一支时不展开。别的消费方都自己展开了（session-manager 给 spawn 的 cwd 用 expandHome），
 * 只有这里漏了 —— statSync('~/x') 必然 ENOENT → 读不到 .botmux-dir.json → 角色名丢失。
 */
function expandHome(p: string): string {
  return p === '~' ? homedir()
    : p.startsWith('~/') ? join(homedir(), p.slice(2))
    : p;
}

/** 读取目录元数据 <workingDir>/.botmux-dir.json（mtime 缓存；缺失/损坏 → {}）。 */
export function readDirMeta(workingDir: string): DirMeta {
  const p = join(expandHome(workingDir), '.botmux-dir.json');
  try {
    const st = statSync(p);
    if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs) return cache.meta;
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const meta: DirMeta = {
      url: safeUrl(raw?.url),
      name: safeName(raw?.name),
    };
    cache = { path: p, mtimeMs: st.mtimeMs, meta };
    return meta;
  } catch {
    return {};
  }
}

/**
 * `.botmux-dir.json` 的内容**不可信**：角色名来自用户（「新建角色：XX」），文件本身也只是磁盘上
 * 的任意 JSON；`{cwdName}`/`{cwd}` 的 fallback 更是来自**目录路径**（目录名可含任意字符）。它们
 * 会被拼进卡片脚注，而脚注整体被包进 lark_md 的 `<font color='grey'>…</font>`。不消毒的话：
 *   name = 'x</font><at id=ou_x></at><font>'  → **注入 font/at 标签，能伪造 @提及**
 *   name = 'role]\n**伪造正文**'                → 击穿链接文本位
 *   url  = 'https://x) 尾巴' / 'javascript:…'   → 闭合链接 / 危险 scheme
 */
function safeName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // **先按码点截断，再转义** —— 顺序很关键：反过来（先转义后截断）会把 `\*` 这类转义序列
  // 从中间切开，留下一个落单的 `\`，它会转义掉模板里紧跟的 `]`/`)`，破坏链接结构。
  // Array.from 按码点切，也顺带避免把 emoji 切成半个代理对。
  const truncated = Array.from(v).slice(0, 64).join('');
  const s = safeText(truncated).trim();
  return s || undefined;
}

/**
 * 文本位消毒。落进脚注的值要同时防两层：
 *   ① lark_md 标签/强调注入 —— 与仓库既有的 `escapeLarkMd`（groups-card.ts:662 等 5 处）对齐：
 *      `&`→`&amp;`（须最先）、`<`→`&lt;`、`>`→`&gt;`、`* _ ~ \`` 反斜杠转义。这层堵死
 *      `</font><at …>` 之类的标签注入。
 *   ② markdown 链接结构 —— 模板是用户可配的，同一个变量既可能落文本位 `[{cwdName}]…`
 *      也可能落 URL 位 `[repo]({cwd})`，所以再剥离 `[ ] ( )`（brand 特有，那 5 个卡片不涉及链接）。
 * 代价：角色名里的 `()[]` 会被丢掉（"客服(测试)"→"客服测试"）—— 有意取舍：宁可掉括号，不可被击穿。
 */
function safeText(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    // 反斜杠必须**最先**转义 —— 否则 `\*` 里的反斜杠自成偶数对，让紧跟的 `*` 重新变回有效强调。
    // （注：仓库 5 处 escapeLarkMd 拷贝目前都缺这一步，是同一个潜在缺口，可另行加固。）
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1')
    .replace(/[[\]()]/g, '');
}

/**
 * URL 位：只放行 http/https，且禁掉一串会破坏链接或钓鱼的字符：
 *   - 空白 / `(` `)` / `[` `]` / `<` `>` / 引号反引号 → 闭合链接或注入文本位
 *   - `\` → 在 markdown 里转义掉模板的闭合 `)`
 *   - `@` → userinfo 钓鱼形态 `https://trusted@evil.example/…`（真实 host 是 @ 后面那个）
 *   - host 位（`://` 之后第一个字符）不得再是 `/` → 挡掉 `https:////evil` 归一到 evil 的混淆
 * 用途上这里的 url 只会是飞书知识文档链接（`.../docx/TOKEN`），本就不含上述字符，收紧无副作用。
 * 不合规一律丢弃 → 走既有的空链接降级成纯文本。
 *
 * 已知不处理：IDN/punycode 同形字钓鱼（`https://аррӏе.example`）—— 那是视觉混淆而非结构击穿，
 * 且这里的 url 是 bot 自建知识文档的链接（半可信），不做 IDN 归一。
 */
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return /^https?:\/\/[^\s/()[\]<>"'`\\@][^\s()[\]<>"'`\\@]*$/i.test(s) ? s : undefined;
}

/**
 * brandLabel 变量替换：{cwdName}（元数据 name → basename）、{cwd}、{cwdUrl}。
 * 仅当模板含 '{' 时激活（存量签名零影响）；替换后空链接 [x]() 降级为纯文本 x。
 *
 * workingDir 先 expandHome 一次，三个变量共用 —— 否则 {cwdName} 的 basename fallback
 * 与 {cwd} 会吐出字面量 `~`（basename('~') === '~'），与 readDirMeta 读的真实目录不一致。
 */
export function renderBrandTemplate(
  brand: string | undefined,
  workingDir: string | undefined,
): string | undefined {
  if (brand === undefined || !brand.includes('{')) return brand;
  const wd = workingDir ? expandHome(workingDir) : '';
  const meta = wd ? readDirMeta(wd) : {};
  // 单趟替换：避免已替换进去的值（如 name 含 '{cwd}' 字面量）被后续 pass 二次替换。
  // 交替顺序 {cwdName} 在 {cwd} 之前，防前缀吞噬。
  // {cwdName}/{cwd} 落在链接的**文本位**，而它们的 fallback 来自**目录路径** —— 目录名本身
  // 就可以含 `]`（`mkdir 'a]b'` 完全合法），照样能击穿 `[...](...)`。所以路径派生的值也要消毒，
  // 不能只消毒 .botmux-dir.json 里的 name。
  const rendered = brand.replace(/\{cwdName\}|\{cwdUrl\}|\{cwd\}/g, (m) =>
    m === '{cwdName}' ? (wd ? (meta.name ?? safeText(basename(wd))) : '')
    : m === '{cwd}' ? safeText(wd)
    : (meta.url ?? ''));
  return rendered.replace(/\[([^\]]*)\]\(\)/g, '$1');
}
