import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AutoStartControls } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderControls(appId: string, defaultSeed: string) {
  const putCardPref = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } }));
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(AutoStartControls, {
      bot: { larkAppId: appId, autoStartOnGroupJoinSeedDefault: defaultSeed },
      putCardPref,
    }));
  });
  return { renderer, putCardPref };
}

function updateControls(
  renderer: TestRenderer.ReactTestRenderer,
  putCardPref: ReturnType<typeof vi.fn>,
  appId: string,
  defaultSeed: string,
): void {
  act(() => {
    renderer.update(React.createElement(AutoStartControls, {
      bot: { larkAppId: appId, autoStartOnGroupJoinSeedDefault: defaultSeed },
      putCardPref,
    }));
  });
}

async function flushAction(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Bot 默认设置 — 入群 seed 草稿同步', () => {
  it('切换 Bot 时丢弃上一 Bot 的未保存草稿', () => {
    const { renderer, putCardPref } = renderControls('app_a', '默认文案');
    const seedInput = () => renderer.root.findByProps({ 'data-input': 'autoJoinSeed' });

    act(() => seedInput().props.onChange({ currentTarget: { value: '只属于 A 的草稿' } }));
    expect(seedInput().props.value).toBe('只属于 A 的草稿');

    updateControls(renderer, putCardPref, 'app_b', '默认文案');
    expect(seedInput().props.value).toBe('默认文案');
  });

  it('当前 Bot 的动态默认文案变化时刷新软预填', () => {
    const { renderer, putCardPref } = renderControls('app_a', '🚀 已加入本群，开始工作…');
    const seedInput = () => renderer.root.findByProps({ 'data-input': 'autoJoinSeed' });

    updateControls(renderer, putCardPref, 'app_a', '🚀 Joined this chat — getting to work…');
    expect(seedInput().props.value).toBe('🚀 Joined this chat — getting to work…');
  });

  it('保存时同时提交 seed 与页面实际展示的默认值', async () => {
    const defaultSeed = '🚀 已加入本群，开始工作…';
    const { renderer, putCardPref } = renderControls('app_a', defaultSeed);
    const seedInput = () => renderer.root.findByProps({ 'data-input': 'autoJoinSeed' });
    const save = () => renderer.root.findByProps({ 'data-action': 'save-auto-join-seed' });

    await flushAction(() => save().props.onClick());
    expect(putCardPref).toHaveBeenLastCalledWith({
      autoStartOnGroupJoinSeed: defaultSeed,
      autoStartOnGroupJoinSeedDefault: defaultSeed,
    });

    act(() => seedInput().props.onChange({ currentTarget: { value: '自定义 seed' } }));
    await flushAction(() => save().props.onClick());
    expect(putCardPref).toHaveBeenLastCalledWith({
      autoStartOnGroupJoinSeed: '自定义 seed',
      autoStartOnGroupJoinSeedDefault: defaultSeed,
    });
  });
});
