import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NAV_ITEMS } from '../src/dashboard/web/nav-items.js';

/**
 * 侧边栏导航有两处真相源：`NAV_ITEMS` 定义每一项，`NAV_GROUPS` 决定分组与
 * 渲染顺序。#948（Calm Console 重构）把侧边栏渲染从「遍历 NAV_ITEMS」改成
 * 「NAV_GROUPS.map(group => group.items.flatMap(byId.get))」——任何在 NAV_ITEMS
 * 里定义、却没被列进某个 group.items 的项，会静默从菜单栏消失（路由和 i18n
 * 都还在，故 URL 仍能直达，症状极隐蔽）。customization tab 就这样漏了。
 */
describe('dashboard sidebar nav grouping', () => {
  // 故意不进侧边栏分组的 nav item id 列在这里（目前没有）。留这张白名单是为了
  // 逼未来的改动显式声明「这一项确实不该出现在菜单栏」，而不是靠沉默把它漏掉。
  const INTENTIONALLY_UNGROUPED = new Set<string>();

  it('keeps NAV_ITEMS and NAV_GROUPS in sync so no nav item silently drops out of the sidebar', () => {
    const ids = new Set(NAV_ITEMS.map(item => item.id));
    const grouped = new Set(NAV_GROUPS.flatMap(group => group.items));
    expect(ids.size).toBeGreaterThan(0);
    const orphans = [...ids].filter(id => !grouped.has(id) && !INTENTIONALLY_UNGROUPED.has(id));
    expect(orphans, `nav items missing from the sidebar menu: ${orphans.join(', ')}`).toEqual([]);
    const ghosts = [...grouped].filter(id => !ids.has(id));
    expect(ghosts, `NAV_GROUPS references unknown ids: ${ghosts.join(', ')}`).toEqual([]);
  });
});
