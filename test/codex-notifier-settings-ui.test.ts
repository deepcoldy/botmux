import React, { type ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'bun:test';
import { CodexNotifierSettingsEditor } from '../src/dashboard/web/settings-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type EditorValue = ComponentProps<typeof CodexNotifierSettingsEditor>['value'];

function configuredValue(overrides: Partial<EditorValue> = {}): EditorValue {
  return {
    enabled: false,
    targetBotAppId: 'cli_target',
    notifyWhen: 'always',
    platformSupported: true,
    hookInstalled: true,
    botOptions: [{
      larkAppId: 'cli_target',
      botName: 'Codex 助理',
      cliId: 'codex',
      recipientConfigured: true,
      recipientVerified: true,
      recipientHint: 'ou_7f3a…c921',
    }],
    targetDaemonOnline: true,
    pendingCount: 0,
    workerOnline: true,
    lastError: null,
    ...overrides,
  };
}

function renderEditor(
  value: EditorValue = configuredValue(),
  onSave = vi.fn(async () => undefined),
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(CodexNotifierSettingsEditor, {
      value,
      disabled: false,
      saving: false,
      onSave,
    }));
  });
  return { renderer, onSave };
}

function menus(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('summary')
    .filter(summary => ['通知 Bot', '通知时机'].includes(summary.props['aria-label']));
}

function toggle(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('input')
    .find(input => input.props.type === 'checkbox')!;
}

describe('CodexNotifierSettingsEditor', () => {
  it('shows only the main switch while notifications are off', () => {
    const { renderer } = renderEditor();

    expect(menus(renderer)).toHaveLength(0);
    expect(toggle(renderer).props.checked).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('配置通知');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('已关闭');
  });

  it('reveals saved child settings in a cancellable pending-enable state', () => {
    const onSave = vi.fn(async () => undefined);
    const { renderer } = renderEditor(configuredValue({
      notifyWhen: 'locked_only',
      platformSupported: false,
    }), onSave);
    const checkbox = toggle(renderer);

    act(() => {
      checkbox.props.onChange({ currentTarget: { checked: true } });
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(toggle(renderer).props.checked).toBe(true);
    expect(menus(renderer)).toHaveLength(2);
    const labels = menus(renderer)
      .map(menu => menu.findByProps({ className: 'sect-sort-value' }).children.join(''));
    expect(labels).toContain('Codex 助理 · codex');
    expect(labels).toContain('仅锁屏时（推荐）');
    expect(JSON.stringify(renderer.toJSON())).toContain('接收人：ou_7f3a…c921');
    expect(JSON.stringify(renderer.toJSON())).toContain('完成下面的配置后将自动开启通知');
    expect(JSON.stringify(renderer.toJSON())).toContain('当前系统不支持可靠的锁屏探测');

    act(() => {
      toggle(renderer).props.onChange({ currentTarget: { checked: false } });
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(toggle(renderer).props.checked).toBe(false);
    expect(menus(renderer)).toHaveLength(0);
  });

  it('automatically enables notifications after pending settings become valid', () => {
    const onSave = vi.fn(async () => undefined);
    const { renderer } = renderEditor(configuredValue({
      notifyWhen: 'locked_only',
      platformSupported: false,
    }), onSave);

    act(() => {
      toggle(renderer).props.onChange({ currentTarget: { checked: true } });
    });
    expect(onSave).not.toHaveBeenCalled();

    act(() => {
      renderer.update(React.createElement(CodexNotifierSettingsEditor, {
        value: configuredValue({
          notifyWhen: 'always',
          platformSupported: false,
        }),
        disabled: false,
        saving: false,
        onSave,
      }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ enabled: true });
  });

  it('keeps healthy runtime state silent and only surfaces actionable warnings', () => {
    const { renderer } = renderEditor(configuredValue({ enabled: true }));

    expect(JSON.stringify(renderer.toJSON())).not.toContain('Hook 已安装');

    act(() => {
      renderer.update(React.createElement(CodexNotifierSettingsEditor, {
        value: configuredValue({
          enabled: true,
          hookInstalled: false,
        }),
        disabled: false,
        saving: false,
        onSave: vi.fn(async () => undefined),
      }));
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('Hook 尚未就绪');
  });

  it('shows the offline reason before recipient verification while enabling', () => {
    const value = configuredValue({
      targetDaemonOnline: false,
      botOptions: [{
        ...configuredValue().botOptions[0],
        recipientVerified: false,
      }],
    });
    const { renderer } = renderEditor(value);

    act(() => {
      toggle(renderer).props.onChange({ currentTarget: { checked: true } });
    });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('目标 Bot 当前不在线，恢复后才能开启通知');
    expect(rendered).not.toContain('目标 Bot 尚未把首位可投递管理员解析为飞书 open_id');
  });

  it('shows the retrying offline state for an already-enabled notifier', () => {
    const value = configuredValue({
      enabled: true,
      targetDaemonOnline: false,
      botOptions: [{
        ...configuredValue().botOptions[0],
        recipientVerified: false,
      }],
    });
    const { renderer } = renderEditor(value);

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('目标 Bot 当前不在线；事件会保留在本地，Bot 恢复后重试');
    expect(rendered).not.toContain('目标 Bot 尚未把首位可投递管理员解析为飞书 open_id');
  });

  it('surfaces the last delivery error even after the pending queue is empty', () => {
    const { renderer } = renderEditor(configuredValue({
      enabled: true,
      pendingCount: 0,
      lastError: {
        at: '2026-07-24T00:00:00.000Z',
        message: 'event quarantined',
        retryAt: '2026-07-24T00:01:00.000Z',
      },
    }));

    expect(JSON.stringify(renderer.toJSON())).toContain('最近一次投递失败：event quarantined');
  });

  it('saves valid enable and disable actions without clearing child configuration', () => {
    const onSave = vi.fn(async () => undefined);
    const { renderer } = renderEditor(configuredValue(), onSave);
    const checkbox = toggle(renderer);

    act(() => {
      checkbox.props.onChange({ currentTarget: { checked: true } });
    });
    expect(onSave).toHaveBeenLastCalledWith({ enabled: true });

    act(() => {
      renderer.update(React.createElement(CodexNotifierSettingsEditor, {
        value: configuredValue({ enabled: true }),
        disabled: false,
        saving: false,
        onSave,
      }));
    });
    expect(menus(renderer)).toHaveLength(2);

    act(() => {
      toggle(renderer).props.onChange({ currentTarget: { checked: false } });
    });
    expect(onSave).toHaveBeenLastCalledWith({ enabled: false });

    act(() => {
      renderer.update(React.createElement(CodexNotifierSettingsEditor, {
        value: configuredValue({ enabled: false }),
        disabled: false,
        saving: false,
        onSave,
      }));
    });
    expect(menus(renderer)).toHaveLength(0);
  });
});
