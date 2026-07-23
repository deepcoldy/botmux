import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { GroupNamePrefixRow } from '../src/dashboard/web/settings-page.js';

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
    renderer = TestRenderer.create(React.createElement(GroupNamePrefixRow, props));
  });
  return { renderer, props };
}

function input(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('input');
}

function saveButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ className: 'page-primary-action' });
}

function preview(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root.findByProps({ 'data-group-name-prefix-preview': true }).children.join('');
}

describe('GroupNamePrefixRow (dashboard settings)', () => {
  it('edits, previews, and explicitly saves separator whitespace', () => {
    const onSave = vi.fn();
    const { renderer } = render({ onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: '[AI] ' } }));

    expect(preview(renderer)).toContain('[AI] ');
    expect(saveButton(renderer).props.disabled).toBe(false);
    act(() => saveButton(renderer).props.onClick());
    expect(onSave).toHaveBeenCalledWith('[AI] ');
  });

  it('clears an existing prefix and saves an empty string', () => {
    const onSave = vi.fn();
    const { renderer } = render({ value: 'AI讨论·', onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: '' } }));
    act(() => saveButton(renderer).props.onClick());

    expect(onSave).toHaveBeenCalledWith('');
  });

  it('keeps save disabled when unchanged or read-only', () => {
    const unchanged = render({ value: 'AI讨论·' });
    expect(saveButton(unchanged.renderer).props.disabled).toBe(true);

    const readOnly = render({ disabled: true });
    expect(input(readOnly.renderer).props.disabled).toBe(true);
    expect(saveButton(readOnly.renderer).props.disabled).toBe(true);
  });

  it('rejects a non-empty whitespace-only prefix', () => {
    const onSave = vi.fn();
    const { renderer } = render({ onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: '   ' } }));

    expect(saveButton(renderer).props.disabled).toBe(true);
    act(() => saveButton(renderer).props.onClick());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('syncs the draft when the confirmed server value changes', () => {
    const onSave = vi.fn();
    const { renderer } = render({ value: '', onSave });
    act(() => input(renderer).props.onChange({ currentTarget: { value: 'unsaved' } }));

    act(() => {
      renderer.update(React.createElement(GroupNamePrefixRow, {
        value: 'AI讨论·',
        disabled: false,
        onSave,
      }));
    });

    expect(input(renderer).props.value).toBe('AI讨论·');
    expect(saveButton(renderer).props.disabled).toBe(true);
  });
});
