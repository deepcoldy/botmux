import type React from 'react';
import { useEffect, useRef, type DialogHTMLAttributes, type RefObject } from 'react';

/**
 * 原生 `<dialog>` 模态框的共享封装。
 *
 * 此前十几处各自手写同一套：`useRef` + 一个 `open ? showModal() : close()` 的 effect
 * + `onClose` + 遮罩点击。原生 `showModal()` 自带顶层渲染、焦点圈禁与 Esc 取消，
 * 这里只收敛「开关同步」与「怎么关」两件事，各处不一致的行为用 props 参数化而不是统一：
 *
 * - `open`：受控。true → `showModal()`（已打开则跳过），false → `close()`。
 * - `onClose`：浏览器 `close` 事件（Esc、`<form method="dialog">`、`.close()`）。
 * - `onRequestClose`：「状态驱动」的关闭。提供时 Esc 会被 `preventDefault`（不让浏览器
 *   自己关），改由它通知父级去改 `open`；遮罩点击也走它。典型用法是父级要拦截关闭
 *   （busy 时忽略）或需要先清理状态再关。不提供时 Esc 走原生关闭、遮罩点击调 `onClose`。
 * - `backdropClose`（默认 true）：点遮罩（`::backdrop` 的点击会 retarget 到 dialog 自身）
 *   是否关闭。表单类弹窗误触代价高，传 false 关掉。
 * - `onOpen` / `onOpenError`：`showModal()` 成功后（聚焦、滚动复位）与抛错时（降级为
 *   `open` 属性、或回调父级）的钩子。默认静默吞掉异常，与原先各处一致。
 * - `dialogRef`：调用方还需要拿 dialog 元素时传入，否则用内部 ref。
 *
 * 不做「卸载时 close()」：React 在卸载时先摘掉 ref 再跑 effect 清理，清理里读 `ref.current`
 * 恒为 null；而 `<dialog>` 一旦从 DOM 移除，浏览器会自动把它移出 top layer，无需手动关。
 */
export interface ModalDialogProps extends Omit<DialogHTMLAttributes<HTMLDialogElement>, 'open' | 'onClose' | 'onCancel' | 'onClick'> {
  open: boolean;
  onClose?(): void;
  onRequestClose?(): void;
  backdropClose?: boolean;
  onOpen?(dialog: HTMLDialogElement): void;
  onOpenError?(error: unknown, dialog: HTMLDialogElement): void;
  dialogRef?: RefObject<HTMLDialogElement | null>;
}

export function ModalDialog(props: ModalDialogProps): React.JSX.Element {
  const {
    open, onClose, onRequestClose, backdropClose = true, onOpen, onOpenError,
    dialogRef, children, ...dialogProps
  } = props;
  const innerRef = useRef<HTMLDialogElement | null>(null);
  const ref = dialogRef ?? innerRef;
  // 回调放进 ref：effect 只依赖 `open`，不会因为父级每次渲染新建的闭包而重跑。
  const hooksRef = useRef({ onOpen, onOpenError });
  hooksRef.current = { onOpen, onOpenError };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (dialog.open) return;
      try {
        dialog.showModal();
      } catch (error) {
        hooksRef.current.onOpenError?.(error, dialog);
        return;
      }
      hooksRef.current.onOpen?.(dialog);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, ref]);

  const dismiss = onRequestClose ?? onClose;
  return (
    <dialog
      {...dialogProps}
      ref={ref}
      onClose={onClose ? () => onClose() : undefined}
      onCancel={onRequestClose
        ? event => {
          event.preventDefault();
          onRequestClose();
        }
        : undefined}
      onClick={backdropClose && dismiss
        ? event => { if (event.target === event.currentTarget) dismiss(); }
        : undefined}
    >
      {children}
    </dialog>
  );
}
