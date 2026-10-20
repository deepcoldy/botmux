import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function dashboardSource(file: string): string {
  return readFileSync(new URL(`../src/dashboard/web/${file}`, import.meta.url), 'utf8');
}

function labelsContainingCustomDropdown(source: string): string[] {
  return [...source.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)]
    .map(match => match[0])
    .filter(label => /<Dropdown(?:Menu|Field)\b/.test(label));
}

describe('dashboard master feature integration', () => {
  // 源码结构护栏(K1)：这是一条跨所有 dashboard 页面的 JSX 结构约束（类似 lint 规则），新页面
  // 也要守住，单测里没有能遍历全部页面的渲染入口。外层 <label> 会隐式关联第一个可 label 的后代，
  // DropdownMenu 的选项是 button，点字段标题就会激活第一项、静默改掉选择（ccb1d8164c 修复）。
  it('does not nest custom dropdowns in labels that activate their first option', () => {
    const webDir = new URL('../src/dashboard/web/', import.meta.url);
    const offenders = readdirSync(webDir)
      .filter(file => file.endsWith('.tsx'))
      .flatMap(file => labelsContainingCustomDropdown(dashboardSource(file)).map(() => file));

    expect(offenders).toEqual([]);
  });
});
