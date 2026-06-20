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

export interface SelectItem {
  /** 主展示文本。 */
  readonly label: string;
  /** 暗色后缀（如 cliId / 命令前缀），仅展示用。 */
  readonly hint?: string;
  /** 选中后还有二级菜单（渲染 ▸）。 */
  readonly submenu?: boolean;
}

const ESC = '\x1b';

function isPrintable(s: string): boolean {
  return s.length === 1 && s >= ' ' && s !== '\x7f';
}

/**
 * Raw-mode 单选 + 输入过滤。返回选中项在 `items` 中的下标；取消（Esc / Ctrl-C）
 * 返回 null。要求处于 TTY；非 TTY 直接返回 null（调用方回退）。
 */
export function interactiveSelect(opts: {
  title: string;
  items: ReadonlyArray<SelectItem>;
  footer?: string;
}): Promise<number | null> {
  const { items } = opts;
  if (!input.isTTY || !output.isTTY || items.length === 0) return Promise.resolve(null);

  let query = '';
  let cursor = 0;
  let filtered: number[] = items.map((_, i) => i);

  function refilter(): void {
    const q = query.trim().toLowerCase();
    filtered = items
      .map((_, i) => i)
      .filter((i) => !q || `${items[i].label} ${items[i].hint ?? ''}`.toLowerCase().includes(q));
    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    if (cursor < 0) cursor = 0;
  }

  function render(): void {
    output.write('\x1b[H\x1b[J');
    output.write(`\x1b[1m ${opts.title}\x1b[0m\n`);
    output.write(`\x1b[2m 输入可搜索 · ↑/↓ 选择 · ⏎ 确认 · Esc 取消\x1b[0m\n\n`);
    output.write(` \x1b[36m🔍\x1b[0m ${query || '\x1b[2m(全部)\x1b[0m'}\n\n`);

    if (filtered.length === 0) {
      output.write(`   \x1b[2m无匹配项\x1b[0m\n`);
    } else {
      for (let row = 0; row < filtered.length; row++) {
        const it = items[filtered[row]];
        const selected = row === cursor;
        const pointer = selected ? '\x1b[36m❯\x1b[0m' : ' ';
        const arrow = it.submenu ? ' \x1b[2m▸\x1b[0m' : '';
        const hint = it.hint ? `  \x1b[2m${it.hint}\x1b[0m` : '';
        const label = selected ? `\x1b[7m ${it.label} \x1b[0m` : ` ${it.label} `;
        output.write(` ${pointer} ${label}${hint}${arrow}\n`);
      }
    }
    if (opts.footer) output.write(`\n \x1b[2m${opts.footer}\x1b[0m\n`);
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

    function cleanup(result: number | null): void {
      input.removeListener('data', onData);
      output.write('\x1b[?25h\x1b[?1049l'); // show cursor + leave alt screen
      try { input.setRawMode(prevRaw); } catch { /* */ }
      for (const l of prevListeners) input.on('data', l);
      if (prevListeners.length === 0) input.pause();
      resolve(result);
    }

    function onData(key: string): void {
      // Ctrl-C / 裸 Esc → 取消
      if (key === '\x03' || key === ESC) { cleanup(null); return; }
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
      // 普通可打印字符 → 追加到搜索
      if (isPrintable(key)) { query += key; cursor = 0; refilter(); render(); return; }
      // 其它（未识别的转义序列等）忽略
    }

    input.on('data', onData);
  });
}

/**
 * 级联 CLI 选择器：顶层列出所有 CLI（Aiden 带 ▸），选 Aiden 进二级菜单
 * （原生 / × Claude / × Codex）。返回选择键（CLI_SELECT_OPTIONS 的 key），
 * 取消返回 null。
 *
 * 非 TTY 回退：打印带序号的扁平列表，用 readline 读「序号 / key」。
 */
export async function pickCliSelection(
  rl: ReturnType<typeof createInterface>,
  opts: { title?: string; currentKey?: string } = {},
): Promise<string | null> {
  const title = opts.title ?? '选择 CLI 适配器';

  // ── 非 TTY 回退：序号 / key 文本输入 ──
  if (!input.isTTY || !output.isTTY) {
    const lines = CLI_SELECT_OPTIONS.map((o, i) => `  ${i + 1}) ${o.label} (${o.key})`);
    output.write(`\n${title}\n${lines.join('\n')}\n`);
    const def = opts.currentKey ?? CLI_SELECT_OPTIONS[0].key;
    const ans = (await new Promise<string>((res) => rl.question(`选择 [${def}]: `, res))).trim();
    if (!ans) return def;
    const byNum = CLI_SELECT_OPTIONS[Number(ans) - 1];
    if (byNum) return byNum.key;
    const byKey = CLI_SELECT_OPTIONS.find((o) => o.key === ans);
    return byKey ? byKey.key : ans; // 透传：让上层 resolveCliSelection 抛错给出明确提示
  }

  // ── TTY：级联 ──
  // 顶层循环：选中带二级菜单的项后进子菜单，子菜单取消则退回顶层。
  for (;;) {
    const topItems: SelectItem[] = CLI_SELECT_TREE.map((g) => ({
      label: g.label,
      hint: g.children ? '' : g.option?.key,
      submenu: !!g.children,
    }));
    const ti = await interactiveSelect({ title, items: topItems, footer: '选 Aiden 进入子菜单（× Claude / × Codex）' });
    if (ti === null) return null;
    const group = CLI_SELECT_TREE[ti];
    if (group.option) return group.option.key;
    if (group.children) {
      const subItems: SelectItem[] = group.children.map((c) => ({ label: c.label, hint: c.wrapperCli ?? c.key }));
      const si = await interactiveSelect({ title: `${title} › ${group.label}`, items: subItems, footer: 'Esc 返回上一级' });
      if (si === null) continue; // 退回顶层
      return group.children[si].key;
    }
  }
}
