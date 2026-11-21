import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSettings, SettingsBody } from '../src/dashboard/web/settings-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

function render(raw: Record<string, unknown>, canWrite = true, savingKey: string | null = null) {
  const settings = parseSettings(raw);
  const onSave = vi.fn(async (_key: string, _payload: unknown, _optimistic: (value: typeof settings) => typeof settings) => {});
  act(() => {
    renderer = TestRenderer.create(React.createElement(SettingsBody, {
      settings, canWrite, savingKey, bound: false, message: null,
      autostartBlock: null, updateBlock: null, feishuLoginQr: null,
      onCloseFeishuLoginQr: vi.fn(), onFeishuLoginQr: vi.fn(), onSave,
    }));
  });
  const section = renderer.root.findByProps({ id: 'settings-group-creation' });
  const toggle = section.findByProps({ 'data-action': 'toggle-group-owner-notice' });
  return { settings, onSave, toggle };
}

describe('group owner notice switch in dashboard settings', () => {
  it('shows on for a snapshot without the field (older daemon) and turns it off in the group-creation section', () => {
    const { settings, toggle, onSave } = render({});
    expect(toggle.props.checked).toBe(true);
    act(() => toggle.props.onChange({ currentTarget: { checked: false } }));
    expect(onSave).toHaveBeenCalledWith('groupOwnerNotice', { groupOwnerNotice: false }, expect.any(Function));
    const update = onSave.mock.calls[0][2] as unknown as (value: typeof settings) => typeof settings;
    expect(update(settings)).toEqual({ ...settings, groupOwnerNotice: false });
  });

  it('shows a saved off value and allows turning it back on', () => {
    const { toggle, onSave } = render({ groupOwnerNotice: false });
    expect(toggle.props.checked).toBe(false);
    act(() => toggle.props.onChange({ currentTarget: { checked: true } }));
    expect(onSave).toHaveBeenCalledWith('groupOwnerNotice', { groupOwnerNotice: true }, expect.any(Function));
  });

  it.each([[false, null], [true, 'groupOwnerNotice']] as const)('disables the control without write access or during save', (canWrite, savingKey) => {
    expect(render({}, canWrite, savingKey).toggle.props.disabled).toBe(true);
  });
});
