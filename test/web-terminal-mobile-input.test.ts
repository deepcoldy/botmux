import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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
  textContent = '';
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
  textareaScrollHeight?: number;
}): MobileHarness {
  const source = workerSource();
  const formStart = source.indexOf('<form id="mobile-input-bar"');
  const formEnd = source.indexOf('</form>', formStart);
  const form = source.slice(formStart, formEnd);
  const shortcutButtons = [...form.matchAll(/<button([^>]*data-sk="([^"]+)"[^>]*)>/g)].map(match => {
    const id = match[1].match(/id="([^"]+)"/)?.[1] ?? `shortcut-${match[2]}`;
    return new FakeElement(id, { 'data-sk': match[2] });
  });

  const bar = new FakeElement('mobile-input-bar');
  bar.offsetHeight = options.barHeight ?? 91;
  bar.rectHeight = options.barRectHeight;
  const textarea = new FakeElement('mobile-input');
  textarea.scrollHeight = options.textareaScrollHeight ?? 38;
  const mode = new FakeElement('mobile-mode');
  const send = new FakeElement('mobile-send');
  const hint = new FakeElement('mobile-live-hint');
  const terminal = new FakeElement('terminal');
  const controls = [mode, textarea, send, ...shortcutButtons];
  bar.descendants = controls;

  const byId = new Map<string, FakeElement>([
    [bar.id, bar],
    [textarea.id, textarea],
    [mode.id, mode],
    [send.id, send],
    [hint.id, hint],
    [terminal.id, terminal],
    ...shortcutButtons.map(button => [button.id, button] as const),
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
      /body\.touch\.has-token #terminal \.xterm\s*\{[^}]*padding-bottom:\s*calc\(var\(--mobile-bar-h,\s*0px\)\s*\+\s*var\(--keyboard-inset,\s*0px\)\)/s,
    );
    expect(source).toMatch(
      /transform:\s*translateY\(calc\(0px\s*-\s*var\(--keyboard-inset,\s*0px\)\)\)/,
    );

    const page = bootMobileInput({ wsHasWrite: true, barHeight: 88, barRectHeight: 88.1875 });
    expect(page.rootProperty('--mobile-bar-h')).toBe('89px');
    expect(844 - Number.parseInt(page.rootProperty('--mobile-bar-h')!, 10)).toBe(755);
    expect(page.viewportResizeCount()).toBeGreaterThan(0);
  });

  it('空输入保持单行，主输入行只保留等高的模式、输入和发送控件', () => {
    const source = workerSource();
    const rowStart = source.indexOf('<div id="mobile-bar-row">');
    const rowEnd = source.indexOf('</div>\n</form>', rowStart);
    const row = source.slice(rowStart, rowEnd);

    expect(row).not.toMatch(/id="mobile-(?:up|bs|down)"/);
    expect(row).toContain('placeholder="输入命令…"');
    expect(source).toMatch(/#mobile-input\s*\{[^}]*min-height:42px/s);
    expect(source).toMatch(/#mobile-bar-row button\s*\{[^}]*height:42px/s);

    const page = bootMobileInput({ wsHasWrite: true, textareaScrollHeight: 54 });
    expect(page.textarea.style.height).toBe('42px');

    page.textarea.value = '需要换行的较长命令';
    page.textarea.scrollHeight = 68;
    page.textarea.dispatch('input');
    expect(page.textarea.style.height).toBe('68px');
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
    // 上屏 types the text into the CLI's input box and stops — no trailing
    // newline, which would land there as a literal blank line.
    expect(connected.sentInputs()).toEqual(['ship it']);
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

  it('上移、删除和下移归入可滚动快捷键行，仍发送原有终端序列', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    const up = page.shortcut('up');
    const backspace = page.shortcut('bs');
    const down = page.shortcut('down');
    expect(up).toBeDefined();
    expect(backspace).toBeDefined();
    expect(down).toBeDefined();
    up?.dispatch('click');
    backspace?.dispatch('click');
    down?.dispatch('click');
    expect(page.sentInputs()).toEqual(['\x1b[A', '\x7f', '\x1b[B']);
  });

  it('缓冲模式的按钮叫「上屏」并说明还要按 Enter，实时模式才叫「发送」', () => {
    const source = workerSource();
    // The static markup must already say 上屏 so there is no flash of the wrong
    // word before setMode() runs on boot.
    expect(source).toMatch(/<button id="mobile-send" type="submit">上屏<\/button>/);

    const page = bootMobileInput({ wsHasWrite: true });
    const send = page.controls.find(control => control.id === 'mobile-send');
    expect(send?.textContent).toBe('上屏');
    expect(send?.getAttribute('aria-label')).toContain('Enter');
    const mode = page.controls.find(control => control.id === 'mobile-mode');
    expect(mode?.getAttribute('aria-label')).toContain('Enter');

    // Switching to live mode makes the button a real submit again.
    mode?.dispatch('click');
    expect(send?.textContent).toBe('发送');
    expect(mode?.textContent).toBe('实时');
    mode?.dispatch('click');
    expect(send?.textContent).toBe('上屏');
  });

  it('长按 ⌫ 连续删除，松手即停，且 Enter/Ctrl+C 这类一次性键从不重复', () => {
    vi.useFakeTimers();
    try {
      const page = bootMobileInput({ wsHasWrite: true });
      const backspace = page.shortcut('bs');
      expect(backspace).toBeDefined();

      // A press shorter than the repeat delay must not add any repeat tick.
      backspace?.dispatch('pointerdown');
      vi.advanceTimersByTime(200);
      backspace?.dispatch('pointerup');
      vi.advanceTimersByTime(600);
      expect(page.sentInputs()).toEqual([]);

      // Holding past the delay repeats at a steady cadence…
      backspace?.dispatch('pointerdown');
      vi.advanceTimersByTime(450 + 60 * 5);
      const whileHeld = page.sentInputs().length;
      expect(whileHeld).toBe(5);
      expect(page.sentInputs().every(sequence => sequence === '\x7f')).toBe(true);

      // …and releasing stops it immediately (no ticks after pointerup).
      backspace?.dispatch('pointerup');
      // The browser always sends a click when the finger lifts — it arrives
      // AFTER the repeat ticks, so it must be swallowed rather than delete one
      // more character than the user watched tick by.
      backspace?.dispatch('click');
      vi.advanceTimersByTime(600);
      expect(page.sentInputs().length).toBe(whileHeld);
    } finally {
      vi.useRealTimers();
    }
  });

  it('一次性键长按不重复，手指移开或断线都会停下重复', () => {
    vi.useFakeTimers();
    try {
      // Repeating Enter would run the command several times; Ctrl+C would spray
      // interrupts. Neither may gain a repeat handler.
      const oneShot = bootMobileInput({ wsHasWrite: true });
      for (const action of ['enter', 'ctrlc', 'esc', 'tab', 'stab', 'paste']) {
        oneShot.shortcut(action)?.dispatch('pointerdown');
        vi.advanceTimersByTime(450 + 60 * 10);
        oneShot.shortcut(action)?.dispatch('pointerup');
      }
      expect(oneShot.sentInputs()).toEqual([]);

      // Sliding the finger off the key stops the repeat too.
      const slide = bootMobileInput({ wsHasWrite: true });
      slide.shortcut('left')?.dispatch('pointerdown');
      vi.advanceTimersByTime(450 + 60 * 3);
      const beforeLeave = slide.sentInputs().length;
      expect(beforeLeave).toBe(3);
      slide.shortcut('left')?.dispatch('pointerleave');
      vi.advanceTimersByTime(600);
      expect(slide.sentInputs().length).toBe(beforeLeave);

      // A socket that stops accepting input mid-hold must not spin forever.
      const dropped = bootMobileInput({ wsHasWrite: true });
      dropped.shortcut('bs')?.dispatch('pointerdown');
      vi.advanceTimersByTime(450 + 60 * 2);
      const beforeDrop = dropped.sentInputs().length;
      expect(beforeDrop).toBe(2);
      dropped.setWriteState?.(null);
      vi.advanceTimersByTime(600);
      expect(dropped.sentInputs().length).toBe(beforeDrop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('长按后手指滑开(无 click)，下一次单击仍然生效——吞掉尾随 click 的标志必须每次按下重置', () => {
    vi.useFakeTimers();
    try {
      const page = bootMobileInput({ wsHasWrite: true });

      // Slide off after the repeat has started: pointerleave stops the ticks and
      // the browser sends NO click, so the swallow flag is left armed.
      page.shortcut('bs')?.dispatch('pointerdown');
      vi.advanceTimersByTime(450 + 60 * 3);
      page.shortcut('bs')?.dispatch('pointerleave');
      const afterSlide = page.sentInputs().length;
      expect(afterSlide).toBe(3);

      // The next plain tap must still delete one character. Without the reset on
      // pointerdown the stale flag eats it and the key silently does nothing.
      page.shortcut('bs')?.dispatch('pointerdown');
      vi.advanceTimersByTime(100);
      page.shortcut('bs')?.dispatch('pointerup');
      page.shortcut('bs')?.dispatch('click');
      expect(page.sentInputs().length).toBe(afterSlide + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('「上屏」只把正文送上终端，不追加换行——追加的换行会在 CLI 输入框里留下一个空行', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    page.textarea.value = '继续';
    page.bar.dispatch('submit');

    const sent = page.sentInputs();
    expect(sent).toEqual(['继续']);
    // The regression this pins: a trailing \n is NOT a submit in a TUI, it is an
    // inserted line break, so the text showed up with a stray empty line after it.
    expect(sent.some(sequence => sequence.endsWith('\n'))).toBe(false);
    // …and it must not silently become a real submit either — that would throw
    // away the deliberate two-step 上屏 → 检查 → Enter semantics.
    expect(sent.some(sequence => sequence.endsWith('\r'))).toBe(false);

    // The Enter key is what actually runs it, and it still does.
    page.shortcut('enter')?.dispatch('click');
    expect(page.sentInputs()).toEqual(['继续', '\r']);
  });

  it('实时模式的「发送」仍然真提交，两步语义只属于缓冲模式', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    page.controls.find(control => control.id === 'mobile-mode')?.dispatch('click');
    page.textarea.value = 'ls';
    page.bar.dispatch('submit');
    // live mode diffs the mirror and appends a carriage return: a real submit.
    expect(page.sentInputs().join('').endsWith('\r')).toBe(true);
  });

  it('输入框字号不低于 16px，否则 iOS 聚焦时会自动放大页面且不再缩回', () => {
    const source = workerSource();
    const start = source.indexOf('#mobile-input{');
    expect(start, '#mobile-input 规则缺失').toBeGreaterThan(-1);
    const rule = source.slice(start, source.indexOf('}', start));
    const fontSize = rule.match(/font:\s*(\d+(?:\.\d+)?)px/);
    expect(fontSize, '#mobile-input 未声明 px 字号').not.toBeNull();
    // Hard floor, not a taste call: below 16px, iOS Safari / WKWebView zooms the
    // page on focus and never zooms back, pushing the terminal's right-hand
    // columns off screen. -webkit-text-size-adjust does not prevent this.
    expect(Number.parseFloat(fontSize![1])).toBeGreaterThanOrEqual(16);
  });

  it('实时模式下输入框已空时，系统键盘的删除键仍然删得掉终端里的字符', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    page.controls.find(control => control.id === 'mobile-mode')?.dispatch('click');
    expect(page.bar.getAttribute('data-mode')).toBe('live');

    // The regression this pins: live mode only ever sends what the textarea's
    // `input` event diffs, and deleting from an EMPTY box changes nothing — so a
    // real browser fires beforeinput but NO input event at all (verified with
    // Playwright + a real worker). Every Backspace was silently dropped, which
    // is exactly what "上屏 的字用系统键盘删不掉" looks like: the text is on the
    // terminal, the box is empty, and the key does nothing.
    page.textarea.value = '';
    page.textarea.dispatch('keydown', { key: 'Backspace' });
    expect(page.sentInputs()).toEqual(['\x7f']);

    // A pending IME draft must still edit locally instead of eating terminal
    // characters, so a non-empty box is left to the diff path (which the browser
    // does drive with a real input event).
    page.textarea.value = 'ab';
    page.textarea.dispatch('keydown', { key: 'Backspace' });
    expect(page.sentInputs()).toEqual(['\x7f']);
  });

  it('缓冲模式下删除键不被接管，仍然只编辑输入框', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    expect(page.bar.getAttribute('data-mode')).toBe('buffer');
    page.textarea.value = '';
    page.textarea.dispatch('keydown', { key: 'Backspace' });
    // Buffer mode's box is a staging area — an empty-box Backspace there means
    // "nothing to delete", not "delete a terminal character".
    expect(page.sentInputs()).toEqual([]);
  });

  it('切进实时模式时，输入框里没上屏的文字要送上终端而不是隐形留着', () => {
    const page = bootMobileInput({ wsHasWrite: true });
    page.textarea.value = 'hello';
    page.controls.find(control => control.id === 'mobile-mode')?.dispatch('click');

    // Live mode renders the textarea transparent, so leftover text is invisible
    // to the user while still being the mirror's baseline mismatch: the next
    // keystroke diffed '' → 'hell' and INSERTED the stale text into the terminal
    // instead of deleting anything. Flush it the way 上屏 does.
    expect(page.sentInputs()).toEqual(['hello']);
    expect(page.textarea.value).toBe('');

    // …and it must stay an insert, not a submit — the two-step semantics hold.
    expect(page.sentInputs().some(sequence => sequence.endsWith('\r'))).toBe(false);

    // With the box actually empty, the very next Backspace reaches the terminal.
    page.textarea.dispatch('keydown', { key: 'Backspace' });
    expect(page.sentInputs()).toEqual(['hello', '\x7f']);
  });

  it('底栏按钮抑制 iOS 长按选中与 callout，避免长按删除时弹出选择气泡', () => {
    const source = workerSource();
    // `user-select` alone leaves the WKWebView selection handles / callout menu
    // on a long press — the `-webkit-` pair is what suppresses both.
    for (const selector of ['#mobile-bar-keys button', '#mobile-bar-row button']) {
      const start = source.indexOf(`${selector}{`);
      expect(start, `${selector} 规则缺失`).toBeGreaterThan(-1);
      const rule = source.slice(start, source.indexOf('}', start));
      expect(rule, selector).toContain('-webkit-user-select:none');
      expect(rule, selector).toContain('user-select:none');
      expect(rule, selector).toContain('-webkit-touch-callout:none');
    }
  });
});
