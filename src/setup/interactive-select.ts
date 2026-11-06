/**
 * interactive-select.ts
 *
 * 终端可搜索单选器（raw-mode + 输入即过滤 + 方向键），以及在其之上的级联
 * CLI 选择器 {@link pickCliSelection}。
 *
 * 设计同 `botmux list` 的 TUI（alt-screen + ANSI 渲染），但做成可复用、自带
 * stdin 隔离：进入时摘掉 readline 的 'data' 监听、退出时还原，因此可以在一个
 * 持续打开的 readline 会话（botmux setup）中间插入使用，不会和 rl 抢输入。
 * 非 TTY（管道 / 脚本化）下不进入 raw-mode，由调用方走 readline 回退。
 */
import { stdin as input, stdout as output } from 'node:process';

import { CLI_SELECT_TREE, CLI_SELECT_OPTIONS } from './cli-selection.js';
import type { createInterface } from 'node:readline';
import { t, getDefaultLocale, setDefaultLocale } from '../i18n/index.js';
import { setGlobalLocale } from '../global-config.js';

export interface SelectItem {
  /** 主展示文本。 */
  readonly label: string;
  /** 暗色后缀（如 cliId / 命令前缀），仅展示用。 */
  readonly hint?: string;
  /** 仅用于搜索的隐藏文本，例如二级菜单 child 的 key/label。 */
  readonly searchText?: string;
  /** 选中后还有二级菜单（渲染 ▸）。 */
  readonly submenu?: boolean;
}

const ESC = '\x1b';

function isPrintable(s: string): boolean {
  return s.length === 1 && s >= ' ' && s !== '\x7f';
}

/** 近似显示宽度：CJK / 全角按 2，其它按 1（emoji 误差可接受，只用于防换行截断）。 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return w;
}

/** 按显示宽度截断，超出时以 … 结尾。用于把每个列表项压进一行，防止软换行破坏视口高度计算。 */
export function truncateToWidth(s: string, max: number): string {
  if (max <= 1) return s ? '…' : '';
  if (textWidth(s) <= max) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
    if (w + cw > max - 1) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
}

export function matchesSelectItem(item: SelectItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${item.label} ${item.hint ?? ''} ${item.searchText ?? ''}`.toLowerCase().includes(q);
}

/**
 * 计算视口首行，保证光标始终可见：列表超过 capacity 时窗口跟随光标滚动
 * （含首尾 wrap-around），并 clamp 到合法范围。纯函数，单测覆盖。
 */
export function computeViewportTop(cursor: number, top: number, count: number, capacity: number): number {
  if (count <= capacity) return 0;
  let next = top;
  if (cursor < next) next = cursor;
  if (cursor >= next + capacity) next = cursor - capacity + 1;
  return Math.min(Math.max(0, next), count - capacity);
}

function effectiveFooter(footer: string | undefined, allowLangToggle: boolean | undefined): string {
  const toggleHint = allowLangToggle
    ? (getDefaultLocale() === 'zh'
        ? t('setup.footer.lang_toggle_to_en')
        : t('setup.footer.lang_toggle_to_zh'))
    : '';
  return (footer ?? '') + toggleHint;
}

/**
 * Raw-mode 单选 + 输入过滤。返回选中项在 `items` 中的下标；取消（Esc / Ctrl-C）
 * 返回 null。要求处于 TTY；非 TTY 直接返回 null（调用方回退）。
 */
export function interactiveSelect(opts: {
  title: string;
  items: ReadonlyArray<SelectItem>;
  footer?: string;
  allowLangToggle?: boolean;
  onLangToggle?: () => {
    title: string;
    items: ReadonlyArray<SelectItem>;
    footer?: string;
  };
}): Promise<number | null> {
  let currentItems = opts.items;
  let currentTitle = opts.title;
  let currentFooter = opts.footer;
  if (!input.isTTY || !output.isTTY || currentItems.length === 0) return Promise.resolve(null);

  let query = '';
  let cursor = 0;
  let top = 0;
  let filtered: number[] = currentItems.map((_, i) => i);

  function refilter(): void {
    filtered = currentItems
      .map((_, i) => i)
      .filter((i) => matchesSelectItem(currentItems[i], query));
    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    if (cursor < 0) cursor = 0;
  }

  function render(): void {
    // 视口窗口化：列表超过终端高度时只画光标附近的一窗，配 ↑/↓ 溢出指示——
    // 否则超屏内容把界面顶出滚动区，方向键每次重绘又跳回底部，长列表没法选。
    const totalRows = output.rows ?? 24;
    const footerText = effectiveFooter(currentFooter, opts.allowLangToggle);
    const overhead = 5 + (footerText ? 2 : 0) + 2; // 标题/帮助/搜索区 + footer + ↑↓ 指示
    const capacity = Math.max(3, totalRows - overhead);
    top = computeViewportTop(cursor, top, filtered.length, capacity);
    const end = Math.min(filtered.length, top + capacity);
    // 每项压进一行（宽度截断），防软换行破坏高度计算。
    const cols = output.columns ?? 80;

    output.write('\x1b[H\x1b[J');
    output.write(`\x1b[1m ${currentTitle}\x1b[0m\n`);
    output.write(`\x1b[2m ${t('setup.select.hint')}\x1b[0m\n\n`);
    output.write(` \x1b[36m🔍\x1b[0m ${query || `\x1b[2m${t('setup.select.all')}\x1b[0m`}${filtered.length > capacity ? `  \x1b[2m(${cursor + 1}/${filtered.length})\x1b[0m` : ''}\n\n`);

    if (filtered.length === 0) {
      output.write(`   \x1b[2m${t('setup.select.no_matches')}\x1b[0m\n`);
    } else {
      if (top > 0) output.write(`   \x1b[2m${t('setup.select.more_above', { count: top })}\x1b[0m\n`);
      for (let row = top; row < end; row++) {
        const it = currentItems[filtered[row]];
        const selected = row === cursor;
        const pointer = selected ? '\x1b[36m❯\x1b[0m' : ' ';
        const arrow = it.submenu ? ' \x1b[2m▸\x1b[0m' : '';
        // pointer/边距/▸ 约占 8 列；label 优先，hint 用剩余宽度，太窄就整个省掉。
        const label = truncateToWidth(it.label, Math.max(10, cols - 8));
        const hintBudget = cols - 8 - textWidth(label) - 2;
        const hintText = it.hint && hintBudget >= 6 ? truncateToWidth(it.hint, hintBudget) : '';
        const hint = hintText ? `  \x1b[2m${hintText}\x1b[0m` : '';
        const labelOut = selected ? `\x1b[7m ${label} \x1b[0m` : ` ${label} `;
        output.write(` ${pointer} ${labelOut}${hint}${arrow}\n`);
      }
      if (end < filtered.length) output.write(`   \x1b[2m${t('setup.select.more_below', { count: filtered.length - end })}\x1b[0m\n`);
    }
    if (footerText) output.write(`\n \x1b[2m${footerText}\x1b[0m\n`);
  }

  return new Promise<number | null>((resolve) => {
    const prevListeners = input.listeners('data') as Array<(...a: any[]) => void>;
    const prevRaw = input.isRaw ?? false;
    input.removeAllListeners('data');
    try { input.setRawMode(true); } catch { /* 非 raw 终端 */ }
    input.resume();
    input.setEncoding('utf-8');
    output.write('\x1b[?25l\x1b[?1049h'); // hide cursor + alt screen
    render();

    const onResize = (): void => render();

    function cleanup(result: number | null): void {
      input.removeListener('data', onData);
      output.removeListener('resize', onResize);
      output.write('\x1b[?25h\x1b[?1049l'); // show cursor + leave alt screen
      try { input.setRawMode(prevRaw); } catch { /* */ }
      for (const l of prevListeners) input.on('data', l);
      if (prevListeners.length === 0) input.pause();
      resolve(result);
    }

    function onData(key: string): void {
      // Ctrl-C / 裸 Esc → 取消
      if (key === '\x03' || key === ESC) { cleanup(null); return; }

      // L / l 键切换语言（当且仅当允许切换，且当前搜索 query 为空）
      if (opts.allowLangToggle && query === '' && (key === 'l' || key === 'L')) {
        const next = getDefaultLocale() === 'zh' ? 'en' : 'zh';
        setDefaultLocale(next);
        try { setGlobalLocale(next); } catch { /* ignore */ }
        if (opts.onLangToggle) {
          const updated = opts.onLangToggle();
          currentTitle = updated.title;
          currentItems = updated.items;
          currentFooter = updated.footer;
        }
        refilter();
        render();
        return;
      }

      // 方向键 / Ctrl-P / Ctrl-N
      if (key === `${ESC}[A` || key === '\x10') { if (filtered.length) cursor = (cursor - 1 + filtered.length) % filtered.length; render(); return; }
      if (key === `${ESC}[B` || key === '\x0e') { if (filtered.length) cursor = (cursor + 1) % filtered.length; render(); return; }
      // Enter
      if (key === '\r' || key === '\n') {
        if (filtered.length) cleanup(filtered[cursor]);
        return;
      }
      // Backspace
      if (key === '\x7f' || key === '\x08') { query = query.slice(0, -1); refilter(); render(); return; }
      // 普通可打印字符 → 追加到搜索。粘贴 / 快速输入会把多个字符合并成一个
      // chunk 送达，逐字符过滤后整段追加（含控制字符的混合序列仍整体忽略）。
      const printable = [...key].every((ch) => isPrintable(ch));
      if (key.length > 0 && printable) { query += key; cursor = 0; refilter(); render(); return; }
      // 其它（未识别的转义序列等）忽略
    }

    input.on('data', onData);
    output.on('resize', onResize);
  });
}

export interface PickChoiceOptions {
  title: string;
  items: ReadonlyArray<SelectItem>;
  defaultIndex?: number;
  footer?: string;
  allowLangToggle?: boolean;
}

export type PickChoiceFactory = () => PickChoiceOptions;

/**
 * 通用选择题：TTY 下走 {@link interactiveSelect}（↑/↓ + 搜索 + ⏎），非 TTY
 * 回退为「打印带序号列表 + readline 读序号」。setup 里所有"从 N 个选项里挑
 * 一个"的问题统一走这里，与 CLI 适配器选择器同款交互。
 *
 * 返回选中项下标；取消（Esc / Ctrl-C）返回 null，由调用方决定取消语义
 * （保留当前值 / 中止流程）。非 TTY 下留空返回 defaultIndex（未设则 null），
 * 无效输入重问（stdin 关闭时 readline 读到空串 → 走默认值，不会死循环）。
 */
export async function pickChoice(
  rl: ReturnType<typeof createInterface>,
  optsOrFactory: PickChoiceOptions | PickChoiceFactory,
  extra?: { allowLangToggle?: boolean },
): Promise<number | null> {
  const isFactory = typeof optsOrFactory === 'function';
  let opts = isFactory ? optsOrFactory() : optsOrFactory;
  const allowLangToggle = extra?.allowLangToggle ?? opts.allowLangToggle ?? false;

  if (opts.items.length === 0) return null;

  if (!input.isTTY || !output.isTTY) {
    let currentTitle = opts.title;
    let currentItems = opts.items;
    let currentFooter = opts.footer;
    let currentDef = opts.defaultIndex;

    const renderNonTtyMenu = () => {
      const lines = currentItems.map((o, i) => `  ${i + 1}) ${o.label}${o.hint ? `（${o.hint}）` : ''}`);
      const toggleHint = allowLangToggle
        ? (getDefaultLocale() === 'zh'
            ? t('setup.footer.lang_toggle_to_en')
            : t('setup.footer.lang_toggle_to_zh'))
        : '';
      const footerLine = (currentFooter ? `${currentFooter}` : '') + toggleHint;
      output.write(`\n${currentTitle}\n${lines.join('\n')}\n${footerLine ? `(${footerLine})\n` : ''}`);
    };

    renderNonTtyMenu();
    for (;;) {
      const defLabel = currentDef !== undefined ? ` [${currentDef + 1}]` : '';
      const ans = (await new Promise<string>((res) => rl.question(t('setup.select.choose_prompt', { max: currentItems.length, default: defLabel }), res))).trim();
      if (!ans) return currentDef ?? null;
      if (allowLangToggle && (ans === 'l' || ans === 'L')) {
        const next = getDefaultLocale() === 'zh' ? 'en' : 'zh';
        setDefaultLocale(next);
        try { setGlobalLocale(next); } catch { /* */ }
        output.write(`\n${next === 'en' ? t('setup.notice.lang_switched_en') : t('setup.notice.lang_switched_zh')}\n`);
        if (isFactory) {
          opts = optsOrFactory();
          currentTitle = opts.title;
          currentItems = opts.items;
          currentFooter = opts.footer;
          currentDef = opts.defaultIndex;
        }
        renderNonTtyMenu();
        continue;
      }
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= currentItems.length) return n - 1;
      output.write(t('setup.select.invalid_choice', { choice: ans }) + '\n');
    }
  }

  const idx = await interactiveSelect({
    title: opts.title,
    items: opts.items,
    footer: opts.footer,
    allowLangToggle,
    onLangToggle: isFactory ? () => {
      opts = optsOrFactory();
      return {
        title: opts.title,
        items: opts.items,
        footer: opts.footer,
      };
    } : undefined,
  });

  // alt-screen 退出后什么都不留，回显选中项，让上下文可读。
  if (idx !== null && opts.items[idx]) output.write(` ✔ ${opts.title}: ${opts.items[idx].label}\n`);
  return idx;
}

/**
 * 级联 CLI 选择器：顶层列出所有 CLI，带变体的 CLI 进入二级菜单。
 * 返回选择键（CLI_SELECT_OPTIONS 的 key），
 * 取消返回 null。
 *
 * 非 TTY 回退：打印带序号的扁平列表，用 readline 读「序号 / key」。
 */
export async function pickCliSelection(
  rl: ReturnType<typeof createInterface>,
  opts: { title?: string; currentKey?: string } = {},
): Promise<string | null> {
  const title = opts.title ?? t('setup.cli.select_title');

  // ── 非 TTY 回退：序号 / key 文本输入 ──
  if (!input.isTTY || !output.isTTY) {
    const lines = CLI_SELECT_OPTIONS.map((o, i) => `  ${i + 1}) ${o.label} (${o.key})`);
    output.write(`\n${title}\n${lines.join('\n')}\n`);
    const def = opts.currentKey ?? CLI_SELECT_OPTIONS[0].key;
    const ans = (await new Promise<string>((res) => rl.question(t('setup.select.choose_prompt', { max: CLI_SELECT_OPTIONS.length, default: ` [${def}]` }), res))).trim();
    if (!ans) return def;
    const byNum = CLI_SELECT_OPTIONS[Number(ans) - 1];
    if (byNum) return byNum.key;
    const byKey = CLI_SELECT_OPTIONS.find((o) => o.key === ans);
    // 未命中时透传：resolveCliSelection 会解析 traecli 等 alias，或给出明确错误。
    return byKey ? byKey.key : ans;
  }

  // ── TTY：级联 ──
  // 顶层循环：选中带二级菜单的项后进子菜单，子菜单取消则退回顶层。
  for (;;) {
    const topItems: SelectItem[] = CLI_SELECT_TREE.map((g) => ({
      label: g.label,
      hint: g.children ? '' : g.option?.key,
      searchText: g.children
        ? [g.key, ...g.children.flatMap((c) => [c.key, c.label, c.wrapperCli ?? ''])].join(' ')
        : g.option?.key,
      submenu: !!g.children,
    }));
    const ti = await interactiveSelect({ title, items: topItems, footer: t('setup.select.submenu_footer') });
    if (ti === null) return null;
    const group = CLI_SELECT_TREE[ti];
    if (group.option) return group.option.key;
    if (group.children) {
      const subItems: SelectItem[] = group.children.map((c) => ({ label: c.label, hint: c.wrapperCli ?? c.key }));
      const si = await interactiveSelect({ title: `${title} › ${group.label}`, items: subItems, footer: t('setup.select.back_footer') });
      if (si === null) continue; // 退回顶层
      return group.children[si].key;
    }
  }
}
