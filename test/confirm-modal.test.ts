/**
 * confirm-modal.test.ts
 *
 * 覆盖统一弹窗系统 (src/dashboard/web/confirm-modal.tsx) 的行为契约，重点是
 * 新增的 promptText 变体与 window.prompt 的语义对齐：
 *
 *   - promptText 确认 → resolve 输入串；**确认空输入 → resolve ''（不是 null）**
 *   - promptText 取消 / Esc / 点遮罩 → resolve null
 *   - confirm 仍 resolve 布尔（回归保护，两种弹窗共用队列不能串味）
 *   - 并发排队 FIFO，prompt / confirm 混排各自 resolve 正确类型
 *
 * ConfirmModalRoot 用原生 <dialog>：react-test-renderer 无 DOM 宿主，dialogRef
 * 恒为 null，showModal()/focus() 的 effect 均有 null 兜底，因此可安全渲染；
 * 只需 stub window.requestAnimationFrame。所有交互通过队首 dialog 的 props
 * (onClick / onCancel) 及卡片内 input/button 的 props 触发。
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { confirm, promptText, ConfirmModalRoot } from '../src/dashboard/web/confirm-modal.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// window.requestAnimationFrame 是队首变化 effect 里唯一的浏览器依赖（用于把焦点
// 落到输入框）；node 环境没有 window，stub 成一个不真正调度的空实现即可——ref 恒
// 为 null，回调即便执行也是 no-op。
function withStubbedWindow(): void {
  vi.stubGlobal('window', { requestAnimationFrame: (_cb: FrameRequestCallback) => 0 });
}

afterEach(() => {
  // 卸载本用例挂载的所有 root：ConfirmModalRoot 在挂载期把 listener 注册进模块级
  // listeners Set，卸载才会移除。不清理则跨用例累积 stale root（当前 ref 恒 null
  // 无害，但脆——一个 emit() 会驱动所有历史 root 重渲染）。
  act(() => {
    for (const r of mountedRoots) r.unmount();
  });
  mountedRoots.length = 0;
  vi.unstubAllGlobals();
});

// 渲染一个 ConfirmModalRoot 并返回其 renderer；队列是模块级单例，弹窗调用在
// 渲染前后皆可，emit() 会驱动 root 重渲染到最新队首。挂载的 root 收进 mountedRoots，
// 由 afterEach 统一 unmount（见上）。
const mountedRoots: TestRenderer.ReactTestRenderer[] = [];
function mountRoot(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ConfirmModalRoot));
  });
  mountedRoots.push(renderer);
  return renderer;
}

// 入队 confirm/promptText 必须包进 act：confirm()/promptText() 会同步 emit() →
// ConfirmModalRoot 的 force() 状态更新，不裹 act 则该更新不会 flush 到测试树，
// 队首内容（按钮/输入框）不会渲染出来，随后的 findByType 会落空、promise 永不结算。
function enqueue<T>(start: () => Promise<T>): Promise<T> {
  let promise!: Promise<T>;
  act(() => { promise = start(); });
  return promise;
}

function dialogOf(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.findByType('dialog');
}
function inputOf(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.findByType('input');
}
// 队首无输入框时 findByType 会抛，用可选查找
function maybeInput(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance | undefined {
  return renderer.root.findAllByType('input')[0];
}
function buttonByText(renderer: TestRenderer.ReactTestRenderer, text: string): TestRenderer.ReactTestInstance {
  return renderer.root.findAll(n => n.type === 'button' && n.children.includes(text))[0];
}
function click(renderer: TestRenderer.ReactTestRenderer, text: string): void {
  act(() => buttonByText(renderer, text).props.onClick());
}
function typeInto(renderer: TestRenderer.ReactTestRenderer, value: string): void {
  act(() => inputOf(renderer).props.onInput({ target: { value } }));
}
// 模拟输入框按键；isComposing 走 nativeEvent，对齐产品代码读的 event.nativeEvent.isComposing
function keyDown(renderer: TestRenderer.ReactTestRenderer, key: string, opts: { isComposing?: boolean } = {}): void {
  act(() => inputOf(renderer).props.onKeyDown({ key, nativeEvent: { isComposing: opts.isComposing ?? false } }));
}

describe('promptText — window.prompt 语义对齐', () => {
  it('确认后 resolve 输入的文本', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => promptText({ title: 'T', message: '工作目录：' }));
    typeInto(renderer, '/tmp/repro');
    click(renderer, '确认');
    expect(await p).toBe('/tmp/repro');
  });

  it('确认空输入 resolve 空串 ""（关键：区别于取消的 null）', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => promptText({ title: 'T', message: 'M' }));
    // 不输入任何内容，直接确认
    click(renderer, '确认');
    const v = await p;
    expect(v).toBe('');
    expect(v).not.toBeNull();
  });

  it('取消 → resolve null（即便已输入内容也不回传）', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => promptText({ title: 'T', message: 'M' }));
    typeInto(renderer, '不该被返回');
    click(renderer, '取消');
    expect(await p).toBeNull();
  });

  it('Esc (dialog onCancel) → resolve null', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => promptText({ title: 'T', message: 'M' }));
    typeInto(renderer, 'abc');
    act(() => dialogOf(renderer).props.onCancel({ preventDefault() {} }));
    expect(await p).toBeNull();
  });

  it('点遮罩 (target === currentTarget) → resolve null', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => promptText({ title: 'T', message: 'M' }));
    act(() => {
      const el = {};
      dialogOf(renderer).props.onClick({ target: el, currentTarget: el });
    });
    expect(await p).toBeNull();
  });

  it('defaultValue 预填输入框，确认原样回传', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => promptText({ title: 'T', message: 'M', defaultValue: '/home/x' }));
    expect(inputOf(renderer).props.value).toBe('/home/x');
    click(renderer, '确认');
    expect(await p).toBe('/home/x');
  });

  it('Enter 键提交（非组词）→ resolve 当前输入', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => promptText({ title: 'T', message: 'M' }));
    typeInto(renderer, '/srv/app');
    keyDown(renderer, 'Enter');
    expect(await p).toBe('/srv/app');
  });

  it('IME 组词中的 Enter 不提交（isComposing=true 时放行给输入法）', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    let settled = false;
    const p = enqueue(() => promptText({ title: 'T', message: 'M' }).then(v => { settled = true; return v; }));
    typeInto(renderer, '目录');
    // 组词上屏的 Enter：不得提交
    keyDown(renderer, 'Enter', { isComposing: true });
    await Promise.resolve(); // 放行微任务，若误 settle 这里 settled 会翻真
    expect(settled).toBe(false);
    expect(maybeInput(renderer)).toBeDefined(); // 弹窗仍开，队首未结算
    // 组词结束后的 Enter 才真正提交
    keyDown(renderer, 'Enter', { isComposing: false });
    expect(await p).toBe('目录');
  });
});

describe('confirm — 布尔语义回归 (共用队列不能串味)', () => {
  it('确认 → true，且卡片默认无输入框', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => confirm({ title: 'T', message: 'M' }));
    expect(maybeInput(renderer)).toBeUndefined(); // 普通 confirm 不渲染输入框
    click(renderer, '确认');
    expect(await p).toBe(true);
  });

  it('取消 → false（不是 null，也不是空串）', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => confirm({ title: 'T', message: 'M' }));
    click(renderer, '取消');
    const v = await p;
    expect(v).toBe(false);
    expect(v).not.toBeNull();
  });

  it('requireText 强确认：输入匹配前确认按钮 disabled', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p = enqueue(() => confirm({ title: 'T', message: 'M', requireText: '解散' }));
    expect(buttonByText(renderer, '确认').props.disabled).toBe(true);
    typeInto(renderer, '解散');
    expect(buttonByText(renderer, '确认').props.disabled).toBe(false);
    click(renderer, '确认');
    expect(await p).toBe(true);
  });
});

describe('并发排队 — prompt / confirm 混排各自 resolve 正确类型', () => {
  it('FIFO：先 confirm 后 promptText，依次结算互不串味', async () => {
    withStubbedWindow();
    const renderer = mountRoot();
    const p1 = enqueue(() => confirm({ title: 'C', message: 'M' }));
    const p2 = enqueue(() => promptText({ title: 'P', message: 'M' }));
    // 队首是 confirm（无输入框），点确认 → true
    expect(maybeInput(renderer)).toBeUndefined();
    click(renderer, '确认');
    expect(await p1).toBe(true);
    // 队首推进到 prompt（有输入框），输入并确认 → 文本
    typeInto(renderer, 'second');
    click(renderer, '确认');
    expect(await p2).toBe('second');
  });
});
