import React, { type ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { HostOverloadAlertSettingsEditor } from '../src/dashboard/web/settings-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type EditorValue = ComponentProps<typeof HostOverloadAlertSettingsEditor>['value'];

/** Brand-new install: feature off, no target chosen, defaults present. This is
 *  the state codex flagged as a deadlock — the editor must stay usable here. */
function freshValue(overrides: Partial<EditorValue> = {}): EditorValue {
  return {
    enabled: false,
    targetBotAppId: null,
    enterLoadRatio: 1.5,
    enterMemUsedFrac: 0.92,
    botOptions: [
      { larkAppId: 'cli_a', botName: 'Claude', cliId: 'claude-code', apiOnly: false, recipientConfigured: true, recipientVerified: true, recipientHint: 'ou_a…1' },
      { larkAppId: 'cli_b', botName: 'Codex', cliId: 'codex', apiOnly: false, recipientConfigured: true, recipientVerified: true, recipientHint: 'ou_b…2' },
    ],
    targetDaemonOnline: false,
    ...overrides,
  };
}

function configuredValue(overrides: Partial<EditorValue> = {}): EditorValue {
  return freshValue({ enabled: true, targetBotAppId: 'cli_a', targetDaemonOnline: true, ...overrides });
}

function renderEditor(value: EditorValue, onSave = vi.fn(async () => undefined)) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(HostOverloadAlertSettingsEditor, {
      value,
      disabled: false,
      saving: false,
      onSave,
    }));
  });
  return { renderer, onSave };
}

function targetMenu(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('summary').find(s => s.props['aria-label'] === '通知 Bot');
}
function toggle(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('input').find(i => i.props.type === 'checkbox')!;
}

describe('HostOverloadAlertSettingsEditor — fresh/default state (deadlock regression)', () => {
  it('shows the target dropdown even when disabled + no target (so a fresh install can pick one)', () => {
    const { renderer } = renderEditor(freshValue());
    // The whole point: the dropdown is NOT hidden in the default state.
    expect(targetMenu(renderer)).toBeTruthy();
    // Thresholds are visible too.
    expect(JSON.stringify(renderer.toJSON())).toContain('负载进入阈值');
    expect(JSON.stringify(renderer.toJSON())).toContain('内存进入阈值');
  });

  it('disables the toggle until a target is chosen, but keeps it enabled once one is', () => {
    const fresh = renderEditor(freshValue());
    // Fresh: no target → toggle disabled (can't enable an undeliverable alert).
    expect(toggle(fresh.renderer).props.checked).toBe(false);
    expect(toggle(fresh.renderer).props.disabled).toBe(true);

    // A target selected (still disabled feature) → toggle becomes operable.
    const withTarget = renderEditor(freshValue({ targetBotAppId: 'cli_a' }));
    expect(toggle(withTarget.renderer).props.disabled).toBe(false);
  });

  it('selecting a target from the dropdown saves targetBotAppId (escapes the deadlock)', () => {
    const { renderer, onSave } = renderEditor(freshValue());
    const menu = targetMenu(renderer)!;
    // DropdownMenu renders option buttons; click the one for cli_a.
    const parent = menu.parent!;
    const buttons = parent.findAllByType('button');
    const pick = buttons.find(b => JSON.stringify(b.props.children ?? '').includes('Claude'));
    expect(pick).toBeTruthy();
    act(() => { pick!.props.onClick?.({}); });
    expect(onSave).toHaveBeenCalledWith({ targetBotAppId: 'cli_a' });
  });

  it('enabling with a target chosen fires onSave({enabled:true})', () => {
    const { renderer, onSave } = renderEditor(freshValue({ targetBotAppId: 'cli_a' }));
    act(() => { toggle(renderer).props.onChange({ currentTarget: { checked: true } }); });
    expect(onSave).toHaveBeenCalledWith({ enabled: true });
  });

  it('configured + online + verified: no inline warning', () => {
    const { renderer } = renderEditor(configuredValue());
    const json = JSON.stringify(renderer.toJSON());
    expect(json).not.toContain('请先选择一个通知 Bot');
    expect(json).not.toContain('当前不在线');
    expect(json).not.toContain('未配置管理员');
    expect(json).toContain('接收人');
  });

  it('target daemon offline surfaces the offline warning', () => {
    const { renderer } = renderEditor(configuredValue({ targetDaemonOnline: false }));
    expect(JSON.stringify(renderer.toJSON())).toContain('当前不在线');
  });

  it('target without a resolvable admin surfaces the missing-recipient warning', () => {
    const { renderer } = renderEditor(configuredValue({
      botOptions: [{ larkAppId: 'cli_a', botName: 'Claude', cliId: 'claude-code', apiOnly: false, recipientConfigured: false, recipientVerified: false, recipientHint: null }],
    }));
    expect(JSON.stringify(renderer.toJSON())).toContain('未配置管理员');
  });
});
