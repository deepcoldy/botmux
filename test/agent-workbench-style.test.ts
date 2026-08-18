import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  workbenchListItemHeight,
  type WorkbenchListItem,
} from '../src/dashboard/web/agent-workbench-model.js';

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
  'orca-ink': {
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
    // 触屏行不跟着桌面一起收窄：44px 的点击目标是无障碍底线。
    expect(heights.at(-1)).toBe(84);
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
});
