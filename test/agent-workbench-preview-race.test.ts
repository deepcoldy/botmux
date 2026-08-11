import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewInteractionState, WorkbenchApi } from '../src/dashboard/web/agent-workbench-api.js';
import { TerminalPane, WebPane } from '../src/dashboard/web/agent-workbench-panes.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const interactive = (): PreviewInteractionState => ({
  mode: 'interactive',
  label: '交互模式',
  securityNotice: '交互蒙层不是应用级强只读安全边界。',
  idleExpiresAt: Date.now() + 60_000,
});

const preview = (): PreviewInteractionState => ({
  mode: 'preview',
  label: '预览模式（默认）',
  securityNotice: '交互蒙层不是应用级强只读安全边界。',
});

describe('Agent Workbench preview request ordering', () => {
  afterEach(() => vi.useRealTimers());

  it('does not let an older activity response overwrite an explicit lock', async () => {
    const lateActivity = deferred<PreviewInteractionState>();
    const api: WorkbenchApi = {
      getTerminalControl: async () => ({ mode: 'readonly', owned: false }),
      takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: Date.now() + 60_000 }),
      releaseTerminal: async () => ({ mode: 'readonly', owned: false }),
      getPreviewInteraction: async () => interactive(),
      unlockPreview: async () => interactive(),
      touchPreview: async () => lateActivity.promise,
      lockPreview: async () => preview(),
      getH5Context: async () => null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WebPane, {
        session: {
          sessionId: 's1',
          status: 'working',
          preview: { path: '/preview/s1/', registeredAt: new Date().toISOString() },
        },
        api,
        authenticated: true,
        now: Date.now(),
      }));
    });
    expect(renderer.root.findAll(node => String(node.props.className).includes('is-interactive'))).toHaveLength(1);

    const pane = renderer.root.findByProps({ 'aria-label': 'Web preview pane' });
    await act(async () => { pane.props.onPointerDown({ target: null }); });
    const lock = renderer.root.findAllByType('button').find(button => button.children.includes('Lock now'))!;
    await act(async () => { await lock.props.onClick(); });
    lateActivity.resolve(interactive());
    await act(async () => { await lateActivity.promise; });

    expect(renderer.root.findAll(node => String(node.props.className).includes('is-preview'))).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.props.className).includes('is-interactive'))).toHaveLength(0);
    expect(renderer.root.findByType('iframe').props['data-interaction-generation']).toBe(1);
    act(() => renderer.unmount());
  });

  it('refreshes the visible Terminal state after a control disconnect/expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let reads = 0;
    const api: WorkbenchApi = {
      getTerminalControl: async () => reads++ === 0
        ? { mode: 'controlled', owned: true, expiresAt: 61_000 }
        : { mode: 'readonly', owned: false },
      takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: 61_000 }),
      releaseTerminal: async () => ({ mode: 'readonly', owned: false }),
      getPreviewInteraction: async () => preview(),
      unlockPreview: async () => interactive(),
      touchPreview: async () => interactive(),
      lockPreview: async () => preview(),
      getH5Context: async () => null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TerminalPane, {
        session: { sessionId: 's1', status: 'working', webPort: 3000, proxyPort: 31151 },
        api,
        authenticated: true,
        now: 1_000,
        location: { protocol: 'http:', origin: 'http://dashboard.test', hostname: 'dashboard.test' },
      }));
    });
    expect(renderer.root.findAll(node => String(node.props.className).includes('is-controlled'))).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(renderer.root.findAll(node => String(node.props.className).includes('is-controlled'))).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.props.className).includes('is-readonly'))).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('refreshes the visible Web label at the exact interaction deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let reads = 0;
    const api: WorkbenchApi = {
      getTerminalControl: async () => ({ mode: 'readonly', owned: false }),
      takeoverTerminal: async () => ({ mode: 'controlled', owned: true, expiresAt: 60_000 }),
      releaseTerminal: async () => ({ mode: 'readonly', owned: false }),
      getPreviewInteraction: async () => reads++ === 0
        ? { ...interactive(), idleExpiresAt: 3_000 }
        : preview(),
      unlockPreview: async () => interactive(),
      touchPreview: async () => interactive(),
      lockPreview: async () => preview(),
      getH5Context: async () => null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WebPane, {
        session: {
          sessionId: 's1',
          status: 'working',
          preview: { path: '/preview/s1/', registeredAt: new Date().toISOString() },
        },
        api,
        authenticated: true,
        now: 1_000,
      }));
    });
    expect(renderer.root.findAll(node => String(node.props.className).includes('is-interactive'))).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_025); });
    expect(renderer.root.findAll(node => String(node.props.className).includes('is-preview'))).toHaveLength(1);
    act(() => renderer.unmount());
  });
});
