import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSettings, SettingsBody } from '../src/dashboard/web/settings-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
function render(value?: boolean, canWrite = true, savingKey: string | null = null) {
  const settings = parseSettings({ maintenance: { notifyOnNewVersion: value }, localDevInstall: true, autoUpdateSupported: false });
  const onSave = vi.fn(async (_key: string, _payload: unknown, _update: (s: typeof settings) => typeof settings) => {});
  act(() => { renderer = TestRenderer.create(React.createElement(SettingsBody, {
    settings, canWrite, savingKey, onSave, bound: false, message: null,
    autostartBlock: null, updateBlock: null, feishuLoginQr: null,
    onCloseFeishuLoginQr: vi.fn(), onFeishuLoginQr: vi.fn(),
  })); });
  return { settings, onSave, toggle: renderer.root.findByProps({ 'data-action': 'toggle-new-version-notify' }) };
}
describe('new version reminder dashboard switch', () => {
  it('starts off on source installs and saves only the notification boolean', () => {
    const { settings, onSave, toggle } = render();
    expect(toggle.props.checked).toBe(false); expect(toggle.props.disabled).toBe(false);
    act(() => toggle.props.onChange({ currentTarget: { checked: true } }));
    expect(onSave).toHaveBeenCalledWith('notifyOnNewVersion', { maintenance: { notifyOnNewVersion: true } }, expect.any(Function));
    const update = onSave.mock.calls[0][2];
    expect(update(settings)).toEqual({ ...settings, maintenance: { notifyOnNewVersion: true } });
  });
  it('displays a saved opt-in and turns it off', () => {
    const { toggle, onSave } = render(true);
    expect(toggle.props.checked).toBe(true);
    act(() => toggle.props.onChange({ currentTarget: { checked: false } }));
    expect(onSave).toHaveBeenCalledWith('notifyOnNewVersion', { maintenance: { notifyOnNewVersion: false } }, expect.any(Function));
  });
  it.each([[false, null], [true, 'notifyOnNewVersion']] as const)('disables writes for readonly or pending save', (canWrite, savingKey) => {
    expect(render(false, canWrite, savingKey).toggle.props.disabled).toBe(true);
  });
});
