import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ModalDialog, type ModalDialogProps } from '../src/dashboard/web/modal-dialog.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ModalDialog 是十几处手写「ref + open→showModal/close effect + onClose + 遮罩点击」
 * 的共享封装（sessions 四个弹层 / monitoring / connectors / plugin / vc 档案 /
 * schedules 表单 / skills 三处）。react-test-renderer 没有 DOM 宿主，用 createNodeMock
 * 给 ref 一个假 dialog，钉住：开关同步、Esc 与遮罩点击怎么关、showModal 异常降级、卸载收尾。
 */

function fakeDialog(options: { open?: boolean; showModalThrows?: boolean } = {}) {
  const node = {
    open: options.open ?? false,
    showModal: vi.fn(() => {
      if (options.showModalThrows) throw new Error('InvalidStateError');
      node.open = true;
    }),
    close: vi.fn(() => { node.open = false; }),
    setAttribute: vi.fn(),
    querySelector: vi.fn(() => null),
  };
  return node;
}

function mount(props: Partial<ModalDialogProps> & { open: boolean }, node = fakeDialog()) {
  const render = (p: Partial<ModalDialogProps> & { open: boolean }) =>
    React.createElement(ModalDialog, p as ModalDialogProps, React.createElement('span', null, 'body'));
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(render(props), { createNodeMock: () => node }); });
  const host = () => renderer.root.findByType('dialog');
  return {
    node,
    host,
    update(next: Partial<ModalDialogProps> & { open: boolean }) { act(() => renderer.update(render(next))); },
    unmount() { act(() => renderer.unmount()); },
  };
}

describe('ModalDialog — open 与 showModal/close 同步', () => {
  it('open=true 时 showModal 一次；重复渲染不再调用；open=false 时 close', () => {
    const m = mount({ open: false });
    expect(m.node.showModal).not.toHaveBeenCalled();

    m.update({ open: true });
    expect(m.node.showModal).toHaveBeenCalledTimes(1);

    m.update({ open: true, className: 'x' });
    expect(m.node.showModal).toHaveBeenCalledTimes(1);

    m.update({ open: false });
    expect(m.node.close).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('dialog 已经是打开状态时不重复 showModal（避免 InvalidStateError）', () => {
    const m = mount({ open: true }, fakeDialog({ open: true }));
    expect(m.node.showModal).not.toHaveBeenCalled();
    m.unmount();
  });

  it('open=false 且 dialog 本就关闭时不调用 close', () => {
    const m = mount({ open: false });
    expect(m.node.close).not.toHaveBeenCalled();
    m.unmount();
  });

  it('showModal 成功后调用 onOpen(dialog)；失败时静默吞掉并回调 onOpenError，且不调 onOpen', () => {
    const onOpen = vi.fn();
    const ok = mount({ open: true, onOpen });
    expect(onOpen).toHaveBeenCalledWith(ok.node);
    ok.unmount();

    const onOpen2 = vi.fn();
    const onOpenError = vi.fn();
    const bad = mount({ open: true, onOpen: onOpen2, onOpenError }, fakeDialog({ showModalThrows: true }));
    expect(onOpen2).not.toHaveBeenCalled();
    expect(onOpenError).toHaveBeenCalledTimes(1);
    expect(onOpenError.mock.calls[0][1]).toBe(bad.node);
    bad.unmount();

    // 不传 onOpenError：异常同样被吞掉（与原先各处 try/catch 空 catch 一致）。
    expect(() => mount({ open: true }, fakeDialog({ showModalThrows: true })).unmount()).not.toThrow();
  });

  it('onOpen / onOpenError 取最新闭包，但不因闭包变化重跑 effect', () => {
    const first = vi.fn();
    const second = vi.fn();
    const m = mount({ open: false, onOpen: first });
    m.update({ open: false, onOpen: second });
    m.update({ open: true, onOpen: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    m.update({ open: true, onOpen: vi.fn() });
    expect(m.node.showModal).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('卸载时不调用 close（卸载时 ref 已被摘掉，DOM 移除本身会让浏览器退出 top layer）', () => {
    const m = mount({ open: true });
    m.unmount();
    expect(m.node.close).not.toHaveBeenCalled();
  });

  it('dialogRef 会拿到 dialog 元素', () => {
    const ref = React.createRef<HTMLDialogElement>();
    const m = mount({ open: false, dialogRef: ref });
    expect(ref.current).toBe(m.node);
    m.unmount();
  });
});

describe('ModalDialog — Esc、遮罩点击与 close 事件', () => {
  const click = (host: TestRenderer.ReactTestInstance, target: unknown, currentTarget: unknown) =>
    host.props.onClick({ target, currentTarget });

  it('默认：Esc 走原生（不挂 onCancel），遮罩点击调用 onClose', () => {
    const onClose = vi.fn();
    const m = mount({ open: true, onClose });
    expect(m.host().props.onCancel).toBeUndefined();

    const self = {};
    click(m.host(), self, self);
    expect(onClose).toHaveBeenCalledTimes(1);

    click(m.host(), {}, self); // 点在内容上，不关
    expect(onClose).toHaveBeenCalledTimes(1);

    m.host().props.onClose();
    expect(onClose).toHaveBeenCalledTimes(2);
    m.unmount();
  });

  it('onRequestClose：Esc 被 preventDefault 后改调它；遮罩点击也走它而不是 onClose', () => {
    const onClose = vi.fn();
    const onRequestClose = vi.fn();
    const m = mount({ open: true, onClose, onRequestClose });

    const preventDefault = vi.fn();
    m.host().props.onCancel({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    const self = {};
    click(m.host(), self, self);
    expect(onRequestClose).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    m.unmount();
  });

  it('只给 onRequestClose（busy 拦截场景）：Esc 照样被拦截，是否关闭由回调决定', () => {
    let busy = true;
    const cancel = vi.fn();
    const m = mount({ open: true, onRequestClose: () => { if (!busy) cancel(); } });
    const preventDefault = vi.fn();

    m.host().props.onCancel({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();

    busy = false;
    m.host().props.onCancel({ preventDefault });
    expect(cancel).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('backdropClose=false：不挂遮罩点击处理（表单类弹窗防误触）', () => {
    const m = mount({ open: true, onClose: vi.fn(), backdropClose: false });
    expect(m.host().props.onClick).toBeUndefined();
    m.unmount();
  });

  it('既无 onClose 也无 onRequestClose 时不挂任何关闭处理', () => {
    const m = mount({ open: true });
    expect(m.host().props.onClick).toBeUndefined();
    expect(m.host().props.onCancel).toBeUndefined();
    expect(m.host().props.onClose).toBeUndefined();
    m.unmount();
  });

  it('其余属性（id / className / data-*）原样落到 <dialog> 上，children 照常渲染', () => {
    const m = mount({ open: false, id: 'history-modal', className: 'history-modal', 'data-x': '1' } as any);
    expect(m.host().props.id).toBe('history-modal');
    expect(m.host().props.className).toBe('history-modal');
    expect(m.host().props['data-x']).toBe('1');
    expect(m.host().findByType('span').children).toEqual(['body']);
    m.unmount();
  });
});
