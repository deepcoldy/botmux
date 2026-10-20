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
import { WORKBENCH_TERM_WRITE_MESSAGE } from '../src/dashboard/web/agent-workbench-terminal-control.js';

function terminalPageSource(): string {
  return readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
}

/** 终端页里一个顶格声明的函数（`function name(){` … 顶格的 `}`），原样抠出来跑。 */
function extractTerminalPageFunction(name: string): string {
  const source = terminalPageSource();
  const start = source.indexOf(`\nfunction ${name}(`);
  expect(start, `worker.ts 里找不到终端页的 ${name}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start + 1);
  expect(end, `${name} 没有正常闭合`).toBeGreaterThan(-1);
  return source.slice(start, end + '\n}'.length);
}

/** 终端页 `var term=new Terminal({…});` 那一句：注入替身构造函数，拿到它真正传给 xterm 的选项。 */
function bootTerminalConstructor(width = 1440, autoFontSize: (width: number) => number = () => 14): {
  options: { theme: Record<string, string>; fontSize: unknown };
} {
  const source = terminalPageSource();
  const start = source.indexOf('var term=new Terminal({');
  expect(start, 'worker.ts 里找不到终端页的 new Terminal').toBeGreaterThan(-1);
  const end = source.indexOf('\n});', start);
  expect(end, 'new Terminal 没有正常闭合').toBeGreaterThan(-1);
  function Terminal(this: { options: unknown }, options: unknown) { this.options = options; }
  return new Function(
    'Terminal', 'isTouch', '_wbAutoFontSize', '_wbTerminalWidth',
    `${source.slice(start, end + '\n});'.length)}\nreturn term;`,
  )(Terminal, false, autoFontSize, () => width);
}

/** 终端画布住在跨文档的 `/s/<sessionId>` iframe 里（src/worker.ts 的内联页面），
 *  父页换 class / 换 CSS 变量都传不进去，配色只能靠 postMessage 递过来。
 *  这一整条链路横跨两个文档、两份源码，任何一侧单方面改都会静默半截：
 *  父页发了、子页不认 → 切了阅读风终端不变色；子页认的键多了一个 → 整条丢弃。
 *  所以这里把子页那段监听器原样抠出来跑，喂父页真实构造的载荷，两侧一起验。 */
function extractTerminalPageListener(): string {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  // 起点是父页 origin 探针，不是主题键表：监听器现在还兼着「记住父页的 origin，好把
  // 这条通道的写权限回报上去」，两段代码是同一块 postMessage 管道，抠一半跑不起来。
  const start = source.indexOf('var _wbParentOrigin=');
  expect(start, 'worker.ts 里找不到终端页的父页 origin 探针').toBeGreaterThan(-1);
  const keys = source.indexOf('var _WB_THEME_KEYS=', start);
  expect(keys, 'worker.ts 里找不到终端页的外观监听器').toBeGreaterThan(-1);
  const anchor = source.indexOf("window.addEventListener('message'", keys);
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

function bootTerminalPage(fixedSize = false): Harness {
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
  // Inject the browser listener dependencies, including remote grid ownership.
  new Function('term', 'fit', 'window', 'fixedSize', extractTerminalPageListener())(term, fit, win, fixedSize);
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
  it('preserves a fixed remote grid when changing terminal appearance', () => {
    const page = bootTerminalPage(true);
    page.fire(workbenchTermAppearanceMessage('reader', 'ink'));
    expect(page.term.options.lineHeight).toBe(WORKBENCH_TERM_LINE_HEIGHTS.reader);
    expect(page.fitCount()).toBe(0);
  });

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

  it('阅读风走 1.15 的行距，经典保持 xterm 默认的 1（「经典 = 原样」）', () => {
    // 1.15 是第三档。最初 1.55：单元格高约 24.5px，CLI 底部那块固定 8 行的 chrome
    // （提示 + 输入框 + 状态条）要吃掉约 196px，一屏四分之一全是 chrome，所以降到 1.3。
    // 1.3 对中文密集的 TUI 内容仍偏松（汉字撑满 em 框，行间空隙观感接近隔行），再收到
    // 1.15 ≈ 18.2px：比经典的 1.0 松一成半，呼吸感在，行与行不再散开。
    expect(WORKBENCH_TERM_LINE_HEIGHTS.reader).toBe(1.15);
    expect(WORKBENCH_TERM_LINE_HEIGHTS.classic).toBe(1);

    const reader = bootTerminalPage();
    reader.fire(workbenchTermAppearanceMessage('reader', 'ink'));
    expect(reader.term.options.lineHeight).toBe(WORKBENCH_TERM_LINE_HEIGHTS.reader);

    const classic = bootTerminalPage();
    classic.fire(workbenchTermAppearanceMessage('classic', 'ink'));
    expect(classic.term.options.lineHeight).toBe(WORKBENCH_TERM_LINE_HEIGHTS.classic);
  });

  // 源码结构护栏(K4)：终端页初始 xterm 主题是 worker.ts 模板字符串里的字面量，import 不进来；
  // 父页 classic 预设必须与它逐键逐色一致，否则没开阅读风的存量用户一进工作台终端就换色。
  // 这里执行那句 new Terminal() 取真实选项再比，不钉字面量的写法。
  it('经典风的色值与终端页里写死的那份逐色相同 —— 没开阅读风的用户零变化', () => {
    const lower = (theme: Record<string, string>) => Object.fromEntries(
      Object.entries(theme).map(([key, value]) => [key, value.toLowerCase()]),
    );
    expect(lower(bootTerminalConstructor().options.theme)).toEqual(lower({ ...WORKBENCH_CLASSIC_TERM_THEME }));
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

  it('接进渲染链路：构造函数按容器宽度取字号，尺寸变化防抖合并后先换档再 fit', () => {
    // ① 初始字号来自字号自适应，而不是写死的 14。
    expect(bootTerminalConstructor(390, width => (width === 390 ? 10.5 : Number.NaN)).options.fontSize).toBe(10.5);

    // ② resize / 转屏 / 容器改宽这条防抖链路：一串事件只落一次，且先复算字号再 fit——
    //    顺序反了 fit 出来的是旧字号下的列数。固定网格由远端定行列，不 fit。
    const run = (fixedSize: boolean) => {
      const calls: string[] = [];
      let pending: (() => void) | null = null;
      const onViewportResize = new Function(
        'setTimeout', 'clearTimeout', '_wbApplyAutoFontSize', 'fit', 'sendResize', 'fixedSize',
        `var _rzT=0;${extractTerminalPageFunction('onViewportResize')}\nreturn onViewportResize;`,
      )(
        (callback: () => void) => { pending = callback; return 1; },
        () => { pending = null; },
        () => { calls.push('font'); return true; },
        { fit: () => { calls.push('fit'); } },
        () => { calls.push('send'); },
        fixedSize,
      ) as () => void;
      for (let burst = 0; burst < 3; burst += 1) onViewportResize();
      expect(calls, '防抖期内什么都不做').toEqual([]);
      (pending as (() => void) | null)?.();
      return calls;
    };
    expect(run(false)).toEqual(['font', 'fit', 'send']);
    expect(run(true)).toEqual(['font', 'send']);
  });

  it('只动画布渲染：字号换档后网格没变就不向后端外发 resize（共享 pty 的列数不被镜像改写）', () => {
    // 终端是共享 pty 的镜像。字号自适应之后的 fit 若落在同一网格上，绝不能再造一条
    // resize 帧——那会让共享的 zellij/tmux pane 白白重排一次。
    const term = { cols: 80, rows: 24 };
    const ws = { readyState: 1, sent: [] as unknown[], send(data: string) { this.sent.push(JSON.parse(data)); } };
    const sendResize = new Function(
      'term', 'ws_',
      `var _lastC=0,_lastR=0;${extractTerminalPageFunction('sendResize')}\nreturn sendResize;`,
    )(term, ws) as () => void;
    sendResize();
    expect(ws.sent).toEqual([{ type: 'resize', cols: 80, rows: 24 }]);
    sendResize();
    expect(ws.sent, '同一网格不重复外发').toHaveLength(1);
    term.cols = 62;
    sendResize();
    expect(ws.sent.at(-1)).toEqual({ type: 'resize', cols: 62, rows: 24 });
    ws.readyState = 3;
    term.rows = 30;
    sendResize();
    expect(ws.sent, '连接没开就不发').toHaveLength(2);
  });
});

/**
 * 反方向的同一条管道：终端 iframe → 工作台的写权限回报。
 *
 * 为什么必须单独验：页面自己那份 `hasToken` 来自 HTTP GET，而 WebSocket 升级是**另
 * 一次**鉴权——iOS WebView 的升级请求不带 Cookie，同一份页面完全可能 HTTP 判可写、
 * WS 只读。worker 在握手完成时把这条连接的真实结论发下来，页面据此收起输入并上抛给
 * 嵌入方。抠出来跑，验的是真正会下发的那份代码。
 */
describe('终端 iframe → 工作台的写权限回报接缝', () => {
  interface WriteReporter {
    set(value: boolean): void;
    origin(): string | null;
  }

  function bootWriteReporter(options: {
    ancestorOrigins?: string[];
    hasToken?: boolean;
    platformReadonly?: boolean;
  } = {}): {
    reporter: WriteReporter;
    posted: Array<{ data: unknown; origin: unknown }>;
    bannerShown(): boolean;
    fireAppearance(origin: string): void;
  } {
    const posted: Array<{ data: unknown; origin: unknown }> = [];
    const handlers: ((event: unknown) => void)[] = [];
    const parent = {
      tag: 'parent-window',
      postMessage(data: unknown, origin: unknown) { posted.push({ data, origin }); },
    };
    const classes = new Set<string>();
    const banner = {
      classList: {
        add: (name: string) => { classes.add(name); },
        remove: (name: string) => { classes.delete(name); },
      },
    };
    const win = {
      parent,
      location: options.ancestorOrigins ? { ancestorOrigins: options.ancestorOrigins } : {},
      addEventListener(type: string, handler: (event: unknown) => void) {
        if (type === 'message') handlers.push(handler);
      },
    };
    const documentStub = { getElementById: (id: string) => (id === 'readonly-banner' ? banner : null) };
    const reporter = new Function(
      'window', 'document', 'term', 'fit', 'hasToken', 'platformReadonly', 'wsHasWrite',
      `${extractTerminalPageListener()}
return {set:_wbSetWsWrite,origin:function(){return _wbParentOrigin}};`,
    )(
      win,
      documentStub,
      { options: {} },
      { fit() {} },
      options.hasToken ?? true,
      options.platformReadonly ?? false,
      null,
    ) as WriteReporter;
    return {
      reporter,
      posted,
      bannerShown: () => classes.has('show'),
      fireAppearance(origin: string) {
        const message = workbenchTermAppearanceMessage('classic', WORKBENCH_SKIN_IDS[0]);
        for (const handler of handlers) handler({ data: message, source: parent, origin });
      },
    };
  }

  it('WS 判只读 → 上抛 write:false 并亮出只读横幅，目标 origin 取 ancestorOrigins', () => {
    const harness = bootWriteReporter({ ancestorOrigins: ['https://dash.example'] });
    expect(harness.reporter.origin()).toBe('https://dash.example');
    harness.reporter.set(false);
    // 消息类型取父页面板真正认的那个常量：任何一侧单方面改名，面板都会静默收不到回报。
    expect(harness.posted).toEqual([{
      data: { type: WORKBENCH_TERM_WRITE_MESSAGE, write: false },
      origin: 'https://dash.example',
    }]);
    // 页面以为自己可写（hasToken=true），这条连接却只读：横幅必须说出来。
    expect(harness.bannerShown()).toBe(true);
    harness.reporter.set(true);
    expect(harness.posted.at(-1)).toEqual({
      data: { type: WORKBENCH_TERM_WRITE_MESSAGE, write: true },
      origin: 'https://dash.example',
    });
    expect(harness.bannerShown()).toBe(false);
  });

  it('拿不到父页 origin 就一个字不发——绝不用星号广播', () => {
    const harness = bootWriteReporter();
    expect(harness.reporter.origin()).toBe(null);
    harness.reporter.set(true);
    expect(harness.posted).toEqual([]);
    // 父页发来的外观消息本身就证明了它的 origin（来源已校验是 window.parent），
    // 靠它补上之后，攒着的结论补发一次。
    harness.fireAppearance('https://dash.example');
    expect(harness.reporter.origin()).toBe('https://dash.example');
    expect(harness.posted).toEqual([{
      data: { type: WORKBENCH_TERM_WRITE_MESSAGE, write: true },
      origin: 'https://dash.example',
    }]);
  });
});
