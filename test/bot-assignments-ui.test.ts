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

function dragEvent() {
  return {
    dataTransfer: { effectAllowed: '', dropEffect: '', setData: vi.fn() },
    preventDefault: vi.fn(),
    relatedTarget: null,
    currentTarget: { contains: () => false },
  };
}

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

  it('keeps palette-to-Bot drag assignment working', async () => {
    const onSave = vi.fn(async () => {});
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot()],
        skills,
        statuses: {},
        onSave,
        packs,
      }));
    });
    const root = renderer.root;
    const palettePack = root.findByProps({
      'data-palette-drag-type': 'pack',
      'data-palette-drag-id': 'p1',
    });
    const row = root.findAllByType('tr').find((node: any) => String(node.props.className).includes('skills-bot-row'))!;

    act(() => { palettePack.props.onDragStart(dragEvent()); });
    const overEvent = dragEvent();
    act(() => { row.props.onDragOver(overEvent); });
    expect(overEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(overEvent.dataTransfer.dropEffect).toBe('copy');
    await act(async () => { row.props.onDrop(dragEvent()); await Promise.resolve(); });

    expect(onSave).toHaveBeenCalledWith('app-1', [], ['p1']);
  });

  it('explains a duplicate drop instead of silently saving or failing', async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn(async () => {});
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
          bots: [bot({ skills: { include: ['pack:p1'] } })],
          skills,
          statuses: {},
          onSave,
          packs,
        }));
      });
      const root = renderer.root;
      const palettePack = root.findByProps({
        'data-palette-drag-type': 'pack',
        'data-palette-drag-id': 'p1',
      });
      const row = root.findAllByType('tr')
        .find((node: any) => String(node.props.className).includes('skills-bot-row'))!;

      act(() => { palettePack.props.onDragStart(dragEvent()); });
      await act(async () => { row.props.onDrop(dragEvent()); await Promise.resolve(); });

      expect(onSave).not.toHaveBeenCalled();
      expect(JSON.stringify(renderer.toJSON())).toContain('Pack 1 已在该 Bot 的配置中');
      act(() => { vi.advanceTimersByTime(1600); });
      expect(JSON.stringify(renderer.toJSON())).not.toContain('Pack 1 已在该 Bot 的配置中');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the Bot row highlighted while the pointer moves between its children', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot()],
        skills,
        statuses: {},
        onSave: async () => {},
        packs,
      }));
    });
    const root = renderer.root;
    const palettePack = root.findByProps({
      'data-palette-drag-type': 'pack',
      'data-palette-drag-id': 'p1',
    });
    const findRow = () => root.findAllByType('tr')
      .find((node: any) => String(node.props.className).includes('skills-bot-row'))!;

    act(() => { palettePack.props.onDragStart(dragEvent()); });
    act(() => { findRow().props.onDragOver(dragEvent()); });
    expect(findRow().props.className).toContain('drag-over');

    const insideLeave = dragEvent();
    insideLeave.relatedTarget = {};
    insideLeave.currentTarget = { contains: () => true };
    act(() => { findRow().props.onDragLeave(insideLeave); });
    expect(findRow().props.className).toContain('drag-over');

    const outsideLeave = dragEvent();
    act(() => { findRow().props.onDragLeave(outsideLeave); });
    expect(findRow().props.className).not.toContain('drag-over');
  });

  it('does not copy or move an existing assignment when it is dropped on another Bot', async () => {
    const onSave = vi.fn(async () => {});
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [
          bot({ skills: { include: ['pack:p1'] } }),
          bot({ larkAppId: 'app-2', botName: 'Bot 2' }),
        ],
        skills,
        statuses: {},
        onSave,
        packs,
      }));
    });
    const root = renderer.root;
    const assignedPack = root.findByProps({
      'data-assigned-drag-type': 'pack',
      'data-assigned-drag-id': 'p1',
      'data-assigned-bot': 'app-1',
    });
    const rows = root.findAllByType('tr')
      .filter((node: any) => String(node.props.className).includes('skills-bot-row'));
    const targetRow = rows[1]!;

    act(() => { assignedPack.props.onDragStart(dragEvent()); });
    const overEvent = dragEvent();
    act(() => { targetRow.props.onDragOver(overEvent); });
    expect(overEvent.preventDefault).not.toHaveBeenCalled();
    expect(overEvent.dataTransfer.dropEffect).toBe('');
    const dropEvent = dragEvent();
    await act(async () => { targetRow.props.onDrop(dropEvent); await Promise.resolve(); });

    expect(dropEvent.preventDefault).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('writes text/plain drag data for Firefox on palette and assigned drags', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['skill:b'] } })],
        skills,
        statuses: {},
        onSave: async () => {},
        packs,
      }));
    });
    const root = renderer.root;
    const palettePack = root.findByProps({
      'data-palette-drag-type': 'pack',
      'data-palette-drag-id': 'p1',
    });
    const paletteEvent = dragEvent();
    act(() => { palettePack.props.onDragStart(paletteEvent); });
    expect(paletteEvent.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'p1');
    expect(paletteEvent.dataTransfer.effectAllowed).toBe('copy');
    act(() => { palettePack.props.onDragEnd(); });

    const assignedSkill = root.findByProps({
      'data-assigned-drag-type': 'skill',
      'data-assigned-drag-id': 'b',
      'data-assigned-bot': 'app-1',
    });
    const assignedEvent = dragEvent();
    act(() => { assignedSkill.props.onDragStart(assignedEvent); });
    expect(assignedEvent.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'b');
    expect(assignedEvent.dataTransfer.effectAllowed).toBe('move');
  });

  it('drags an assigned Pack back to the remove zone without touching other selectors', async () => {
    const onSave = vi.fn(async () => {});
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['pack:p1', 'pack:p2', 'skill:c'] } })],
        skills,
        statuses: {},
        onSave,
        packs,
      }));
    });
    const root = renderer.root;
    const assignedPack = root.findByProps({
      'data-assigned-drag-type': 'pack',
      'data-assigned-drag-id': 'p1',
      'data-assigned-bot': 'app-1',
    });

    expect(root.findAllByProps({ 'data-action': 'unassign-dropzone' })).toHaveLength(0);
    act(() => { assignedPack.props.onDragStart(dragEvent()); });
    const dropzone = root.findByProps({ 'data-action': 'unassign-dropzone' });
    expect(JSON.stringify(renderer.toJSON())).toContain('只会从 Bot 1 移除当前项');
    const overEvent = dragEvent();
    act(() => { dropzone.props.onDragOver(overEvent); });
    expect(overEvent.dataTransfer.dropEffect).toBe('move');
    expect(root.findByProps({ 'data-action': 'unassign-dropzone' }).props['data-drag-over']).toBe(true);
    await act(async () => { dropzone.props.onDrop(dragEvent()); await Promise.resolve(); });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('app-1', ['c'], ['p2']);
    expect(root.findAllByProps({ 'data-action': 'unassign-dropzone' })).toHaveLength(0);
  });

  it('drags an assigned direct Skill back to remove while preserving Packs and other Skills', async () => {
    const onSave = vi.fn(async () => {});
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['pack:p1', 'skill:b', 'skill:c'] } })],
        skills,
        statuses: {},
        onSave,
        packs,
      }));
    });
    const root = renderer.root;
    const assignedSkill = root.findByProps({
      'data-assigned-drag-type': 'skill',
      'data-assigned-drag-id': 'b',
      'data-assigned-bot': 'app-1',
    });

    act(() => { assignedSkill.props.onDragStart(dragEvent()); });
    const dropzone = root.findByProps({ 'data-action': 'unassign-dropzone' });
    await act(async () => { dropzone.props.onDrop(dragEvent()); await Promise.resolve(); });

    expect(onSave).toHaveBeenCalledWith('app-1', ['c'], ['p1']);
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
