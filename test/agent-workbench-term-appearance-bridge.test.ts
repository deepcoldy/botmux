import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_CLASSIC_TERM_THEME,
  WORKBENCH_READER_TERM_THEMES,
  WORKBENCH_SKIN_IDS,
  WORKBENCH_TERM_LINE_HEIGHTS,
  WORKBENCH_TERM_STYLES,
  workbenchTermAppearanceMessage,
} from '../src/dashboard/web/agent-workbench-appearance.js';

/** 终端画布住在跨文档的 `/s/<sessionId>` iframe 里（src/worker.ts 的内联页面），
 *  父页换 class / 换 CSS 变量都传不进去，配色只能靠 postMessage 递过来。
 *  这一整条链路横跨两个文档、两份源码，任何一侧单方面改都会静默半截：
 *  父页发了、子页不认 → 切了阅读风终端不变色；子页认的键多了一个 → 整条丢弃。
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

/** 字号自适应那段同样住在终端页里（`src/worker.ts` 的模板字符串），同样没法 import。
 *  它是这一页唯一的几何输入：字号定死列数就只能被容器宽度被动决定，手机上就是
 *  一行 44 列、字巨大、TUI 换行稀碎。按原样抠出来跑，验的是真正会下发的那份代码。 */
function extractTerminalPageFontSizer(): string {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  const start = source.indexOf('var _WB_FONT_MIN=');
  expect(start, 'worker.ts 里找不到终端页的字号自适应常量').toBeGreaterThan(-1);
  const anchor = source.indexOf('function _wbTerminalWidth(', start);
  expect(anchor, '找不到容器宽度探针').toBeGreaterThan(-1);
  const end = source.indexOf('\n}', anchor);
  expect(end, '容器宽度探针没有正常闭合').toBeGreaterThan(-1);
  return source.slice(start, end + '\n}'.length);
}

interface FontSizer {
  auto: (width: number) => number;
  width: () => number;
  MIN: number;
  MAX: number;
  BASE: number;
  ADVANCE: number;
  TARGET: number;
}

function bootFontSizer(host: { clientWidth: number } | null = null, innerWidth = 0): FontSizer {
  const documentStub = { getElementById: (id: string) => (id === 'terminal' ? host : null) };
  const windowStub = { innerWidth };
  return new Function(
    'document',
    'window',
    `${extractTerminalPageFontSizer()}
return {auto:_wbAutoFontSize,width:_wbTerminalWidth,MIN:_WB_FONT_MIN,MAX:_WB_FONT_MAX,
  BASE:_WB_FONT_BASE,ADVANCE:_WB_FONT_ADVANCE,TARGET:_WB_TARGET_COLS};`,
  )(documentStub, windowStub) as FontSizer;
}

/** 标称列数：xterm 真正的列数由它自己量完字体后 fit() 出来，这里用等宽字体的标称
 *  字宽比复算，用来校验「字号落这一档时列数在不在可读区间」。真实列数由隔离实例
 *  的真浏览器验收兜底（390×844 真 xterm 实测）。 */
function nominalCols(width: number, fontSize: number, advance: number): number {
  return Math.floor(width / (fontSize * advance));
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
        const expected = termStyle === 'reader'
          ? WORKBENCH_READER_TERM_THEMES[skin]
          : WORKBENCH_CLASSIC_TERM_THEME;
        expect(page.term.options.theme, `${skin}/${termStyle}`).toEqual({ ...expected });
        // 行距变了可视行数就变，必须复算一次。
        expect(page.fitCount(), `${skin}/${termStyle}`).toBe(1);
      }
    }
  });

  it('阅读风走大行距 1.3，经典保持 xterm 默认的 1（「经典 = 原样」）', () => {
    // 1.3 而不是最初的 1.55：1.55 下单元格高约 24.5px，CLI 底部那块固定 8 行的 chrome
    // （提示 + 输入框 + 状态条）要吃掉约 196px，一屏四分之一全是 chrome。1.3 仍比经典
    // 的 1.0 松三成，正文呼吸感还在，chrome 收回约 16%。
    expect(WORKBENCH_TERM_LINE_HEIGHTS.reader).toBe(1.3);
    expect(WORKBENCH_TERM_LINE_HEIGHTS.classic).toBe(1);

    const reader = bootTerminalPage();
    reader.fire(workbenchTermAppearanceMessage('reader', 'ink'));
    expect(reader.term.options.lineHeight).toBe(WORKBENCH_TERM_LINE_HEIGHTS.reader);

    const classic = bootTerminalPage();
    classic.fire(workbenchTermAppearanceMessage('classic', 'ink'));
    expect(classic.term.options.lineHeight).toBe(WORKBENCH_TERM_LINE_HEIGHTS.classic);
  });

  it('终端页那行行距字面量与 WORKBENCH_TERM_LINE_HEIGHTS 同源（改一处必须两处一起改）', () => {
    // 终端页住在 worker.ts 的模板字符串里、没法 import，所以行距只能是抄过去的字面量。
    // 上一条已经用真实监听器验过行为；这一条再把源码里那行三元钉死，任何一侧单方面
    // 改数字（比如只改了 CSS 的 --term-line-height）都会在这里断掉。
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const found = /term\.options\.lineHeight=_d\.termStyle==='reader'\?([\d.]+):([\d.]+);/.exec(source);
    expect(found, 'worker.ts 里找不到行距那行三元').not.toBeNull();
    expect(Number(found?.[1])).toBe(WORKBENCH_TERM_LINE_HEIGHTS.reader);
    expect(Number(found?.[2])).toBe(WORKBENCH_TERM_LINE_HEIGHTS.classic);
  });

  it('经典风的色值与终端页里写死的那份逐色相同 —— 没开阅读风的用户零变化', () => {
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
    const good = workbenchTermAppearanceMessage('reader', 'warm-graphite');

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

describe('终端页字号按容器宽度自适应', () => {
  it('手机 390px：字号缩到 10~11px，列数落进 55~70 的可读区间', () => {
    const sizer = bootFontSizer();
    const fontSize = sizer.auto(390);
    expect(fontSize).toBeGreaterThanOrEqual(10);
    expect(fontSize).toBeLessThanOrEqual(11);
    const cols = nominalCols(390, fontSize, sizer.ADVANCE);
    expect(cols).toBeGreaterThanOrEqual(55);
    expect(cols).toBeLessThanOrEqual(70);
    // 修之前是写死的 14px —— 同样宽度只排得下 46 列，正是「字巨大 + 换行稀碎」。
    expect(nominalCols(390, sizer.BASE, sizer.ADVANCE)).toBeLessThan(50);
  });

  it('常见手机宽度（320~430）全部落在下限之上、目标列数附近', () => {
    const sizer = bootFontSizer();
    for (const width of [320, 360, 375, 390, 393, 414, 430]) {
      const fontSize = sizer.auto(width);
      expect(fontSize, `${width}px 字号`).toBeGreaterThanOrEqual(sizer.MIN);
      expect(fontSize, `${width}px 字号`).toBeLessThan(sizer.BASE);
      const cols = nominalCols(width, fontSize, sizer.ADVANCE);
      expect(cols, `${width}px 列数`).toBeGreaterThanOrEqual(55);
      expect(cols, `${width}px 列数`).toBeLessThanOrEqual(70);
    }
  });

  it('桌面维持现状：768 / 1294 / 1920 一律还是基准 14px（存量渲染零变化）', () => {
    const sizer = bootFontSizer();
    expect(sizer.BASE).toBe(14);
    for (const width of [768, 1024, 1294, 1440, 1920, 3840]) {
      expect(sizer.auto(width), `${width}px`).toBe(sizer.BASE);
    }
    // 只缩不放：宽度再大也不会把字号顶上去，14px 就是天花板。
    expect(nominalCols(1294, sizer.auto(1294), sizer.ADVANCE)).toBeGreaterThan(140);
  });

  it('上下限截断：超窄容器停在 9px，任何宽度都不越出 [9,15]', () => {
    const sizer = bootFontSizer();
    expect(sizer.MIN).toBe(9);
    expect(sizer.MAX).toBe(15);
    // 240px（折叠屏外屏 / 极窄分栏）按比例应是 6.5px，被下限截到 9。
    expect(sizer.auto(240)).toBe(sizer.MIN);
    expect(sizer.auto(120)).toBe(sizer.MIN);
    for (let width = 1; width <= 4000; width += 1) {
      const fontSize = sizer.auto(width);
      expect(fontSize, `${width}px 越界`).toBeGreaterThanOrEqual(sizer.MIN);
      expect(fontSize, `${width}px 越界`).toBeLessThanOrEqual(sizer.MAX);
      expect(fontSize, `${width}px 不该放大`).toBeLessThanOrEqual(sizer.BASE);
    }
  });

  it('宽度单调不减：容器变宽绝不会把字号改小（转屏来回切不抖）', () => {
    const sizer = bootFontSizer();
    let previous = 0;
    for (let width = 1; width <= 2000; width += 1) {
      const fontSize = sizer.auto(width);
      expect(fontSize, `${width}px 相对 ${width - 1}px 反向变小`).toBeGreaterThanOrEqual(previous);
      previous = fontSize;
    }
  });

  it('量不到宽度就退回基准字号，绝不缩成 9px 的糊字', () => {
    // 容器还没布局出宽度（隐藏面板、刚插进 DOM 的 iframe）→ 退回视口宽。
    expect(bootFontSizer({ clientWidth: 0 }, 1440).width()).toBe(1440);
    expect(bootFontSizer({ clientWidth: 390 }, 1440).width()).toBe(390);
    // 两个都量不到 → 0 → 保持基准，等尺寸事件到了再纠正。
    const blind = bootFontSizer({ clientWidth: 0 }, 0);
    expect(blind.width()).toBe(0);
    expect(blind.auto(blind.width())).toBe(blind.BASE);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      // Infinity 走的是「只缩不放」那条，同样落在基准上。
      expect(blind.auto(bad), String(bad)).toBe(blind.BASE);
    }
  });

  it('接进渲染链路：构造函数按容器宽度取字号，尺寸变化先换档再 fit', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // ① 初始字号不再是写死的字面量。
    expect(source).toContain('fontSize:_wbAutoFontSize(_wbTerminalWidth())');
    expect(source).not.toContain('fontSize:14,fontFamily');
    // ② resize / 转屏 / 容器改宽这条防抖链路里，先复算字号再 fit——顺序反了算出来
    //    的是旧字号下的列数。
    const start = source.indexOf('function onViewportResize(){');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body.indexOf('_wbApplyAutoFontSize()'))
      .toBeLessThan(body.indexOf('fit.fit()'));
    // ③ 三个触发源都接上：窗口 resize、转屏、容器自身尺寸（自包含，嵌入方不用配合）。
    expect(source).toContain("window.addEventListener('resize',onViewportResize)");
    expect(source).toContain("window.addEventListener('orientationchange',onViewportResize)");
    expect(source).toContain('new ResizeObserver(onViewportResize).observe(_wbHost)');
  });

  it('只动画布渲染：自适应本身不向后端多发一帧（共享 pty 的列数不被镜像改写）', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // 终端是共享 pty 的镜像。字号自适应只能改本页的渲染几何，绝不能自己造一条
    // resize 帧——那会把桌面端正在看的那个 pty 的列数一起改掉。
    const start = source.indexOf('function _wbAutoFontSize(width){');
    const end = source.indexOf('\n}', source.indexOf('function _wbApplyAutoFontSize(){'));
    const block = source.slice(start, end);
    expect(block).not.toContain('ws_');
    expect(block).not.toContain("type:'resize'");
    // 向后端发 resize 的出口全页只有 sendResize 一处，且带列数/行数去重：
    // 落在同一网格上的 fit 不会重复外发。
    expect(source.match(/ws_\.send\(JSON\.stringify\(\{type:'resize'/g)?.length).toBe(1);
    const sender = source.slice(
      source.indexOf('function sendResize(){'),
      source.indexOf('\n}', source.indexOf('function sendResize(){')),
    );
    expect(sender).toContain('if(term.cols===_lastC&&term.rows===_lastR)return;');
  });
});
