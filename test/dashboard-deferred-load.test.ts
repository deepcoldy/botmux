import React, { useEffect, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterNextPaint } from '../src/dashboard/web/deferred-task.js';
import { LazyTabPanel } from '../src/dashboard/web/lazy-tab-panel.js';
import { BotDescriptionControl } from '../src/dashboard/web/bot-defaults-page.js';

vi.mock('react-dom', () => ({ ...require('react-dom'), createPortal: (node: React.ReactNode) => node }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('optional dashboard reads', () => {
  it('lets a frame paint before starting optional work, and cancels abandoned work', async () => {
    vi.useFakeTimers();
    let frame!: FrameRequestCallback;
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('window', { requestAnimationFrame: (fn: FrameRequestCallback) => { frame = fn; return 1; }, cancelAnimationFrame });
    const task = vi.fn();
    const cancel = afterNextPaint(task);
    expect(task).not.toHaveBeenCalled();
    frame(0);
    expect(task).not.toHaveBeenCalled();
    // runOnlyPendingTimersAsync 不在 bun:test 兼容层里；这里每处至多一个 setTimeout(0)
    // 待处理，advanceTimersToNextTimerAsync 两腿等价（零待处理时两者都不抛错，已实测）。
    await vi.advanceTimersToNextTimerAsync();
    expect(task).toHaveBeenCalledOnce();
    cancel();
    const abandoned = vi.fn();
    const abort = afterNextPaint(abandoned);
    frame(0);
    abort();
    await vi.advanceTimersToNextTimerAsync();
    expect(abandoned).not.toHaveBeenCalled();
  });

  it('does not mount hidden tabs, and preserves a draft after visiting another tab', async () => {
    const load = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState('saved');
      useEffect(() => { load(); }, []);
      return React.createElement('input', { value: draft, onChange: setDraft });
    }
    const panel = (active: boolean) => React.createElement(LazyTabPanel, { id: 'security', active }, React.createElement(Editor));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(panel(false)); });
    expect(load).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    await act(async () => { renderer.update(panel(true)); });
    act(() => { renderer.root.findByType('input').props.onChange('unsaved'); });
    await act(async () => { renderer.update(panel(false)); });
    await act(async () => { renderer.update(panel(true)); });
    expect(load).toHaveBeenCalledOnce();
    expect(renderer.root.findByType('input').props.value).toBe('unsaved');
    act(() => renderer.unmount());
  });

  it('loads on edit, allows closing during the read, then reopens the fetched snapshot', async () => {
    vi.stubGlobal('document', { body: {} });
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(BotDescriptionControl, { bot: { larkAppId: 'app_lazy_description' } })); });
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { renderer.root.findByProps({ 'data-action': 'edit-bot-description' }).props.onClick(); });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/bots/app_lazy_description/description');
    expect(renderer.root.findByProps({ className: 'primary' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ 'data-action': 'close-bot-description' }).props.disabled).toBe(false);
    expect(renderer.root.findByProps({ 'data-action': 'cancel-bot-description' }).props.disabled).toBe(false);

    act(() => { renderer.root.findByProps({ 'data-action': 'cancel-bot-description' }).props.onClick(); });
    expect(renderer.root.findAllByProps({ 'data-action': 'cancel-bot-description' })).toHaveLength(0);
    await act(async () => { resolve(new Response(JSON.stringify({ ok: true, primaryLang: 'en_us', languages: [{ lang: 'en_us', description: 'Existing remote description' }] }))); });

    await act(async () => { renderer.root.findByProps({ 'data-action': 'edit-bot-description' }).props.onClick(); });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(renderer.root.findByType('textarea').props.value).toBe('Existing remote description');
    expect(renderer.root.findByProps({ className: 'primary' }).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });
});
