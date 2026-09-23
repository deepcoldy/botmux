/**
 * Customization center page — stage/skills tab structure, cross-stage block
 * grouping, conditional control, and global search. Uses react-test-renderer
 * (no DOM) with a mocked /api/customization snapshot.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { CustomizationPage } from '../src/dashboard/web/customization-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── synthetic snapshot ──────────────────────────────────────────────────────
const zh = (factory: string, override: string | null = null) => ({
  locales: { zh: { factory, override }, en: { factory, override: null } },
});

const snapshot = {
  enabled: true,
  stages: [
    { id: 'new', label: '会话开始', blurb: 'BLURB-NEW' },
    { id: 'followup', label: '每条新消息', blurb: 'BLURB-FOLLOWUP' },
    { id: 'send', label: '发送之后', blurb: 'BLURB-SEND' },
  ],
  blocks: [
    { id: 'routing_system', label: '系统提示路径 · 路由规则', hint: 'HINT-ROUTING' },
    { id: 'attachments', label: '<attachments> 附件查看提示', hint: 'HINT-ATTACH' },
    { id: 'followup', label: '<botmux_reminder> 续轮提醒' },
    { id: 'send_feedback', label: 'send 成功后的终端回显' },
  ],
  fragments: [
    { key: 'ai.routing.intro', block: 'routing_system', stage: 'new', label: '开场说明', kind: 'editable', ...zh('FACTORY-INTRO') },
    {
      key: 'ai.routing.no_visible_output_ok', block: 'routing_system', stage: 'new',
      label: '防重发提示', kind: 'conditional', gate: 'dashboard.noVisibleOutputHint',
      gateLabel: 'GATE-NOOUTPUT', conditionForced: null, ...zh('FACTORY-COND'),
    },
    {
      key: 'ai.attach.hint', block: 'attachments', stage: 'new', stages: ['followup'],
      label: '附件查看提示', kind: 'editable', gateLabel: 'GATE-ATTACH', ...zh('FACTORY-ATTACH'),
    },
    { key: 'ai.followup.reminder', block: 'followup', stage: 'followup', label: '续轮提醒（默认）', kind: 'editable', ...zh('FACTORY-REMINDER') },
    { key: 'ai.send.after_success_hint', block: 'send_feedback', stage: 'send', label: 'send 成功回显', kind: 'editable', ...zh('FACTORY-SEND') },
  ],
  skills: [
    { name: 'botmux-send', description: 'send skill', factory: 'SKILL-BODY', override: null, disabled: false },
  ],
  history: [],
};

function collectText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (node.children) return node.children.map(collectText).join(' ');
  return '';
}

let renderer: TestRenderer.ReactTestRenderer;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: any) => ({
    ok: true,
    // GET /api/customization returns the snapshot directly; mutations wrap it.
    json: async () => (String(url).endsWith('/api/customization') ? snapshot : { ok: true, snapshot }),
  })) as any;
});
afterEach(() => {
  void act(() => { renderer?.unmount(); });
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(createElement(CustomizationPage));
  });
  // Flush the GET promise + setState.
  await act(async () => { await Promise.resolve(); });
  return renderer;
}

function text(): string {
  return collectText(renderer.toJSON());
}

function findTab(label: string) {
  return renderer.root.findAllByType('button')
    .find(b => collectText(b).includes(label))!;
}

describe('customization page stage UX', () => {
  it('renders stage tabs + skills tab, opening on 会话开始', async () => {
    await mount();
    const t = text();
    expect(t).toContain('会话开始');
    expect(t).toContain('每条新消息');
    expect(t).toContain('发送之后');
    expect(t).toContain('内置 Skill');
    expect(t).toContain('BLURB-NEW');
    // new-stage content visible
    expect(t).toContain('开场说明');
    expect(t).toContain('系统提示路径 · 路由规则');
    expect(t).toContain('GATE-NOOUTPUT');
    // followup/send-only content hidden on new tab (attach hint is cross-listed and DOES show)
    expect(t).toContain('附件查看提示');
    expect(t).not.toContain('FACTORY-REMINDER');
    expect(t).not.toContain('FACTORY-SEND');
    // skills not shown on prompt tab
    expect(t).not.toContain('botmux-send');
  });

  it('conditional fragment exposes the force select', async () => {
    await mount();
    const selects = renderer.root.findAllByType('select');
    const condSelect = selects.find(s => {
      const opts = Array.isArray(s.props.children)
        ? s.props.children.map((o: any) => o?.props?.value)
        : [s.props.children?.props?.value];
      return opts.includes('on') && opts.includes('off') && opts.includes('default');
    });
    expect(condSelect).toBeTruthy();
    expect(condSelect!.props.value).toBe('default');
  });

  it('switches to 每条新消息 and shows cross-listed block under the shared header', async () => {
    await mount();
    await act(async () => { findTab('每条新消息').props.onClick(); });
    const t = text();
    expect(t).toContain('BLURB-FOLLOWUP');
    expect(t).toContain('续轮提醒（默认）');
    expect(t).toContain('FACTORY-REMINDER');
    // attachments fragment cross-lists into followup, labeled as shared
    expect(t).toContain('附件查看提示');
    expect(t).toContain('与');
    expect(t).toContain('共用同一条文案');
    // new-only fragment gone
    expect(t).not.toContain('开场说明');
  });

  it('switches to 发送之后 then to 内置 Skill', async () => {
    await mount();
    await act(async () => { findTab('发送之后').props.onClick(); });
    expect(text()).toContain('FACTORY-SEND');
    expect(text()).not.toContain('FACTORY-REMINDER');

    await act(async () => { findTab('内置 Skill').props.onClick(); });
    const t = text();
    expect(t).toContain('botmux-send');
    expect(t).toContain('出厂默认');
    // stage blurb not rendered on skills tab
    expect(t).not.toContain('BLURB-NEW');
  });

  it('global search matches across stages and tags the fragment stage', async () => {
    await mount();
    const search = renderer.root.findAllByType('input').find(i => i.props.type === 'search')!;
    expect(search).toBeTruthy();
    await act(async () => {
      search.props.onChange({ target: { value: 'FACTORY-SEND' } });
    });
    const t = text();
    expect(t).toContain('搜索结果');
    expect(t).toContain('send 成功回显');
    expect(t).toContain('发送之后'); // stage tag
    // non-matching native tab content suppressed by search results
    expect(t).not.toContain('开场说明');
  });
});
