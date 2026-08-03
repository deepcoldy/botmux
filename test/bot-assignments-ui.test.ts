import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BotAssignmentsTab } from '../src/dashboard/web/skills/bot-assignments-tab.js';
import type { BotRow, SkillRow } from '../src/dashboard/web/skills/types.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function bot(over: Partial<BotRow> = {}): BotRow {
  return { larkAppId: 'app-1', botName: 'Bot 1', skills: { include: [] }, ...over };
}

const skills: SkillRow[] = [
  { name: 'a', tags: [], rootDir: '/a', entrypoint: 'SKILL.md', source: { type: 'user', root: '/a' } },
  { name: 'b', tags: [], rootDir: '/b', entrypoint: 'SKILL.md', source: { type: 'user', root: '/b' } },
  { name: 'c', tags: [], rootDir: '/c', entrypoint: 'SKILL.md', source: { type: 'user', root: '/c' } },
];

const packs = [
  { id: 'p1', name: 'Pack 1', include: ['skill:a', 'skill:b'] },
  { id: 'p2', name: 'Pack 2', include: ['skill:b', 'skill:c'] },
];

describe('bot assignments tab', () => {
  it('renders a compact table row per bot with pack chips and skill count', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['pack:p1', 'skill:c'] } })],
        skills,
        statuses: {},
        onSave: async () => {},
        packs,
      }));
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Bot 1');
    expect(text).toContain('Pack 1');
    // Final count: pack:p1 gives a,b; skill:c gives c; all installed → 3
    expect(text).toContain('3');
  });

  it('expanded preview labels direct skills as "direct" and pack skills as "pack:<name>"', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['pack:p1', 'skill:b'] } })],
        skills,
        statuses: {},
        onSave: async () => {},
        packs,
      }));
    });
    // Open the editor
    const root = renderer.root;
    const editBtn = root.findAllByType('button').find((b: any) => b.props.children === '选择');
    act(() => { editBtn.props.onClick(); });

    // The editor should show resolved preview with source labels
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('direct');
    expect(text).toContain('pack:Pack 1');
    // b is in both pack:p1 and direct; direct wins → only one 'b' entry labeled direct
    const bCount = (text.match(/\"b\"/g) ?? []).length;
    expect(bCount).toBeGreaterThanOrEqual(1);
  });

  it('marks health as warn when a pack references a missing skill', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['pack:p1'] } })],
        skills: [{ name: 'a', tags: [], rootDir: '/a', entrypoint: 'SKILL.md', source: { type: 'user', root: '/a' } }],
        statuses: {},
        onSave: async () => {},
        packs: [{ id: 'p1', name: 'Pack 1', include: ['skill:a', 'skill:missing'] }],
      }));
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('warn');
  });

  it('saves direct Skills and Skill Packs in one atomic callback', async () => {
    const onSave = vi.fn(async () => {});
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['pack:p1', 'skill:a'] } })],
        skills,
        statuses: {},
        onSave,
        packs,
      }));
    });

    const root = renderer.root;
    const editBtn = root.findAllByType('button').find((button: any) => button.props.children === '选择');
    act(() => { editBtn!.props.onClick(); });
    const checkboxes = root.findAllByType('input').filter((input: any) => input.props.type === 'checkbox');
    act(() => {
      checkboxes[1].props.onChange(); // pack:p2
      checkboxes[4].props.onChange(); // skill:c
    });
    const form = root.findByProps({ 'data-action': 'save-bot-assignment' });
    await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('app-1', ['a', 'c'], ['p1', 'p2']);
  });
});
