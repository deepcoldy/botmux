import { useEffect, useReducer, useRef, useState } from 'react';

// ── ConfirmModal 系统 ─────────────────────────────────────────────────────────
// 基于原生 <dialog>：showModal() 提供顶层渲染、Esc 取消与焦点圈禁（Tab 循环
// 在 modal 内）。多个 confirm 并发时排队，依次展示。
// 用法：
//   const ok = await confirm({ title: '删除会话', message: '该操作不可撤销', danger: true });
//   const ok = await confirm({ title: '解散群', message: '...', requireText: '解散' });

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 危险操作：确认按钮用红色 */
  danger?: boolean;
  /** 默认「确认」 */
  confirmLabel?: string;
  /** 默认「取消」 */
  cancelLabel?: string;
  /** 强确认：输入文本与此值完全一致后确认按钮才可点击 */
  requireText?: string;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

let queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    queue = [...queue, { options, resolve }];
    emit();
  });
}

function settle(value: boolean): void {
  const [current, ...rest] = queue;
  if (!current) return;
  queue = rest;
  emit();
  current.resolve(value);
}

export function ConfirmModalRoot() {
  const [, force] = useReducer((c: number) => c + 1, 0);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = useState('');

  const current = queue[0];
  const options = current?.options;
  const requireText = options?.requireText;
  const canConfirm = requireText ? typed === requireText : true;

  useEffect(() => {
    const listener = () => force();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // 队首变化时打开/关闭原生 dialog。dialog 保持挂载，靠 children 切换内容，
  // 这样排队中的下一个 confirm 可以无缝接上。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (current && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        /* already opening/unsupported */
      }
    } else if (!current && dialog.open) {
      dialog.close();
    }
  }, [current]);

  // 每次队首变化：重置强确认输入并把焦点落到输入框/确认按钮
  useEffect(() => {
    if (!current) return;
    setTyped('');
    window.requestAnimationFrame(() => {
      if (requireText) inputRef.current?.focus();
      else confirmRef.current?.focus();
    });
  }, [current, requireText]);

  // 卸载兜底：避免残留打开的 modal 卡住页面交互
  useEffect(
    () => () => {
      const dialog = dialogRef.current;
      if (dialog?.open) dialog.close();
    },
    [],
  );

  return (
    <dialog
      ref={dialogRef}
      className="confirm-modal-dialog"
      aria-labelledby={options ? 'confirm-modal-title' : undefined}
      onCancel={event => {
        // Esc = 取消（阻止默认 close，统一走 settle 关队列）
        event.preventDefault();
        settle(false);
      }}
      onClick={event => {
        // 点击 mask（::backdrop 的点击 retarget 到 dialog 自身）= 取消
        if (event.target === event.currentTarget) settle(false);
      }}
    >
      {options ? (
        <div className="confirm-modal-card">
          <h3 id="confirm-modal-title" className="confirm-modal-title">
            {options.title}
          </h3>
          <p className="confirm-modal-message">{options.message}</p>
          {requireText ? (
            <div className="confirm-modal-input-row">
              <input
                ref={inputRef}
                type="text"
                className="confirm-modal-input"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onInput={event => setTyped((event.target as HTMLInputElement).value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && canConfirm) settle(true);
                }}
              />
            </div>
          ) : null}
          <div className="confirm-modal-footer">
            <button type="button" className="btn-cancel" onClick={() => settle(false)}>
              {options.cancelLabel ?? '取消'}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={options.danger ? 'btn-danger' : 'btn-primary'}
              disabled={!canConfirm}
              onClick={() => settle(true)}
            >
              {options.confirmLabel ?? '确认'}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
