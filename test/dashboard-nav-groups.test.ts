import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

/**
 * 侧边栏导航有两处真相源：`NAV_ITEMS` 定义每一项，`NAV_GROUPS` 决定分组与
 * 渲染顺序。#948（Calm Console 重构）把侧边栏渲染从「遍历 NAV_ITEMS」改成
 * 「NAV_GROUPS.map(group => group.items.flatMap(byId.get))」——任何在 NAV_ITEMS
 * 里定义、却没被列进某个 group.items 的项，会静默从菜单栏消失（路由和 i18n
 * 都还在，故 URL 仍能直达，症状极隐蔽）。customization tab 就这样漏了。
 *
 * NAV_ITEMS / NAV_GROUPS 都是 app.tsx 的模块私有常量，且 app.tsx 一经 import
 * 就有 DOM 副作用（无法在纯 node 单测里加载），因此这里沿用 dashboard-i18n
 * 测试的做法：静态解析源码文本，做集合差集守卫。
 */
describe('dashboard sidebar nav grouping', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/dashboard/web/app.tsx', import.meta.url)),
    'utf8',
  );

  // 故意不进侧边栏分组的 nav item id 列在这里（目前没有）。留这张白名单是为了
  // 逼未来的改动显式声明「这一项确实不该出现在菜单栏」，而不是靠沉默把它漏掉。
  const INTENTIONALLY_UNGROUPED = new Set<string>();

  const sliceBetween = (start: string, end: string): string => {
    const from = source.indexOf(start);
    expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
    const to = source.indexOf(end, from + start.length);
    expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
    return source.slice(from, to);
  };

  // NAV_ITEMS 块里每个顶层项的 id（icon 的 SVG path 不含 `id:`，不会误匹配）。
  const navItemIds = (): string[] => {
    const block = sliceBetween('const NAV_ITEMS', 'const NAV_GROUPS');
    return [...block.matchAll(/\bid:\s*'([^']+)'/g)].map(m => m[1]);
  };

  // NAV_GROUPS 里各 group 的 `items: [...]` 数组内容（仅取数组内的字符串，
  // 从而排除 group 自身的 id / labelKey）。
  const groupedIds = (): string[] => {
    const block = sliceBetween('const NAV_GROUPS', 'let pinnedPluginNavItems');
    const ids: string[] = [];
    for (const arr of block.matchAll(/items:\s*\[([^\]]*)\]/g)) {
      for (const id of arr[1].matchAll(/'([^']+)'/g)) ids.push(id[1]);
    }
    return ids;
  };

  it('keeps the customization tab in the sidebar menu', () => {
    // 直接钉住本次回归：customization 必须出现在某个分组里。
    expect(groupedIds()).toContain('customization');
  });

  it('assigns every NAV_ITEMS entry to a NAV_GROUPS section', () => {
    const grouped = new Set(groupedIds());
    const orphans = navItemIds().filter(
      id => !grouped.has(id) && !INTENTIONALLY_UNGROUPED.has(id),
    );
    expect(orphans, `nav items missing from the sidebar menu: ${orphans.join(', ')}`).toEqual([]);
  });

  it('references only real NAV_ITEMS ids from NAV_GROUPS', () => {
    const ids = new Set(navItemIds());
    const ghosts = groupedIds().filter(id => !ids.has(id));
    expect(ghosts, `NAV_GROUPS references unknown ids: ${ghosts.join(', ')}`).toEqual([]);
  });
});
