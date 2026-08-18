import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_CLASSIC_TERM_THEME,
  WORKBENCH_ORCA_TERM_THEMES,
  WORKBENCH_SKIN_IDS,
  WORKBENCH_TERM_STYLES,
  workbenchTermAppearanceMessage,
} from '../src/dashboard/web/agent-workbench-appearance.js';

/** 终端画布住在跨文档的 `/s/<sessionId>` iframe 里（src/worker.ts 的内联页面），
 *  父页换 class / 换 CSS 变量都传不进去，配色只能靠 postMessage 递过来。
 *  这一整条链路横跨两个文档、两份源码，任何一侧单方面改都会静默半截：
 *  父页发了、子页不认 → 切了 Orca 终端不变色；子页认的键多了一个 → 整条丢弃。
 *  所以这里把子页那段监听器原样抠出来跑，喂父页真实构造的载荷，两侧一起验。 */
function extractTerminalPageListener(): string {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  const start = source.indexOf('var _WB_THEME_KEYS=');
  expect(start, 'worker.ts 里找不到终端页的外观监听器').toBeGreaterThan(-1);
  const anchor = source.indexOf("window.addEventListener('message'", start);
  expect(anchor, '监听器没有注册 message 事件').toBeGreaterThan(-1);
  const end = source.indexOf('\n});', anchor);
  expect(end, '监听器没有正常闭合').toBeGreaterThan(-1);
  return source.slice(start, end + '\n});'.length);
}

interface TermStub {
  options: { theme?: Record<string, string>; lineHeight?: number };
}

interface Harness {
  term: TermStub;
  fitCount: () => number;
  /** 终端页自己那个 window，用来模拟「页面发消息给自己」。 */
  selfWindow: unknown;
  /** 默认按「父页发来的」投递；传 source 可以模拟别的窗口冒充。 */
  fire: (data: unknown, source?: unknown) => void;
}

function bootTerminalPage(): Harness {
  const term: TermStub = { options: {} };
  let fits = 0;
  const fit = { fit: () => { fits += 1; } };
  const handlers: ((event: unknown) => void)[] = [];
  const parent = { tag: 'parent-window' };
  const win = {
    parent,
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (type === 'message') handlers.push(handler);
    },
  };
  // 子页那段是浏览器端 ES5 脚本，用 Function 注入它依赖的三个外部符号。
  new Function('term', 'fit', 'window', extractTerminalPageListener())(term, fit, win);
  expect(handlers.length, '监听器没挂上').toBe(1);
  return {
    term,
    fitCount: () => fits,
    selfWindow: win,
    fire(data, source = parent) {
      for (const handler of handlers) handler({ data, source });
    },
  };
}

describe('工作台 → 终端 iframe 的外观下发接缝', () => {
  it('父页构造的 8 种载荷（4 皮肤 × 2 风格）子页全部收下，主题逐色落到 xterm', () => {
    for (const skin of WORKBENCH_SKIN_IDS) {
      for (const termStyle of WORKBENCH_TERM_STYLES) {
        const page = bootTerminalPage();
        // 这里刻意用父页真正发出去的那个构造函数，而不是手搓一个等价对象：
        // 接缝要验的就是「父页实际发的东西子页认不认」。
        page.fire(workbenchTermAppearanceMessage(termStyle, skin));
        const expected = termStyle === 'orca'
          ? WORKBENCH_ORCA_TERM_THEMES[skin]
          : WORKBENCH_CLASSIC_TERM_THEME;
        expect(page.term.options.theme, `${skin}/${termStyle}`).toEqual({ ...expected });
        // 行距变了可视行数就变，必须复算一次。
        expect(page.fitCount(), `${skin}/${termStyle}`).toBe(1);
      }
    }
  });

  it('Orca 走大行距 1.55，经典保持 xterm 默认的 1（「经典 = 原样」）', () => {
    const orca = bootTerminalPage();
    orca.fire(workbenchTermAppearanceMessage('orca', 'orca-ink'));
    expect(orca.term.options.lineHeight).toBe(1.55);

    const classic = bootTerminalPage();
    classic.fire(workbenchTermAppearanceMessage('classic', 'orca-ink'));
    expect(classic.term.options.lineHeight).toBe(1);
  });

  it('经典风的色值与终端页里写死的那份逐色相同 —— 没开 Orca 的用户零变化', () => {
    // 「经典 = 原本 Botmux 预览的真实终端渲染原样」。终端页 new Terminal() 里那份
    // 字面量是既有渲染的唯一事实来源；父页的 classic 预设只要漂一个色，
    // 存量用户一进工作台就会看到终端换色 —— 而这恰恰是 classic 承诺不会发生的事。
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const start = source.indexOf('var term=new Terminal({');
    expect(start).toBeGreaterThan(-1);
    const literal = source.slice(start, source.indexOf('fontSize:', start));
    for (const [key, value] of Object.entries(WORKBENCH_CLASSIC_TERM_THEME)) {
      // 键名按原样匹配（xterm 认的是 selectionBackground，大小写写错就不生效），
      // 色值只比较十六进制本身，不计较大小写。
      const found = new RegExp(`${key}:'(#[0-9a-fA-F]{3,8})'`).exec(literal);
      expect(found, `终端页的 theme 字面量里找不到 ${key}`).not.toBeNull();
      expect(found?.[1].toLowerCase(), `classic ${key}`).toBe(value.toLowerCase());
    }
  });

  it('只认父窗口发来的合法载荷：冒充来源、错类型、脏色值一律丢弃', () => {
    const good = workbenchTermAppearanceMessage('orca', 'warm-graphite');

    // ① 别的窗口冒充（同源的兄弟 iframe、被嵌进来的第三方页面都可能发消息）
    const spoofed = bootTerminalPage();
    spoofed.fire(good, { tag: 'someone-else' });
    expect(spoofed.term.options.theme).toBeUndefined();

    // ② 页面自己发给自己
    const selfSent = bootTerminalPage();
    selfSent.fire(good, selfSent.selfWindow);
    expect(selfSent.term.options.theme).toBeUndefined();

    // ③ 不是这个协议的消息（页面上还会有别的 postMessage 流量）
    const wrongType = bootTerminalPage();
    wrongType.fire({ ...good, type: 'something-else' });
    wrongType.fire(null);
    wrongType.fire('hello');
    expect(wrongType.term.options.theme).toBeUndefined();

    // ④ 颜色不是十六进制字面量 —— 少一个键或掺一个非法值，整条丢弃，
    //    宁可保持现状也不要把半套主题刷到画布上。
    const injected = bootTerminalPage();
    injected.fire({ ...good, theme: { ...good.theme, background: 'url(javascript:1)' } });
    expect(injected.term.options.theme).toBeUndefined();

    const truncated = bootTerminalPage();
    const partial: Record<string, string> = { ...good.theme };
    delete partial.cyan;
    truncated.fire({ ...good, theme: partial });
    expect(truncated.term.options.theme).toBeUndefined();

    // 全程一次 fit 都不该发生：几何契约在被拒的路径上也不许动。
    for (const page of [spoofed, selfSent, wrongType, injected, truncated]) {
      expect(page.fitCount()).toBe(0);
    }
  });
});
