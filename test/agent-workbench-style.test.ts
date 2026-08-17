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

describe('Agent Workbench visual contract', () => {
  const css = readFileSync(join(process.cwd(), 'src/dashboard/web/style.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Agent Workbench'));

  it('has semantic dark/light tokens and no gradients', () => {
    expect(block).toContain('--wb-bg: #080b10');
    expect(block).toContain(':root[data-theme="light"] .agent-workbench-page');
    expect(block).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });

  it('每一个圆角都来自四级令牌，段里不留裸像素值', () => {
    // 半径是这一段唯一允许出现像素数字的地方：四个令牌，四个值。多一级、少一级、
    // 或者把 8px 悄悄改成 7px，都会在这里断。
    const tokens = new Map(
      [...block.matchAll(/--wb-radius-(s|m|l|xl):\s*(\d+)px/g)].map(match => [match[1], Number(match[2])]),
    );
    expect([...tokens.keys()].sort()).toEqual(['l', 'm', 's', 'xl']);
    expect(tokens.get('s')).toBe(4);
    expect(tokens.get('m')).toBe(8);
    expect(tokens.get('l')).toBe(10);
    expect(tokens.get('xl')).toBe(12);

    // 其余每一条 border-radius 的每一个分量只能是令牌、0（方角重置）或 50%（未读圆点）。
    // 注释先剥掉：说明文字里出现的 `border-radius: …` 不是声明，不该被当成漂移。
    const declarations = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const values = [...declarations.matchAll(/border-radius:\s*([^;}]+)/g)].map(match => match[1].trim());
    expect(values.length).toBeGreaterThanOrEqual(20);
    const allowed = /^(?:0|50%|var\(--wb-radius-(?:s|m|l|xl)\))$/;
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

  it('contains non-color state text and reduced-motion handling', () => {
    expect(block).toContain('.wb-mode-chip');
    expect(block).toContain('.wb-chat-contract');
    expect(block).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
