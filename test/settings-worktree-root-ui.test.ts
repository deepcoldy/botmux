import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeRootRow } from '../src/dashboard/web/settings-page.js';

type RowProps = {
  value: string;
  disabled: boolean;
  onSave(value: string): void;
};

function render(overrides: Partial<RowProps> = {}) {
  const props: RowProps = {
    value: '',
    disabled: false,
    onSave: vi.fn(),
    ...overrides,
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(WorktreeRootRow, props));
  });
  return { renderer, props };
}

function input(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('input');
}

function saveButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ className: 'page-primary-action' });
}

function hint(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root.findByProps({ 'data-worktree-root-hint': true }).children.join('');
}

describe('WorktreeRootRow (dashboard settings)', () => {
  it('saves the trimmed path from the button and from Enter', () => {
    const onSave = vi.fn();
    const { renderer } = render({ onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: ' /data00/worktrees ' } }));
    act(() => saveButton(renderer).props.onClick());
    act(() => input(renderer).props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));

    expect(onSave.mock.calls).toEqual([['/data00/worktrees'], ['/data00/worktrees']]);
  });

  it('clears an existing directory and saves an empty string', () => {
    const onSave = vi.fn();
    const { renderer } = render({ value: '/data00/worktrees', onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: '' } }));
    act(() => saveButton(renderer).props.onClick());

    expect(onSave).toHaveBeenCalledWith('');
  });

  it('shows the saved directory, not the unsaved draft', () => {
    const { renderer } = render({ value: '/data00/worktrees' });
    act(() => input(renderer).props.onChange({ currentTarget: { value: '/elsewhere' } }));

    expect(hint(renderer)).toContain('/data00/worktrees');
    expect(hint(renderer)).not.toContain('/elsewhere');
    expect(hint(render().renderer)).not.toContain('/data00/worktrees');
  });

  it('keeps save disabled when unchanged, only re-padded, or read-only', () => {
    const unchanged = render({ value: '/data00/worktrees' });
    expect(saveButton(unchanged.renderer).props.disabled).toBe(true);
    act(() => input(unchanged.renderer).props.onChange({ currentTarget: { value: ' /data00/worktrees ' } }));
    expect(saveButton(unchanged.renderer).props.disabled).toBe(true);

    const readOnly = render({ disabled: true });
    expect(input(readOnly.renderer).props.disabled).toBe(true);
    expect(saveButton(readOnly.renderer).props.disabled).toBe(true);
  });
});
