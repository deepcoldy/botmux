import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSettings, SettingsBody } from '../src/dashboard/web/settings-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

function render(modelQueueNotify?: boolean, canWrite = true, savingKey: string | null = null) {
  const settings = parseSettings({ modelQueueNotify, publicReadOnly: true });
  const onSave = vi.fn(async (_key: string, _payload: unknown, _optimistic: (value: typeof settings) => typeof settings) => {});
  act(() => {
    renderer = TestRenderer.create(React.createElement(SettingsBody, {
      settings, canWrite, savingKey, bound: false, message: null,
      autostartBlock: null, updateBlock: null, feishuLoginQr: null,
      onCloseFeishuLoginQr: vi.fn(), onFeishuLoginQr: vi.fn(), onSave,
    }));
  });
  const toggle = renderer.root.findByProps({ 'data-action': 'toggle-model-queue-notify' });
  return { settings, onSave, toggle };
}

describe('model queue notification in dashboard settings', () => {
  it('starts off and saves the matching boolean with an isolated optimistic update', () => {
    const { settings, toggle, onSave } = render();
    expect(toggle.props.checked).toBe(false);
    expect(toggle.props.disabled).toBe(false);
    act(() => toggle.props.onChange({ currentTarget: { checked: true } }));
    expect(onSave).toHaveBeenCalledWith('modelQueueNotify', { modelQueueNotify: true }, expect.any(Function));
    const update = onSave.mock.calls[0][2] as unknown as (value: typeof settings) => typeof settings;
    expect(update(settings)).toEqual({ ...settings, modelQueueNotify: true });
  });

  it('shows a saved enabled value and allows turning it off', () => {
    const { toggle, onSave } = render(true);
    expect(toggle.props.checked).toBe(true);
    act(() => toggle.props.onChange({ currentTarget: { checked: false } }));
    expect(onSave).toHaveBeenCalledWith('modelQueueNotify', { modelQueueNotify: false }, expect.any(Function));
  });

  it.each([[false, null], [true, 'modelQueueNotify']] as const)('disables the control without write access or during save', (canWrite, savingKey) => {
    expect(render(false, canWrite, savingKey).toggle.props.disabled).toBe(true);
  });
});
