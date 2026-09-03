import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = (): string => readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function extractMobileInputScript(source = workerSource()): string {
  const start = source.indexOf("if(isTouch&&hasToken){(function(){\n  document.body.classList.add('has-token');");
  expect(start, 'worker.ts 里找不到手机输入栏脚本').toBeGreaterThan(-1);
  const endMarker = '\n})();}\n</script>';
  const end = source.indexOf(endMarker, start);
  expect(end, '手机输入栏脚本没有正常闭合').toBeGreaterThan(-1);
  // Execute the browser script after the outer TypeScript template literal has
  // consumed one escaping layer (worker.ts source has \\x1b; served HTML has \x1b).
  return source.slice(start, end + '\n})();}'.length).replaceAll('\\\\', '\\');
}

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  value = '';
  disabled = false;
  scrollHeight = 38;
  offsetHeight = 91;
  rectHeight: number | undefined;
  style: Record<string, string> = {};
  descendants: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
  };

  constructor(readonly id: string, attrs: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attrs)) this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const payload = {
      preventDefault: () => {},
      isComposing: false,
      ...event,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  focus(): void {}
  blur(): void {}
  getBoundingClientRect(): { height: number } {
    return { height: this.rectHeight ?? this.offsetHeight };
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === 'button,textarea' ? this.descendants : [];
  }
}

interface MobileHarness {
  bar: FakeElement;
  textarea: FakeElement;
  controls: FakeElement[];
  shortcut(action: string): FakeElement | undefined;
  sentInputs(): string[];
  rootProperty(name: string): string | undefined;
  viewportResizeCount(): number;
  setWriteState: ((value: boolean | null) => void) | null;
}

function bootMobileInput(options: {
  wsHasWrite: boolean | null;
  readyState?: number;
  barHeight?: number;
  barRectHeight?: number;
}): MobileHarness {
  const source = workerSource();
  const formStart = source.indexOf('<form id="mobile-input-bar"');
  const formEnd = source.indexOf('</form>', formStart);
  const form = source.slice(formStart, formEnd);
  const shortcutActions = [...form.matchAll(/data-sk="([^"]+)"/g)].map(match => match[1]);

  const bar = new FakeElement('mobile-input-bar');
  bar.offsetHeight = options.barHeight ?? 91;
  bar.rectHeight = options.barRectHeight;
  const textarea = new FakeElement('mobile-input');
  const mode = new FakeElement('mobile-mode');
  const send = new FakeElement('mobile-send');
  const up = new FakeElement('mobile-up');
  const down = new FakeElement('mobile-down');
  const backspace = new FakeElement('mobile-bs');
  const hint = new FakeElement('mobile-live-hint');
  const terminal = new FakeElement('terminal');
  const shortcutButtons = shortcutActions.map(action => new FakeElement(`shortcut-${action}`, { 'data-sk': action }));
  const controls = [mode, textarea, up, backspace, down, send, ...shortcutButtons];
  bar.descendants = controls;

  const byId = new Map<string, FakeElement>([
    [bar.id, bar],
    [textarea.id, textarea],
    [mode.id, mode],
    [send.id, send],
    [up.id, up],
    [down.id, down],
    [backspace.id, backspace],
    [hint.id, hint],
    [terminal.id, terminal],
  ]);
  const rootProperties = new Map<string, string>();
  const body = new FakeElement('body');
  const documentStub = {
    body,
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => rootProperties.set(name, value),
      },
    },
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === '#mobile-bar-keys button' ? shortcutButtons : [],
  };
  const windowStub = {
    innerHeight: 844,
    visualViewport: undefined,
  };
  const sent: string[] = [];
  const ws = {
    readyState: options.readyState ?? 1,
    send: (payload: string) => sent.push(payload),
  };
  let resizeCount = 0;
  const resizeObservers: Array<() => void> = [];
  class ResizeObserverStub {
    constructor(callback: () => void) { resizeObservers.push(callback); }
    observe(): void {}
  }

  const result = new Function(
    'isTouch',
    'hasToken',
    'document',
    'window',
    'navigator',
    'ws_',
    'wsHasWrite',
    'onViewportResize',
    'ResizeObserver',
    '_wbMobileWriteState',
    `${extractMobileInputScript(source)}\nreturn {setWriteState:_wbMobileWriteState};`,
  )(
    true,
    true,
    documentStub,
    windowStub,
    {},
    ws,
    options.wsHasWrite,
    () => { resizeCount += 1; },
    ResizeObserverStub,
    null,
  ) as { setWriteState: ((value: boolean | null) => void) | null };

  for (const callback of resizeObservers) callback();
  return {
    bar,
    textarea,
    controls,
    shortcut: action => shortcutButtons.find(button => button.getAttribute('data-sk') === action),
    sentInputs: () => sent.map(payload => JSON.parse(payload).data as string),
    rootProperty: name => rootProperties.get(name),
    viewportResizeCount: () => resizeCount,
    setWriteState: result.setWriteState,
  };
}

describe('手机 Web 终端输入栏', () => {
  it('把实测底栏高度留给终端，390×844 时内容区不会落到底栏后面', () => {
    const source = workerSource();
    expect(source).toMatch(
      /body\.touch\.has-token #terminal\s*\{[^}]*padding-bottom:\s*calc\(var\(--mobile-bar-h,\s*0px\)\s*\+\s*var\(--keyboard-inset,\s*0px\)\)/s,
    );
    expect(source).toMatch(
      /transform:\s*translateY\(calc\(0px\s*-\s*var\(--keyboard-inset,\s*0px\)\)\)/,
    );

    const page = bootMobileInput({ wsHasWrite: true, barHeight: 88, barRectHeight: 88.1875 });
    expect(page.rootProperty('--mobile-bar-h')).toBe('89px');
    expect(844 - Number.parseInt(page.rootProperty('--mobile-bar-h')!, 10)).toBe(755);
    expect(page.viewportResizeCount()).toBeGreaterThan(0);
  });

  it('断线或权限未知时禁用输入且保留未发送草稿，恢复可写后再发送并清空', () => {
    const disconnected = bootMobileInput({ wsHasWrite: null, readyState: 3 });
    disconnected.textarea.value = 'keep this draft';
    disconnected.bar.dispatch('submit');
    expect(disconnected.sentInputs()).toEqual([]);
    expect(disconnected.textarea.value).toBe('keep this draft');
    expect(disconnected.controls.every(control => control.disabled)).toBe(true);

    const connected = bootMobileInput({ wsHasWrite: true });
    connected.textarea.value = 'ship it';
    connected.bar.dispatch('submit');
    expect(connected.sentInputs()).toEqual(['ship it\n']);
    expect(connected.textarea.value).toBe('');
  });

  it('重连状态通过同一写权限钩子切换控件，已有草稿原样保留', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    expect(page.setWriteState).toBeTypeOf('function');
    page.textarea.value = 'draft across reconnect';
    page.setWriteState?.(null);
    expect(page.controls.every(control => control.disabled)).toBe(true);
    expect(page.textarea.value).toBe('draft across reconnect');
    page.setWriteState?.(true);
    expect(page.controls.every(control => !control.disabled)).toBe(true);

    expect(workerSource()).toMatch(
      /function _wbSetWsWrite\(v\)[\s\S]*?_wbMobileWriteState[\s\S]*?_wbPostWrite\(\);/,
    );
  });

  it('快捷键行提供 ←/→，发送标准 ANSI 左右方向序列', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    const left = page.shortcut('left');
    const right = page.shortcut('right');
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    left?.dispatch('click');
    right?.dispatch('click');
    expect(page.sentInputs()).toEqual(['\x1b[D', '\x1b[C']);
  });
});
