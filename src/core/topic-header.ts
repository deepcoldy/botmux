/**
 * 话题指令头解析器 —— 一条消息里同时交代「可读标题 / 目标仓库 / 模型 / 推理强度 /
 * 首轮任务」。设计见 docs/design/2026-09-10-topic-directive-header.md。
 *
 *   message   := [title] SENTINEL directive* body
 *   SENTINEL  := "/t" | "/topic"                （大小写不敏感，必须是完整 token）
 *   directive := ("/model" | "/effort") WS arg | "/repo" [WS arg] | "/repo" WS "wt" WS target [WS branch]
 *   arg       := token | '"' … '"'              （双引号包裹的参数可含空白）
 *   title     := 不含以 "/" 开头 token 的文字，≤ 3 行，归一化后 ≤ SESSION_TITLE_MAX
 *   body      := 从第一个非指令 token 的原始偏移起的全部原文，原样保留
 *
 * 空白不敏感：换行等价于空格，单行写法与多行写法解析结果逐字相同。唯一例外是 `/repo wt`
 * 的可选分支：只在下一个 token **匹配分支粗模式且与目标同一行**时才吃（设计 R5），所以
 * `/repo wt botmux ⏎ fix login bug` 里 `fix` 是正文，而 `/repo wt botmux fix login bug` 里
 * `fix` 是分支——用法串因此写明「latin 正文请换行」。
 *
 * 三种返回值的含义各不相同，调用方必须分开处理：
 *   - `null`      —— 这不是指令头，按普通消息/原有 `/t` 路径继续走；
 *   - 错误对象     —— 用户已经写了 `/t` 且明确用了头部语法，但写错了 → fail closed，
 *                    回一句用法错误、零副作用（决策 D5）；
 *   - 头部对象     —— 解析成功，交给 resolveTopicSpec 做语义校验。
 *
 * 纯函数：不读配置、不碰文件系统、不认识任何会话状态。仓库/模型/推理强度的**语义**
 * 校验属于 {@link ../core/topic-spec.js resolveTopicSpec}，这里只管**语法**。
 *
 * 放在独立 leaf 模块（而非 command-handler.ts）是为了让解析器与 topic-spec 都能被
 * 单测直接 import，不必拖进整张 daemon 依赖图；command-handler 重新导出它，沿用
 * `validateWorkingDir` → working-dir.ts 那条既有惯例。
 */
import { SESSION_TITLE_MAX, normalizeSessionTitle } from './session-board.js';

/** 头部白名单指令。刻意只有三条：`/rename` 由标题行取代，`/role` `/cd` 第一版不进（D4）。 */
export const TOPIC_HEADER_DIRECTIVES = ['repo', 'model', 'effort'] as const;
export type TopicHeaderDirective = typeof TOPIC_HEADER_DIRECTIVES[number];

const DIRECTIVE_BY_TOKEN = new Map<string, TopicHeaderDirective>(
  TOPIC_HEADER_DIRECTIVES.map(d => [`/${d}`, d]),
);

/**
 * 允许省略参数的指令。
 *
 * 只有 `/repo` 有裸形式，因为它今天就有：`/t /repo` 一直等于选仓卡上的「直接开始」
 * ——在默认工作目录起会话、不弹卡。这是既有用户的使用习惯，头部语法必须原样兼容。
 * `/model` `/effort` 没有对应语义，缺参数仍然是写错了。
 */
const BARE_FORM_DIRECTIVES: ReadonlySet<TopicHeaderDirective> = new Set(['repo']);

/**
 * 分支名的**消费用粗模式**（设计 R5）：latin/数字开头、`[A-Za-z0-9._/-]`、无 `..`、限长。
 * 中文正文永远不匹配，所以单行 `/repo wt botmux 简单确认一下` 不会把正文吃成分支。
 * 这只是「像不像分支」；**合法性**由 topic-spec 的 `git check-ref-format` 兜底，两层不同：
 * 不匹配粗模式的 token 是正文，匹配粗模式但 git 拒绝的 token 是错误。
 */
export const BRANCH_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BRANCH_TOKEN_MAX = 200;

export function looksLikeBranchToken(text: string): boolean {
  return text.length <= BRANCH_TOKEN_MAX && BRANCH_TOKEN_RE.test(text) && !text.includes('..');
}

/** 标题最多几行——超过就判定「这不是指令头」，避免长文里的 `/t` 误触发。 */
const TITLE_MAX_LINES = 3;

/** `/repo wt <目标> [分支]` 的原始参数；语义校验（目标可解析、分支合法、目录不存在）在 topic-spec。 */
export interface TopicHeaderWorktree {
  target: string;
  branch?: string;
}

/** 分隔符：`/t` `/topic` 是通用形式；`/th` `/tw` 是生命周期别名（等价 `/t here` / `/t worktree`）。 */
export type TopicHeaderSentinel = '/t' | '/topic' | '/th' | '/tw';

/**
 * 生命周期变体：话题从**当前群会话的工作目录**起（`here`），或先从该目录建一个按话题
 * 确定性命名的 worktree 再起（`worktree`）。写法四选一：`/th` `/tw` `/t here` `/t worktree`
 * （`/topic` 同 `/t`）。它与 `/repo …` 相斥——一个说「用当前目录」，一个点名仓库；
 * 相斥的组合由 resolveTopicSpec 拒绝，不做静默优先级。
 */
export type TopicLifecycle = 'here' | 'worktree';

const SENTINEL_LIFECYCLE: Partial<Record<TopicHeaderSentinel, TopicLifecycle>> = { '/th': 'here', '/tw': 'worktree' };
const LIFECYCLE_BY_TOKEN: ReadonlyMap<string, TopicLifecycle> = new Map([['here', 'here'], ['worktree', 'worktree']]);

export interface TopicHeader {
  ok: true;
  /** 用户实际敲的分隔符（已归一化大小写），供日志与授权提示复用原文措辞。 */
  sentinel: TopicHeaderSentinel;
  /** 生命周期变体（见 {@link TopicLifecycle}）；通用 `/t` 缺席。 */
  lifecycle?: TopicLifecycle;
  /** 归一化后的可读标题；没写标题时缺席。 */
  title?: string;
  /** 头部指令的**原始参数**（已脱掉包裹的双引号），语义校验留给 resolveTopicSpec。
   *  值为 `null` 表示指令写了但没带参数（只有 `/repo` 允许，见 BARE_FORM_DIRECTIVES）。 */
  directives: Partial<Record<TopicHeaderDirective, string | null>>;
  /** `/repo wt …` 子形式。与 `directives.repo` 互斥（两者都算「写了 /repo」，重复即拒）。 */
  worktree?: TopicHeaderWorktree;
  /** 首轮任务正文，从第一个非指令 token 的原始偏移起原样保留（仅去掉尾部空白）。 */
  prompt: string;
}

/** 拒绝原因本身（不含分隔符），拼提示文案时按 `kind` 分派。 */
export type TopicHeaderErrorReason =
  | { kind: 'missing_arg'; directive: TopicHeaderDirective }
  | { kind: 'duplicate_directive'; directive: TopicHeaderDirective }
  | { kind: 'unknown_directive'; token: string }
  /** `/repo wt` 后面没有目标仓库（`/t /repo wt`、`/t /repo wt /model x`）。 */
  | { kind: 'missing_worktree_target' };

/** 拒绝结果一并带上用户实际敲的分隔符，授权提示与错误文案都用它的原文措辞。 */
export type TopicHeaderError = { ok: false; sentinel: TopicHeaderSentinel } & TopicHeaderErrorReason;

export type TopicHeaderParse = TopicHeader | TopicHeaderError | null;

/** 类型收窄助手：解析结果是不是一个可用的头部。 */
export function isTopicHeader(parsed: TopicHeaderParse): parsed is TopicHeader {
  return parsed !== null && parsed.ok === true;
}

/** 类型收窄助手：解析结果是不是一条「写错了」的拒绝。 */
export function isTopicHeaderError(parsed: TopicHeaderParse): parsed is TopicHeaderError {
  return parsed !== null && parsed.ok === false;
}

/**
 * 在**已有会话**的话题里，这个头部是不是真的在声明会话规格（决策 D6 的边界）。
 *
 * 三种情况分别对待：
 *   - 带任一指令（`/repo` `/model` `/effort`）→ true。这些状态只能在会话诞生那一刻落地，
 *     进行中的话题里半截生效（换了模型却没换仓库）比直接报错难查得多。
 *   - 只有标题、正文为空（`新标题 /t`）→ true。没有别的解释，用户就是想改标题，
 *     该告诉他这里不生效（改标题用 `/rename`）。
 *   - 只有标题、正文非空、零指令（`关于 /t 这个命令`）→ **false**，放行给 CLI。
 *     这种形状绝大多数是在聊天里提到 `/t` 这个命令本身；把它整条吞掉（用户看到一句
 *     「只在新话题第一条生效」而 CLI 什么都没收到）比漏判一次改标题意图糟得多，
 *     何况改标题本来就有 `/rename`。裸 `/t` 与 `/t 文案` 同样返回 false，行为不变。
 *
 * 只有 thread 路径用它。新话题路径不看这个谓词——那里任何解析成功的头部都照常生效。
 */
export function topicHeaderDeclaresSpec(header: TopicHeader): boolean {
  if (Object.keys(header.directives).length > 0 || header.worktree !== undefined || header.lifecycle !== undefined) return true;
  return header.title !== undefined && header.prompt === '';
}

interface Token {
  /** token 文本（双引号包裹时是去掉引号后的内容）。 */
  readonly text: string;
  /** 在原文中的起始偏移——正文按这个偏移原样切出来。 */
  readonly start: number;
  /** 在原文中的结束偏移（不含）；`/repo wt` 的可选分支用它判断「与目标同一行」。 */
  readonly end: number;
  /** 是否由双引号包裹：被包裹的 token 永远是字面量，不会当成指令/分隔符。 */
  readonly quoted: boolean;
}

/**
 * 按空白切 token 并记录原始偏移，双引号包裹的片段整体算一个 token。
 *
 * 引号只在「完整包裹且右引号后紧跟空白或行尾」时生效；`a"b"c` 这种嵌在中间的引号
 * 按普通字符处理，免得把路径里的引号解释成语法。
 */
function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < content.length) {
    if (/\s/.test(content[i]!)) { i += 1; continue; }
    const start = i;
    if (content[i] === '"') {
      const close = content.indexOf('"', i + 1);
      const after = close >= 0 ? content[close + 1] : undefined;
      if (close > i && (after === undefined || /\s/.test(after))) {
        tokens.push({ text: content.slice(i + 1, close), start, end: close + 1, quoted: true });
        i = close + 1;
        continue;
      }
    }
    while (i < content.length && !/\s/.test(content[i]!)) i += 1;
    tokens.push({ text: content.slice(start, i), start, end: i, quoted: false });
  }
  return tokens;
}

/** 完整 token 形式的 `/t` `/topic` `/th` `/tw`（大小写不敏感）；`/tea` `/topical` `/two` 不匹配。 */
function sentinelOf(token: Token): TopicHeaderSentinel | undefined {
  if (token.quoted) return undefined;
  const lower = token.text.toLowerCase();
  return lower === '/t' || lower === '/topic' || lower === '/th' || lower === '/tw' ? lower : undefined;
}

/**
 * 解析标题区：分隔符之前的原文。
 *
 * 返回 `undefined` 表示「没有标题」（分隔符就在开头），返回 `null` 表示**这不是指令头**
 * ——标题区里出现了以 `/` 开头的 token、行数超限或长度超限。后者是防误触的护栏：
 * 长文里第 40 行恰好有个 `/t` 不会被当成开话题。
 */
function parseTitle(raw: string, tokensBefore: Token[]): string | null | undefined {
  if (raw.trim() === '') return undefined;
  // 引号包裹的 token 是字面量，不算「以 / 开头的命令」。
  if (tokensBefore.some(t => !t.quoted && t.text.startsWith('/'))) return null;
  if (raw.trim().split(/\r?\n/).length > TITLE_MAX_LINES) return null;
  // 与 normalizeSessionTitle 同一套长度口径，但**先判长度再交给它**：那个函数是
  // 截断语义，直接调用会把超长标题悄悄截短，而这里超长必须判定为「不是指令头」。
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length > SESSION_TITLE_MAX) return null;
  // 归一化失败（只剩控制字符）→ 当作没写标题，而不是判定非头部。
  return normalizeSessionTitle(collapsed) ?? undefined;
}

/**
 * 解析一条消息的话题指令头。
 *
 * `content` 必须**已经剥掉对本 bot 的所有 @**（见 message-parser 的
 * `stripBotMentions`）——@ 的位置与解析无关（D8），但残留的 `@名字` 会占住 token 位。
 */
export function parseTopicHeader(content: string): TopicHeaderParse {
  const tokens = tokenize(content);
  const sentinelIndex = tokens.findIndex(t => sentinelOf(t) !== undefined);
  if (sentinelIndex < 0) return null;
  const sentinel = sentinelOf(tokens[sentinelIndex]!)!;

  const title = parseTitle(
    content.slice(0, tokens[sentinelIndex]!.start),
    tokens.slice(0, sentinelIndex),
  );
  if (title === null) return null;

  const directives: Partial<Record<TopicHeaderDirective, string | null>> = {};
  let worktree: TopicHeaderWorktree | undefined;
  let i = sentinelIndex + 1;
  // 生命周期变体：`/th` `/tw` 自带；`/t` `/topic` 紧跟的裸 `here` / `worktree` 一词被吃掉
  //（引号包裹的是字面量正文）。别名之后不再吃变体词：`/th here` 的正文就是 `here`。
  let lifecycle: TopicLifecycle | undefined = SENTINEL_LIFECYCLE[sentinel];
  const variant = tokens[i];
  if (lifecycle === undefined && variant && !variant.quoted) {
    lifecycle = LIFECYCLE_BY_TOKEN.get(variant.text.toLowerCase());
    if (lifecycle !== undefined) i += 1;
  }
  for (; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.quoted) break;
    const directive = DIRECTIVE_BY_TOKEN.get(token.text.toLowerCase());
    if (!directive) {
      // 「用户已经写了头部」才对未知 `/xxx` fail closed。否则这只是今天的
      // `/t <文案>`：`/t /goal 干活`、`/t /close` 等既有冷启动/命令用法必须原样
      // 落到 parseSlashCommandInvocation，不能被解析器提前拒掉（D9 向后兼容）。
      const claimed = title !== undefined || worktree !== undefined || lifecycle !== undefined || Object.keys(directives).length > 0;
      if (claimed && token.text.startsWith('/')) {
        return { ok: false, sentinel, kind: 'unknown_directive', token: token.text };
      }
      break;
    }
    if (directives[directive] !== undefined || (directive === 'repo' && worktree !== undefined)) {
      return { ok: false, sentinel, kind: 'duplicate_directive', directive };
    }
    const arg = tokens[i + 1];
    // `/repo wt <目标> [分支]`：目标必选；分支可选，只在「匹配分支粗模式 + 与目标同一行 +
    // 不是另一条指令」时吃（R5 两条规则）。引号包裹的 `"wt"` 是字面量，走普通 `/repo` 分支。
    if (directive === 'repo' && arg && !arg.quoted && arg.text.toLowerCase() === 'wt') {
      const target = tokens[i + 2];
      if (!target
        || (!target.quoted && DIRECTIVE_BY_TOKEN.has(target.text.toLowerCase()))
        || target.text.trim() === '') {
        return { ok: false, sentinel, kind: 'missing_worktree_target' };
      }
      worktree = { target: target.text };
      i += 2;
      const branch = tokens[i + 1];
      if (branch && !branch.quoted
        && !DIRECTIVE_BY_TOKEN.has(branch.text.toLowerCase())
        && !content.slice(target.end, branch.start).includes('\n')
        && looksLikeBranchToken(branch.text)) {
        worktree.branch = branch.text;
        i += 1;
      }
      continue;
    }
    // 没有参数：结尾就没有下一个 token，或下一个 token 是另一条头部指令
    //（`/t /repo /model x` —— 把 `/model` 当仓库名只会得到一句莫名其妙的报错）。
    // `/repo` 有裸形式，记成 null 交给语义层；其余指令是写错了。
    if (!arg || (!arg.quoted && DIRECTIVE_BY_TOKEN.has(arg.text.toLowerCase()))) {
      if (!BARE_FORM_DIRECTIVES.has(directive)) {
        return { ok: false, sentinel, kind: 'missing_arg', directive };
      }
      directives[directive] = null;
      continue;
    }
    // 显式写了参数、里面却是空的（`/repo ""`、`/model "   "`）——这是写错了，不是裸形式。
    // 必须放在裸形式分支**之后**：折进上面那个条件会把 `/repo ""` 悄悄重定义成「默认目录
    // 开会话」，给一个多半来自模板/复制粘贴事故的 token 编一个意思出来。放在这里，三条
    // 指令都落到同一个 missing_arg，不必新增错误种类与文案。
    if (arg.text.trim() === '') {
      return { ok: false, sentinel, kind: 'missing_arg', directive };
    }
    directives[directive] = arg.text;
    i += 1;
  }

  const bodyStart = tokens[i]?.start;
  const prompt = bodyStart === undefined ? '' : content.slice(bodyStart).replace(/\s+$/, '');
  return {
    ok: true,
    sentinel,
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(title !== undefined ? { title } : {}),
    directives,
    ...(worktree !== undefined ? { worktree } : {}),
    prompt,
  };
}
