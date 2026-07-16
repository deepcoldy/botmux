import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

/** 找出 selector 作为顶层规则（非 @media 内）出现的位置。 */
function topLevelRuleIndex(selector: string): number {
  const pattern = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
  const match = pattern.exec(css);
  return match ? match.index : -1;
}

/** 找出包含 selector 的 @media (max-width: 980px) 块的起始位置。 */
function mobileOverrideIndex(selector: string): number {
  const mediaPattern = /@media \(max-width: 980px\)\s*\{/g;
  for (let match = mediaPattern.exec(css); match; match = mediaPattern.exec(css)) {
    // 从块开头扫到配对的收尾大括号，检查块体内是否声明了该 selector
    let depth = 1;
    let i = mediaPattern.lastIndex;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const body = css.slice(mediaPattern.lastIndex, i);
    if (new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).test(body)) return match.index;
  }
  return -1;
}

describe('sidebar create actions cascade order', () => {
  // 回归：≤980px 横排覆盖与基础规则同 specificity，靠源顺序取胜。
  // 覆盖块若被挪到基础规则之前，窄屏顶部 rail 会退化成两行全宽按钮（PR #491 review P2）。
  it('declares the base rules before the ≤980px override for .sidebar-create-actions', () => {
    const base = topLevelRuleIndex('.sidebar-create-actions');
    const override = mobileOverrideIndex('.sidebar-create-actions');
    expect(base).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(base);
  });

  it('declares the base rules before the ≤980px override for button.sidebar-create-btn', () => {
    const base = topLevelRuleIndex('button.sidebar-create-btn');
    const override = mobileOverrideIndex('button.sidebar-create-btn');
    expect(base).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(base);
  });

  it('keeps the mobile override switching the rail to a horizontal flex row', () => {
    expect(css).toMatch(/@media \(max-width: 980px\)\s*\{\s*\.sidebar-create-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 980px\)\s*\{[\s\S]*?button\.sidebar-create-btn\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  });
});
