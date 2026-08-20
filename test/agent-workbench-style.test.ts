import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  workbenchListItemHeight,
  type WorkbenchListItem,
} from '../src/dashboard/web/agent-workbench-model.js';
import { WORKBENCH_TERM_LINE_HEIGHTS } from '../src/dashboard/web/agent-workbench-appearance.js';

/** 每一条给 `.wb-session-row` 定死高度的规则，按出现顺序。
 *  只认整条 `height` 声明：`min-height` 不是虚拟滚动摆放行的依据。 */
function rowHeights(css: string): number[] {
  return [...css.matchAll(/\.wb-session-row\s*\{([^{}]*)\}/g)]
    .map(match => /(?:^|;)\s*height:\s*(\d+)px/.exec(match[1])?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
}

/** 四套皮肤的完整色值白名单，逐项抄自设计规范「三、4 套配色 tokens」。
 *  这张表就是设计规范在 CI 里的副本：配色是设计定案而不是实现细节，改一个色值
 *  必须同时改规范和这张表，不能让 CSS 单方面漂走。
 *  15 个令牌 = 四层底（L0 页面底 / L1 侧栏 / L2 卡片 / L3 选中&悬浮）
 *            + 三档文字 + 四个语义色 + 保留线 + on-accent + 终端画布 + 计数徽章。 */
const SKIN_TOKENS: Record<string, Record<string, string>> = {
  // 完全中性的灰阶外壳，彩色预算只服务状态与身份。
  'ink': {
    '--bg-l0': '#181818', '--bg-l1': '#212121', '--bg-l2': '#2b2b2b', '--bg-l3': '#3c3c3c',
    '--text-1': '#ededed', '--text-2': '#b8b8b8', '--text-3': '#a6a6a6',
    '--accent': '#ff8b63', '--ok': '#3ed598', '--warn': '#efc260', '--err': '#ff8c8f',
    '--border-keep': '#3f3f3f', '--on-accent': '#181818',
    '--term-bg': '#030303', '--badge-todo': '#eaeaea',
  },
  // 契约默认皮肤：保留产品现有的蓝黑品牌感，只收紧色相、重排台阶、把 meta 提到 AA。
  'slate-blue': {
    '--bg-l0': '#141922', '--bg-l1': '#19212c', '--bg-l2': '#202a36', '--bg-l3': '#333f4e',
    '--text-1': '#e4ebf2', '--text-2': '#afbecd', '--text-3': '#a2b2c3',
    '--accent': '#6fcbf7', '--ok': '#63d6a0', '--warn': '#edb95c', '--err': '#f58a94',
    '--border-keep': '#2e3a48', '--on-accent': '#141922',
    '--term-bg': '#030407', '--badge-todo': '#e6edf4',
  },
  // 灰阶往暖里偏，长时间盯屏更舒服；accent 与 warn 同族，warn 要靠形状再区分一次。
  'warm-graphite': {
    '--bg-l0': '#1b1912', '--bg-l1': '#24211a', '--bg-l2': '#2e2b22', '--bg-l3': '#443e34',
    '--text-1': '#f0ebe1', '--text-2': '#c2baac', '--text-3': '#b3aa9c',
    '--accent': '#f2a33c', '--ok': '#5fce9b', '--warn': '#eac14f', '--err': '#ff9186',
    '--border-keep': '#453f35', '--on-accent': '#1b1912',
    '--term-bg': '#040402', '--badge-todo': '#f2ede3',
  },
  // 浅色族唯一的一套：分层方向反转（L2 纯白浮起、L3 带蓝调下沉），--term-bg 不反转。
  'light-frost': {
    '--bg-l0': '#e8ecf1', '--bg-l1': '#f3f6f9', '--bg-l2': '#ffffff', '--bg-l3': '#c9d7e8',
    '--text-1': '#131820', '--text-2': '#3b4855', '--text-3': '#46525f',
    '--accent': '#0b5f8f', '--ok': '#0f6141', '--warn': '#6b4904', '--err': '#9e2531',
    '--border-keep': '#c2cdda', '--on-accent': '#ffffff',
    '--term-bg': '#16202b', '--badge-todo': '#1b2430',
  },
};

describe('Agent Workbench visual contract', () => {
  const css = readFileSync(join(process.cwd(), 'src/dashboard/web/style.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Agent Workbench'));

  it('分层令牌是唯一配色入口：深色兜底 = slate-blue，历史 --wb-* 只做映射，段内零渐变', () => {
    // 配色从「一把散落的字面量」换成「四层底 + 三档文字 + 语义色」的分层令牌。
    // 没有 data-skin 时，深色兜底必须逐值等于契约默认皮肤 slate-blue，
    // 否则「默认长什么样」会取决于 JS 有没有来得及写上 data-skin。
    for (const [name, value] of Object.entries(SKIN_TOKENS['slate-blue'])) {
      expect(block, `深色兜底 ${name}`).toContain(`${name}: ${value};`);
    }
    // 浅色族兜底仍在（值同 light-frost，由下一条逐项核）。
    expect(block).toContain(':root[data-theme="light"] .agent-workbench-page');

    // 历史 --wb-* 令牌一律映射到新令牌，不许再留写死的色值 —— 这是「换皮肤一次性
    // 生效」的前提：漏一个字面量，那一处就永远停在旧配色上，换皮肤时当场花掉。
    // 原来这里钉的 `--wb-bg: #080b10` 正是被这条规则替换掉的。
    const legacy = [...block.matchAll(
      /(--wb-(?:bg|text|muted|faint|accent|success|warning|danger|focus)):\s*([^;]+);/g,
    )];
    expect(legacy.length).toBeGreaterThanOrEqual(9);
    for (const [, name, value] of legacy) {
      expect(value.trim(), name).toMatch(/^var\(--(?:bg-l0|text-[123]|accent|ok|warn|err)\)$/);
    }

    expect(block).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });

  it('四套皮肤的 15 个色值逐项锁死，与设计规范「三、4 套配色」一字不差', () => {
    for (const [skin, tokens] of Object.entries(SKIN_TOKENS)) {
      // 用 -dock 那一支做锚点：皮肤块的选择器是 `…-page, …-dock {`，
      // 锚在第二支上，紧跟着就是 `{`，取到的正是这套皮肤自己的声明体。
      const anchor = `:root[data-skin="${skin}"] .agent-workbench-dock`;
      const start = block.indexOf(anchor);
      expect(start, `${skin} 皮肤块缺失`).toBeGreaterThan(-1);
      const body = block.slice(start, block.indexOf('}', start));
      for (const [name, value] of Object.entries(tokens)) {
        expect(body, `${skin} ${name}`).toContain(`${name}: ${value};`);
      }
    }
  });

  it('圆角收成三档 + full，段里不留裸像素值', () => {
    // 原来是工作台自带的四级 --wb-radius-{s,m,l,xl} = 4/8/10/12：档位差太小，
    // 一屏之内四个值肉眼像随机，10 与 12 更是分不出来。现在收成 6/10/14 三档
    // （每档 ×1.4 以上才看得出差别）+ 一个只给正圆用的 full，并改读全站 :root 的
    // 统一令牌 —— 所以这里读的是整份 css，不是工作台段。
    // 文件里有两处 :root 都定义了这组令牌，两处都必须一致：只改一处，实际取值就
    // 变成由「谁写在后面」决定。
    const defs = [...css.matchAll(/--radius-(sm|md|lg|full):\s*(\d+)px/g)];
    const expected: Record<string, number> = { sm: 6, md: 10, lg: 14, full: 999 };
    expect([...new Set(defs.map(match => match[1]))].sort()).toEqual(['full', 'lg', 'md', 'sm']);
    for (const [, name, value] of defs) {
      expect(Number(value), `--radius-${name}`).toBe(expected[name]);
    }

    // 其余每一条 border-radius 的每一个分量只能是令牌、0（方角重置：终端原生全铺
    // 之后四角恒 0，按钮组的组内子项也一律 0、圆角由容器裁）或 50%（未读圆点）。
    // 逐分量校验，所以「贴边不圆」的四值写法（右侧抽屉 lg 0 0 lg、贴屏底的移动
    // 下钻容器 lg lg 0 0）合法，而裸像素值一个都过不去。
    // 注释先剥掉：说明文字里出现的 `border-radius: …` 不是声明，不该被当成漂移。
    const declarations = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const values = [...declarations.matchAll(/border-radius:\s*([^;}]+)/g)].map(match => match[1].trim());
    expect(values.length).toBeGreaterThanOrEqual(20);
    const allowed = /^(?:0|50%|var\(--radius-(?:sm|md|lg|full)\))$/;
    const drifted = values.filter(value => !value.split(/\s+/).every(part => allowed.test(part)));
    expect(drifted).toEqual([]);
  });

  it('H5 登录与 Preview 拦截页是各自独立的极简契约，不跟随工作台圆角', () => {
    for (const relative of ['src/dashboard/h5-auth.ts', 'src/dashboard/preview-guard-page.ts']) {
      const source = readFileSync(join(process.cwd(), relative), 'utf8');
      const radii = [...source.matchAll(/border-radius:\s*(\d+)px/g)].map(match => Number(match[1]));
      expect(radii.length, relative).toBeGreaterThan(0);
      expect(Math.max(...radii), relative).toBeLessThanOrEqual(4);
      expect(source, relative).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    }
  });

  it('行高在 CSS 和虚拟化估算之间只有一份契约', () => {
    const row: WorkbenchListItem = {
      kind: 'session',
      key: 'active-session-1',
      group: 'active',
      groupKey: 'active',
      label: '进行中',
      isNeedsYou: false,
      session: { sessionId: 'session-1', status: 'working' },
    };
    const heights = rowHeights(block);
    expect(heights.length).toBeGreaterThanOrEqual(2);
    // 第一条是唯一不在断点里的那条，也就是桌面行高；620px 断点里最后一条生效的是触屏行高。
    // 两个数必须和 workbenchListItemHeight 一字不差：虚拟滚动按它摆放每一行，
    // 对不上列表就会滚过自己的末尾（62→54 那次改动正是从这里开始出问题的）。
    expect(heights[0]).toBe(54);
    expect(heights[0]).toBe(workbenchListItemHeight(row));
    // 触屏行 84 → 60：行内不再堆两行 meta，行高跟着收窄。44px 的指尖目标不再靠
    // 行高兜底，改由行内操作按钮自己的 --touch-target 保证（下面那条用例钉住）。
    expect(heights.at(-1)).toBe(60);
    expect(heights.at(-1)).toBe(workbenchListItemHeight(row, true));
    // 组头两边都是 30px，CSS 里靠 padding + line-height 撑出来，这里只钉住估算侧。
    expect(workbenchListItemHeight({ ...row, kind: 'header', count: 1, collapsed: false })).toBe(30);
  });

  it('组头是可折叠的按钮，折叠箭头有自己的一格', () => {
    // 组头从 div 变成 button：可聚焦、可回车，读屏器才会把它读成可展开的控件。
    expect(block).toContain('.wb-session-group.wb-session-group-toggle');
    // 按钮化之后必须显式清掉 Dashboard 全局按钮样式的 min-height，
    // 否则组头会被撑高、和 30px 的估算差出来的那几像素会一路累积。
    expect(block).toMatch(/\.wb-session-group\.wb-session-group-toggle\s*\{[^{}]*min-height:\s*0/);
    expect(block).toContain('.wb-session-group-caret');
  });

  it('指尖目标按指针类型补齐，宽屏触屏（iPad）不再落空', () => {
    // 44px 那套原先只写在 max-width: 620px 里，横屏 iPad 两头落空。这条钉住的是
    // 「有一个不带宽度上限的 (hover: none) 段」，改回宽度断点就会断。
    const touchBlocks = [...block.matchAll(/@media \(hover: none\)\s*\{/g)]
      .map(match => {
        // 手写一个括号配平扫描：媒体查询里还嵌着规则块，正则数不清层数。
        let depth = 1;
        let index = match.index! + match[0].length;
        for (; index < block.length && depth > 0; index += 1) {
          if (block[index] === '{') depth += 1;
          else if (block[index] === '}') depth -= 1;
        }
        return block.slice(match.index! + match[0].length, index - 1);
      });
    expect(touchBlocks.length).toBeGreaterThanOrEqual(1);
    const touchCss = touchBlocks.join('\n');

    // 三类操作目标：列表行操作、面板/坞的动作按钮、收起后的会话栏。
    for (const selector of ['.wb-session-row-action', '.wb-dock-action-grid a', '.wb-primary-action']) {
      expect(touchCss, selector).toContain(selector);
    }
    const sizes = [...touchCss.matchAll(/(?:min-height|height|min-width|width|grid-template-columns):\s*(\d+)px/g)]
      .map(match => Number(match[1]));
    expect(sizes.length).toBeGreaterThanOrEqual(6);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);

    // 行高是虚拟滚动的摆放依据，只能跟着宽度断点走：这一段碰它就会让列表滚过头。
    expect(touchCss).not.toMatch(/\.wb-session-row\s*\{/);
  });

  it('contains non-color state text and reduced-motion handling', () => {
    expect(block).toContain('.wb-mode-chip');
    expect(block).toContain('.wb-chat-contract');
    expect(block).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('省略号截断的文字，行框装得下中文字形（上下沿不会被 overflow:hidden 削平）', () => {
    // 第三次「裁切」反馈是**竖直方向**的：截断要 overflow:hidden，而 hidden 按盒子裁，
    // 一行文字的内容盒高度就是 line-height。中文字形的墨迹顶满字体 em 盒——实测 12px
    // 字号下 fontBoundingBox 上 11px + 下 3px = 14px，「查 / 看」的 actualBoundingBoxAscent
    // 正好也是 11px。line-height 只有 1.3（15.6px）时半行距 0.8px，逐像素扫出来上沿净空
    // 只剩 0.13px，em 盒更高的中文字体（PingFang SC ≈ 1.4em）直接变负 → 上沿横笔画被削平。
    // 前两轮修的都是 padding-left（左缘），跟这条无关，所以一直没修到。
    // 这里钉两件事，任一漂走都退回那个缺陷：
    //   ① 截断元素必须有 padding-block —— 内边距撑的是**裁切框**，净空与字体度量脱钩；
    //   ② 54px 行高预算算得通 —— 撑行框不能把虚拟滚动的行高契约挤爆。
    const bare = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleBody = (pattern: RegExp, need = 'padding-block') => (
      [...bare.matchAll(pattern)].map(match => match[1]).find(body => body.includes(need)) ?? ''
    );
    const paddingBlock = (body: string) => Number.parseFloat(
      /(?:^|;)\s*padding-block:\s*([\d.]+)px/.exec(body)?.[1] ?? 'NaN',
    );

    // 每一处单行省略号截断都要留出上下净空。名单就是逐像素体检扫出来的那批元素。
    const truncating: Array<[string, RegExp]> = [
      ['会话行标题', /\.wb-session-row\s+\.wb-session-title\s*\{([^{}]*)\}/g],
      ['行 meta 的每一格', /\.wb-session-meta\s*>\s*span:not\(\.wb-session-kind\)\s*\{([^{}]*)\}/g],
      ['行 meta 的时间戳', /\.wb-session-meta\s+time\s*\{([^{}]*)\}/g],
      ['分组组头的组名', /\.wb-session-group-toggle\s*>\s*strong\s*\{([^{}]*)\}/g],
      ['工作区头部会话名', /\.wb-workspace-title\s+strong\s*\{([^{}]*)\}/g],
      ['工作区头部副行', /\.wb-workspace-title\s+small\s*\{([^{}]*)\}/g],
      ['手机下钻页标题', /\.wb-mobile-detail-title\s*\{([^{}]*)\}/g],
      ['坞里的选中会话', /\.wb-dock-selected\s+strong,\s*\n?\s*\.wb-dock-selected\s+span\s*\{([^{}]*)\}/g],
    ];
    for (const [name, pattern] of truncating) {
      const body = ruleBody(pattern);
      expect(body, `${name}要有一条声明 padding-block 的规则`).not.toBe('');
      expect(paddingBlock(body), `${name}的上下内边距`).toBeGreaterThanOrEqual(1);
    }

    // 类型徽标（话题 / 群 / 单聊）反过来：它是 flex:none + 一两个字的固定文案，
    // 永远没有要截断的内容，所以刻意被排除在 overflow:hidden 之外——开了 hidden
    // 就是白架一把裁刀，16px 行框装 11px 中文，遇到 em 盒高的字体照样削平。
    expect(bare, 'meta 行的截断规则必须把徽标排除掉')
      .toMatch(/\.wb-session-meta\s*>\s*span:not\(\.wb-session-kind\)/);

    // 标题行框：中文墨迹按 em 盒画，1.3 是装不下的，至少要 1.4 起步。
    const titleBody = ruleBody(/\.wb-session-row\s+\.wb-session-title\s*\{([^{}]*)\}/g, 'line-height');
    const titleLineHeight = Number.parseFloat(/line-height:\s*([\d.]+)/.exec(titleBody)?.[1] ?? 'NaN');
    expect(titleLineHeight, '标题行框倍数').toBeGreaterThanOrEqual(1.4);

    // 54px 预算复核：行高是虚拟滚动的硬契约，撑行框只能靠行内重新分配。
    // 54 ≥ 上下内边距 + 标题盒 + 行内间距 + meta 行
    const rowBody = [...bare.matchAll(/\.wb-session-row\s*\{([^{}]*)\}/g)]
      .map(match => match[1]).find(body => /(?:^|;)\s*padding:/.test(body)) ?? '';
    const rowPad = /(?:^|;)\s*padding:\s*([^;]+)/.exec(rowBody)?.[1].trim().split(/\s+/) ?? [];
    const padTop = Number.parseFloat(rowPad[0]);
    const padBottom = Number.parseFloat(rowPad[2]);
    const copyBody = [...bare.matchAll(/\.wb-session-row\s+\.wb-session-copy\s*\{([^{}]*)\}/g)]
      .map(match => match[1]).find(body => /gap:/.test(body)) ?? '';
    const gap = Number.parseFloat(/gap:\s*([\d.]+)px/.exec(copyBody)?.[1] ?? '4');
    const titleFontSize = 12;   // 会话栏基准字号，标题不另设 font-size
    const titleBox = titleFontSize * titleLineHeight + 2 * paddingBlock(titleBody);
    const metaBox = 18;         // meta 行由徽标定高：16px 行框 + 1px 亮环 ×2
    const budget = padTop + padBottom + titleBox + gap + metaBox;
    expect(budget, `行内竖直预算（${padTop}+${titleBox}+${gap}+${metaBox}+${padBottom}）必须装进 54px 行高`)
      .toBeLessThanOrEqual(rowHeights(block)[0]);
  });

  it('会话行的左右内边距把字形挡在高亮底板的圆角裁切区之外', () => {
    // 高亮底板是 .wb-session-row::before 那块圆角药丸，行本身始终透明。字形离底板
    // 左缘只有几像素时，圆角边界 + 选中态那条 2px accent 内影会直接压在字上，读起来
    // 就是「行首被切掉一块」——这正是线上反馈的那个缺陷。规范的既有结论是
    // 「文字左内边距 ≥ 圆角半径」，这条把它变成不会再漂走的硬约束。
    // `.wb-session-row {` 在段里出现好几次（虚拟滚动的定位、行高、断点覆盖），
    // 要的是声明了 padding 的那一条；注释先剥掉，免得说明文字里的数字被当成声明。
    const bare = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const rowRule = [...bare.matchAll(/\.wb-session-row\s*\{([^{}]*)\}/g)]
      .map(match => match[1]).find(body => /(?:^|;)\s*padding:/.test(body)) ?? '';
    const padding = /(?:^|;)\s*padding:\s*([^;]+)/.exec(rowRule)?.[1].trim().split(/\s+/) ?? [];
    expect(padding.length, '行的 padding 必须是四值写法（上 右 下 左）').toBe(4);
    const [, right, , left] = padding.map(value => Number.parseFloat(value));

    const boardRule = /\.wb-session-row::before\s*\{([^{}]*)\}/.exec(bare)?.[1] ?? '';
    const inset = /inset:\s*([^;]+)/.exec(boardRule)?.[1].trim().split(/\s+/) ?? [];
    expect(inset.length, '底板的 inset 必须是两值写法（纵 横）').toBe(2);
    const boardSide = Number.parseFloat(inset[1]);
    // 底板圆角取 --radius-lg；半径的数字由上面「圆角收成三档」那条钉死。
    expect(boardRule).toContain('border-radius: var(--radius-lg)');
    const radius = 14;

    expect(left - boardSide, '左内边距距底板左缘').toBeGreaterThanOrEqual(radius);
    // 右边挂的是 meta 行的时间戳，字形底部落在底板下方圆角的水平带里，弧线在那个高度
    // 只内收 2.4px 左右，所以右侧要求比左侧宽松，但仍要留出可见净空。
    expect(right - boardSide, '右内边距距底板右缘').toBeGreaterThanOrEqual(6);
    // 组头的折叠箭头和行的状态标共用一条竖直基线，两者内边距必须一致。
    // ⚠️ 组头有两条规则：基础的 `.wb-session-group` 和更特异的
    // `.wb-session-group.wb-session-group-toggle`（渲染时组头永远带后一个类，所以
    // 生效的是它）。上一轮只改了基础那条，实际渲染的左内边距仍是 2px，箭头整个落在
    // 底板外、离会话栏左缘 3.7px —— 线上第二次反馈的「箭头贴边被切」就是它。
    // 两条都量，缺一条就退回那次漏改。
    const groupPaddings = [
      ['基础规则', /\.wb-session-group\s*\{([^{}]*)\}/g],
      ['生效规则（.wb-session-group-toggle）', /\.wb-session-group\.wb-session-group-toggle\s*\{([^{}]*)\}/g],
    ] as const;
    for (const [name, pattern] of groupPaddings) {
      const rule = [...bare.matchAll(pattern)]
        .map(match => match[1]).find(body => /(?:^|;)\s*padding:/.test(body)) ?? '';
      const groupPadding = /padding:\s*([^;]+)/.exec(rule)?.[1].trim().split(/\s+/) ?? [];
      expect(groupPadding.length, `${name}的 padding 必须是四值写法`).toBe(4);
      expect(Number.parseFloat(groupPadding[3]), `${name}的组头左内边距`).toBe(left);
      expect(Number.parseFloat(groupPadding[1]), `${name}的组头右内边距`).toBe(right);
    }
    // 首列宽度也要一致：组头第一格放折叠箭头、行第一格放状态标，两格左缘同在
    // 22px 上、宽度同为 14px，箭头才真的落在行状态标那一列里。
    const columnsOf = (pattern: RegExp) => (
      [...bare.matchAll(pattern)].map(match => match[1])
        .find(body => /grid-template-columns:/.test(body)) ?? ''
    );
    const firstColumn = (body: string) => Number.parseFloat(
      /grid-template-columns:\s*([^;]+)/.exec(body)?.[1].trim().split(/\s+/)[0] ?? '',
    );
    const rowColumns = firstColumn(columnsOf(/\.wb-session-row\s*\{([^{}]*)\}/g));
    const groupColumns = firstColumn(columnsOf(/\.wb-session-group\.wb-session-group-toggle\s*\{([^{}]*)\}/g));
    expect(rowColumns, '行的状态标列宽').toBe(14);
    expect(groupColumns, '组头的折叠箭头列宽').toBe(rowColumns);
  });

  it('会话栏左缘只有一条首字形基线：栏头圆点 / 搜索图标 / 组头箭头 / 行状态标全部对齐', () => {
    // 上一轮只修了会话行；栏头的 live 圆点停在 12px、搜索框的 ⌕ 停在 20px、组头箭头
    // 停在 3.7px，一条竖线上挤着四个不同的起点，最左那个还压在会话栏边缘上。
    // 这条把「首字形起点」当成一个常量来钉：谁都不许自己另起一条线。
    const bare = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const paddingLeft = (body: string) => {
      const parts = /(?:^|;)\s*padding:\s*([^;]+)/.exec(body)?.[1].trim().split(/\s+/) ?? [];
      if (parts.length === 4) return Number.parseFloat(parts[3]);
      if (parts.length === 2) return Number.parseFloat(parts[1]);
      if (parts.length === 1) return Number.parseFloat(parts[0]);
      return Number.NaN;
    };
    const ruleOf = (pattern: RegExp) => (
      [...bare.matchAll(pattern)].map(match => match[1]).find(body => /(?:^|;)\s*padding:/.test(body)) ?? ''
    );
    const baseline = paddingLeft(ruleOf(/\.wb-session-row\s*\{([^{}]*)\}/g));
    expect(baseline, '会话行的左内边距就是这条基线').toBe(22);

    // 栏头没有圆角底板、不受裁切，但它的 live 圆点是同一列的首字形，落同一条线。
    expect(paddingLeft(ruleOf(/\.wb-rail-heading\s*\{([^{}]*)\}/g)), '栏头左内边距').toBe(baseline);

    // 搜索框是**有**圆角的填充块（--radius-md 10px）：⌕ 到框左缘的距离必须 ≥ 半径，
    // 否则字形会啃到弧线；同时 margin 要与两块 ::before 底板的 8px 内缩线重合，
    // 使 margin + padding 正好落在同一条基线上。
    const searchRule = ruleOf(/\.wb-session-search\s*\{([^{}]*)\}/g);
    const searchMargin = /(?:^|;)\s*margin:\s*([^;]+)/.exec(searchRule)?.[1].trim().split(/\s+/) ?? [];
    expect(searchMargin.length, '搜索框 margin 用三值写法（上 左右 下）').toBe(3);
    const searchSide = Number.parseFloat(searchMargin[1]);
    const searchPad = paddingLeft(searchRule);
    const boardRule = /\.wb-session-row::before\s*\{([^{}]*)\}/.exec(bare)?.[1] ?? '';
    const boardSide = Number.parseFloat(/inset:\s*([^;]+)/.exec(boardRule)?.[1].trim().split(/\s+/)[1] ?? '');
    expect(searchSide, '搜索框外边距与行底板同一条内缩线').toBe(boardSide);
    expect(searchPad, '⌕ 距搜索框左缘必须 ≥ 圆角半径 --radius-md(10)').toBeGreaterThanOrEqual(10);
    expect(searchSide + searchPad, '搜索图标落在同一条基线上').toBe(baseline);
  });

  it('终端外壳的底色跟随实际生效的渲染风格，不是皮肤令牌', () => {
    // 经典渲染的 xterm 底色是它自己的 Tokyo Night #1a1b26，皮肤的 --term-bg 是
    // #030407 一类；外壳那圈 8px 安全边距刷 --term-bg 就会在画布外露出一道更黑的框。
    // 现在外壳读 --term-canvas-bg —— 由 workbenchTermCanvasStyle() 写成内联变量，
    // 取值就是同一次下发给终端 iframe 的那份 theme.background，两边不可能不同色。
    for (const selector of ['.wb-pane', '.wb-pane-frame-shell', '.wb-pane-frame']) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^{}]*)\\}`).exec(block)?.[1] ?? '';
      expect(rule, selector).toMatch(/background:\s*var\(--term-canvas-bg,\s*var\(--term-bg\)\)/);
    }
    // 变量没设上时回落 --term-bg：网页预览面板走的就是这条，改动前后完全一致。
    expect(block).not.toMatch(/\.wb-pane-frame-shell\s*\{[^{}]*background:\s*var\(--term-bg\)\s*;/);
  });

  it('两套渲染风格的 --term-line-height 与 TS 侧的唯一出处一致', () => {
    // 真正落到 xterm 上的是终端页那行 term.options.lineHeight（bridge 测试钉住），
    // CSS 这两个变量只做声明与查阅——但声明错了就会误导下一个改这里的人，
    // 曾经 classic 写着 1.4、实际跑的是 1，就是这么漂出来的。
    for (const [style, expected] of Object.entries(WORKBENCH_TERM_LINE_HEIGHTS)) {
      const rule = new RegExp(`\\.wb-term-${style}\\s*\\{([^{}]*)\\}`).exec(block)?.[1] ?? '';
      const value = /--term-line-height:\s*([\d.]+)/.exec(rule)?.[1];
      expect(value, `.wb-term-${style} 的 --term-line-height`).toBeDefined();
      expect(Number(value), `.wb-term-${style} 的 --term-line-height`).toBe(expected);
    }
    // 阅读风明显比经典松（正文呼吸感），但不至于把底部 chrome 撑到占屏。
    expect(WORKBENCH_TERM_LINE_HEIGHTS.reader).toBeGreaterThan(WORKBENCH_TERM_LINE_HEIGHTS.classic * 1.2);
    expect(WORKBENCH_TERM_LINE_HEIGHTS.reader).toBeLessThanOrEqual(1.35);
  });
});
