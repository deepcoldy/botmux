import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  workbenchListItemHeight,
  type WorkbenchListItem,
} from '../src/dashboard/web/agent-workbench-model.js';
import { WORKBENCH_TERM_CANVAS_BG_VAR } from '../src/dashboard/web/agent-workbench-appearance.js';

/** 每一条给 `.wb-session-row` 定死高度的规则，按出现顺序。
 *  只认整条 `height` 声明：`min-height` 不是虚拟滚动摆放行的依据。 */
function rowHeights(css: string): number[] {
  return [...css.matchAll(/\.wb-session-row\s*\{([^{}]*)\}/g)]
    .map(match => /(?:^|;)\s*height:\s*(\d+)px/.exec(match[1])?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
}

describe('Agent Workbench CSS ↔ TS contract', () => {
  const css = readFileSync(join(process.cwd(), 'src/dashboard/web/style.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Agent Workbench'));

  // 源码结构护栏(K4)：会话行的真实高度写在 style.css，虚拟滚动按 workbenchListItemHeight()
  // 摆放每一行；CSS import 不进来，两份数字只能读源码比对。对不上列表就会滚过自己的末尾
  // （原注释记载：行高 62→54 那次改动正是从这里开始出问题的；契约随 #933 引入）。
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
    // 第一条是唯一不在断点里的那条（桌面行高）；最后一条生效的是触屏断点里的行高。
    expect(heights[0]).toBe(workbenchListItemHeight(row));
    expect(heights.at(-1)).toBe(workbenchListItemHeight(row, true));
    // 任何别的地方（比如 (hover: none) 段）都不许另定一个估算侧不知道的行高。
    expect([...new Set(heights)].sort())
      .toEqual([...new Set([workbenchListItemHeight(row), workbenchListItemHeight(row, true)])].sort());
  });

  // 源码结构护栏(K4)：workbenchTermCanvasStyle() 把实际渲染的 xterm 底色写成内联 CSS 变量，
  // 终端外壳必须读这个变量（而不是皮肤令牌 --term-bg），否则经典渲染下画布外露出一圈更黑的边框
  // （#933 外观系统里修过的「经典终端黑色边框」）。变量名是 TS 常量、消费方在 CSS，只能读源码比对。
  it('终端外壳的底色读的是 TS 侧写入的渲染底色变量', () => {
    const bare = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const shell = /\.wb-pane-frame-shell\s*\{([^{}]*)\}/.exec(bare)?.[1] ?? '';
    expect(shell).toMatch(new RegExp(`background:\\s*var\\(${WORKBENCH_TERM_CANVAS_BG_VAR}\\b`));
  });
});
