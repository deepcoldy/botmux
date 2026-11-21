import { describe, expect, it } from 'vitest';

import { WEB_TERMINAL_BOOT_ERROR_HANDLER_SOURCE } from '../src/core/web-terminal-boot-error.js';

// 跑的是终端页里嵌的同一段源码：给它一个只有 #status / #boot-error 的假 document。

class FakeEl {
  textContent = '';
  className = '';
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
  };
}

function setup(withBox = true) {
  const status = new FakeEl();
  status.textContent = '加载中…';
  const box = new FakeEl();
  const document = {
    getElementById: (id: string) => (id === 'status' ? status : id === 'boot-error' && withBox ? box : null),
  };
  const handler = new Function('document', `return ${WEB_TERMINAL_BOOT_ERROR_HANDLER_SOURCE};`)(document) as
    (event: { target?: unknown; message?: string }) => void;
  return { status, box, handler };
}

const scriptLoadFailure = (file: string) => ({
  target: { tagName: 'SCRIPT', src: `https://t.example/s/sess-1/__botmux/vendor/${file}` },
});
const referenceError = { target: {}, message: "ReferenceError: Can't find variable: Terminal" };

describe('终端页启动报错', () => {
  it('组件加载失败后，随之而来的 ReferenceError 不覆盖「终端组件加载失败」', () => {
    const { status, box, handler } = setup();
    handler(scriptLoadFailure('xterm-5.5.0/xterm.js'));
    expect(box.textContent).toBe('终端组件加载失败：xterm.js');
    expect(box.classList.contains('show')).toBe(true);
    expect(status.textContent).toBe('加载失败');

    // 主脚本先把 #status 改成「初始化…」，再在 new Terminal 处抛错
    status.textContent = '初始化…';
    handler(referenceError);
    // 后续插件也都加载失败
    handler(scriptLoadFailure('addon-fit-0.10.0/addon-fit.js'));

    expect(box.textContent).toBe('终端组件加载失败：xterm.js');
    expect(status.textContent).toBe('加载失败');
    expect(status.className).toBe('err');
  });

  it('第一条是页面报错时同样只保留它', () => {
    const { box, handler } = setup();
    handler({ target: {}, message: 'TypeError: x is not a function' });
    handler(referenceError);
    expect(box.textContent).toBe('终端页面错误：TypeError: x is not a function');
  });

  it('没有可显示内容的 error 事件既不显示也不占位，之后的真实报错照常显示', () => {
    const { status, box, handler } = setup();
    handler({ target: { tagName: 'IMG', src: 'x.png' } });
    handler({ target: { tagName: 'SCRIPT', src: '' } });
    expect(status.textContent).toBe('加载中…');
    expect(box.classList.contains('show')).toBe(false);

    handler(scriptLoadFailure('xterm-5.5.0/xterm.js'));
    expect(box.textContent).toBe('终端组件加载失败：xterm.js');
  });

  it('页面里没有 #boot-error 时只更新 #status，不抛错', () => {
    const { status, handler } = setup(false);
    expect(() => handler(scriptLoadFailure('xterm-5.5.0/xterm.js'))).not.toThrow();
    expect(status.textContent).toBe('加载失败');
  });
});
