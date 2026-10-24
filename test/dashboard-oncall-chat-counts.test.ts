import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OncallChatCounts } from '../src/dashboard/web/bot-defaults-page.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Counts = { autoboundChatCount?: number; oncallChatCount?: number | null };

function render(bot: Counts) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(createElement(OncallChatCounts, { bot })); });
  return renderer;
}

/** 计数胶囊里的可见文字（不含悬浮说明的问号）。 */
function chipText(renderer: TestRenderer.ReactTestRenderer): string {
  const chip = renderer.root.findByProps({ 'data-oncall-chat-counts': true });
  return chip.children.filter((c): c is string => typeof c === 'string').join('');
}

function helpText(renderer: TestRenderer.ReactTestRenderer): string {
  const tip = renderer.root.find(node => typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('ui-info-tip'));
  return String(tip.props['aria-label'] ?? '');
}

const zh = createDashboardTranslator('zh');
const en = createDashboardTranslator('en');

describe('Bot 配置页名字行的 oncall 群计数', () => {
  it('当前绑定数与自动绑定过的累计数分开显示，各用各的数（线上：全部已解绑，累计 1052）', () => {
    const r = render({ autoboundChatCount: 1052, oncallChatCount: 0 });
    expect(chipText(r)).toBe(`${zh('botDefaults.oncallBound', { count: 0 })} · ${zh('botDefaults.autobound', { count: 1052 })}`);
    expect(helpText(r)).toBe(zh('botDefaults.autoboundHelp'));
  });

  it('两个数不会互相顶替', () => {
    expect(chipText(render({ autoboundChatCount: 3, oncallChatCount: 2 })))
      .toBe(`${zh('botDefaults.oncallBound', { count: 2 })} · ${zh('botDefaults.autobound', { count: 3 })}`);
  });

  it('旧 daemon 不报当前绑定数时只显示累计数，不拿累计数冒充当前绑定', () => {
    for (const oncallChatCount of [null, undefined]) {
      expect(chipText(render({ autoboundChatCount: 7, oncallChatCount })))
        .toBe(zh('botDefaults.autobound', { count: 7 }));
    }
  });

  it('只有手动绑定时也显示当前绑定数，但不带自动绑定的数和说明', () => {
    const r = render({ autoboundChatCount: 0, oncallChatCount: 25 });
    expect(chipText(r)).toBe(zh('botDefaults.oncallBound', { count: 25 }));
    expect(r.root.findAll(node => typeof node.props.className === 'string'
      && node.props.className.split(' ').includes('ui-info-tip'))).toHaveLength(0);
  });

  it('两个数都没有时不显示', () => {
    expect(render({ autoboundChatCount: 0, oncallChatCount: 0 }).toJSON()).toBeNull();
    expect(render({ autoboundChatCount: 0, oncallChatCount: null }).toJSON()).toBeNull();
    expect(render({}).toJSON()).toBeNull();
  });

  describe('英文', () => {
    afterEach(() => {
      act(() => { ui.setLocale('zh'); });
      vi.unstubAllGlobals();
    });

    it('胶囊和悬浮说明都跟随语言切换', () => {
      const storage = new Map<string, string>();
      vi.stubGlobal('window', {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => { storage.set(key, value); },
          removeItem: (key: string) => { storage.delete(key); },
        },
      });
      vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} } });
      act(() => { ui.setLocale('en'); });

      const r = render({ autoboundChatCount: 1052, oncallChatCount: 0 });
      const text = `${chipText(r)}\n${helpText(r)}`;
      expect(text).toBe(`${en('botDefaults.oncallBound', { count: 0 })} · ${en('botDefaults.autobound', { count: 1052 })}\n${en('botDefaults.autoboundHelp')}`);
      expect(text).not.toMatch(/[一-鿿]/);
    });
  });
});
