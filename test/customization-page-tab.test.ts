import { describe, expect, it } from 'vitest';
import { resolveCustomizationTab } from '../src/dashboard/web/customization-page.js';

/**
 * The tab the 「自定义」 page shows for a scope: whatever was selected before
 * (under the other platform, or before the WeCom roster flipped), the WeCom
 * scope never shows the built-in Skill section, and no scope shows a stage it
 * does not list. The Feishu scope keeps every selection it offers.
 */
describe('resolveCustomizationTab', () => {
  const feishuStages = ['new', 'followup', 'send'] as const;
  const wecomStages = ['new', 'followup'] as const;

  it('never yields the Skill section for the WeCom scope', () => {
    expect(resolveCustomizationTab('skills', 'wecom', wecomStages)).toBe('new');
  });

  it('falls back to the first listed stage for a stage the scope does not list', () => {
    expect(resolveCustomizationTab('send', 'wecom', wecomStages)).toBe('new');
    expect(resolveCustomizationTab('followup', 'wecom', ['followup'])).toBe('followup');
  });

  it('keeps every Feishu selection, Skill section included', () => {
    for (const tab of [...feishuStages, 'skills'] as const) expect(resolveCustomizationTab(tab, 'feishu', feishuStages)).toBe(tab);
    expect(resolveCustomizationTab('followup', 'wecom', wecomStages)).toBe('followup');
  });
});
