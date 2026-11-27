/**
 * 英文界面下，企业微信的配置区块（授权与额度、可操作终端开关、额度耗尽交接、对话权限用户可用的命令、
 * /summary 总结范围、配置读写的报错）渲染出来的可见文字里没有汉字，也没有漏翻成原样的文案键。中文界面下
 * 同一批场景渲染出汉字，证明场景确实覆盖了要翻译的文字。夹具数据全部是 ASCII，渲染结果里的汉字只可能来自
 * 界面文案。
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ui } from '../src/dashboard/web/ui.js';
import { WecomNativeCoreSection, WecomTalkCommandsSection } from '../src/dashboard/web/wecom-native-core-section.js';
import { WecomNativePlatformSection } from '../src/dashboard/web/wecom-native-platform-section.js';
import { useWecomBotConfiguration, wecomProfilePatch } from '../src/dashboard/web/wecom-bot-config.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CJK = /[㐀-鿿]/;
/** 漏翻时 t() 原样返回键名。 */
const RAW_KEY = /\b(?:botDefaults|wecom)\.[A-Za-z]+\.[A-Za-z.]+/;
const VISIBLE_PROPS = ['aria-label', 'title', 'placeholder', 'alt'];

/** 渲染树里用户看得见的文字：文本节点与可读的无障碍 / 提示属性。 */
function visibleText(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(child => visibleText(child, out));
  else if (node && typeof node === 'object') {
    const { props, children } = node as { props?: Record<string, unknown>; children?: unknown };
    for (const name of VISIBLE_PROPS) if (typeof props?.[name] === 'string') out.push(props[name] as string);
    visibleText(children, out);
  }
  return out;
}

/**
 * 下拉框（DropdownField）收起时只渲染选中项；其余选项的文字同样会被用户看到（展开菜单时），从它的
 * options 里取出来一起检查。
 */
function optionTexts(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAll(node => typeof node.type !== 'string' && typeof node.props.dataInput === 'string' && Array.isArray(node.props.options))
    .flatMap(node => (node.props.options as Array<{ label: unknown }>).map(option => option.label))
    .filter((label): label is string => typeof label === 'string');
}

/** The tabs the WeCom core block has a tile on (the registry in bot-defaults.ts). */
const CORE_TABS = ['security', 'cards', 'advanced'];
// A duration off the four choices and a quota above the bound: their own notes render too.
const native = {
  grantDefaultDurationMs: 5_400_000, messageQuotaDefaultLimit: 5000, canTalkDaemonCommands: ['/status'],
  quotaFallbackBot: { enabled: true, peerId: 'conn-y', kinds: ['usage' as const], message: 'handed over' },
  summaryRange: { limit: 10 },
} as any;

type Scenario = { name: string; element: () => React.ReactElement; click?: (root: TestRenderer.ReactTestInstance) => void };
const ok = async () => {};
const rejected = async () => { throw 'rejected'; };
const pending = () => new Promise<void>(() => {});
const lastButton = (root: TestRenderer.ReactTestInstance) => root.findAllByType('button').at(-1)?.props.onClick();

function ConfigProbe({ patch }: { patch: Record<string, unknown> }) {
  const { error, save } = useWecomBotConfiguration('fixture');
  const [status, setStatus] = React.useState('');
  return React.createElement('div', null,
    React.createElement('p', { role: 'alert' }, error ?? ''),
    React.createElement('button', { onClick: () => void save(patch).then(() => setStatus(''), (e: Error) => setStatus(e.message)) }),
    React.createElement('output', null, status));
}

const scenarios: Scenario[] = [
  ...CORE_TABS.flatMap(tab => [
    { name: `core ${tab}`, element: () => React.createElement(WecomNativeCoreSection, { connectionId: 'fixture', value: native, save: ok, tab }), click: lastButton },
    { name: `core ${tab} failure`, element: () => React.createElement(WecomNativeCoreSection, { connectionId: 'fixture', value: native, save: rejected, tab }), click: lastButton },
    { name: `core ${tab} saving`, element: () => React.createElement(WecomNativeCoreSection, { connectionId: 'fixture', value: native, save: pending, tab }), click: lastButton },
  ]),
  { name: 'talk commands', element: () => React.createElement(WecomTalkCommandsSection, { value: native, save: ok }), click: lastButton },
  { name: 'talk commands failure', element: () => React.createElement(WecomTalkCommandsSection, { value: native, save: rejected }), click: lastButton },
  { name: 'platform sessions', element: () => React.createElement(WecomNativePlatformSection, { value: native, save: ok }), click: lastButton },
  { name: 'platform sessions failure', element: () => React.createElement(WecomNativePlatformSection, { value: native, save: rejected }), click: lastButton },
  { name: 'configuration load failure', element: () => React.createElement(ConfigProbe, { patch: {} }) },
];

let renderer: TestRenderer.ReactTestRenderer | undefined;
// 下拉框是页面的 DropdownField（base-ui）：它在 layout effect 里做 instanceof 判断，测试渲染器里没有 DOM 构造器。
class FakeElement {}
class FakeHTMLElement extends FakeElement {}
beforeEach(() => {
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('HTMLElement', FakeHTMLElement);
  vi.stubGlobal('window', { Element: FakeElement, HTMLElement: FakeHTMLElement, localStorage: { getItem: () => null, setItem: () => {} } });
  vi.stubGlobal('document', { documentElement: {}, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  ui.setLocale('zh');
  vi.unstubAllGlobals();
});

async function renderTexts(scenario: Scenario): Promise<string[]> {
  await act(async () => { renderer = TestRenderer.create(scenario.element()); });
  // 先收初始渲染，再触发一次交互（保存 / 校验 / 提交）收结果状态。
  const texts = [...visibleText(renderer!.toJSON()), ...optionTexts(renderer!.root)];
  if (scenario.click) {
    await act(async () => { scenario.click!(renderer!.root); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    texts.push(...visibleText(renderer!.toJSON()), ...optionTexts(renderer!.root));
  }
  await act(async () => renderer!.unmount());
  renderer = undefined;
  return texts;
}

describe('WeCom configuration sections in the English UI', () => {
  it.each(scenarios.map(scenario => [scenario.name, scenario] as const))('%s shows no untranslated text', async (_name, scenario) => {
    ui.setLocale('zh');
    const chinese = await renderTexts(scenario);
    expect(chinese.some(text => CJK.test(text)), 'the scenario renders translated text at all').toBe(true);

    ui.setLocale('en');
    const english = await renderTexts(scenario);
    expect(english.filter(text => CJK.test(text))).toEqual([]);
    expect(english.filter(text => RAW_KEY.test(text))).toEqual([]);
  });

  it('reports configuration errors in the current UI language', async () => {
    for (const locale of ['zh', 'en'] as const) {
      ui.setLocale(locale);
      let message = '';
      try {
        wecomProfilePatch('not-a-setting', {});
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(CJK.test(message)).toBe(locale === 'zh');
      expect(RAW_KEY.test(message)).toBe(false);
    }
  });
});
