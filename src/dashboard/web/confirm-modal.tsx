import { useEffect, useReducer, useRef, useState } from 'react';

// ── ConfirmModal 系统 ─────────────────────────────────────────────────────────
// 基于原生 <dialog>：showModal() 提供顶层渲染、Esc 取消与焦点圈禁（Tab 循环
// 在 modal 内）。多个弹窗并发时排队，依次展示。两种弹窗共用同一套队列/焦点/
// Esc/遮罩机制，队首靠 kind 区分是「确认」还是「文本输入」：
//   const ok = await confirm({ title: '删除会话', message: '该操作不可撤销', danger: true });
//   const ok = await confirm({ title: '解散群', message: '...', requireText: '解散' });
//   const dir = await promptText({ title: '调试终端', message: '工作目录：' });
//     // 确认返回输入串（空串亦合法），取消/Esc/点遮罩返回 null —— 对齐 window.prompt

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

export interface PromptOptions {
  title: string;
  /** 输入框上方的说明 / 标签 */
  message: string;
  /** 危险操作：确认按钮用红色 */
  danger?: boolean;
  /** 默认「确认」 */
  confirmLabel?: string;
  /** 默认「取消」 */
  cancelLabel?: string;
  /** 输入框占位符 */
  placeholder?: string;
  /** 输入框初始值（取消仍返回 null，与 window.prompt 一致） */
  defaultValue?: string;
}

type PendingItem =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

let queue: PendingItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    queue = [...queue, { kind: 'confirm', options, resolve }];
    emit();
  });
}

/**
 * 带自由文本输入的弹窗（替代阻塞式 window.prompt）。
 * 确认时 resolve 输入串（空串合法）；取消 / Esc / 点遮罩时 resolve null。
 */
export function promptText(options: PromptOptions): Promise<string | null> {
  return new Promise<string | null>(resolve => {
    queue = [...queue, { kind: 'prompt', options, resolve }];
    emit();
  });
}

// accepted=用户点了确认/回车；text=当前输入框内容。confirm 项忽略 text 只回布尔，
// prompt 项在确认时回 text、否则回 null。
function settle(accepted: boolean, text: string): void {
  const [current, ...rest] = queue;
  if (!current) return;
  queue = rest;
  emit();
  if (current.kind === 'prompt') current.resolve(accepted ? text : null);
  else current.resolve(accepted);
}

export function ConfirmModalRoot() {
  const [, force] = useReducer((c: number) => c + 1, 0);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = useState('');

  const current = queue[0];
  const options = current?.options;
  const isPrompt = current?.kind === 'prompt';
  // 强确认门只属于 confirm 项；prompt 无门（允许空串提交，对齐 window.prompt）
  const requireText = current?.kind === 'confirm' ? current.options.requireText : undefined;
  const placeholder = current?.kind === 'prompt' ? current.options.placeholder : undefined;
  const showInput = isPrompt || !!requireText;
  const canConfirm = requireText ? typed === requireText : true;

  useEffect(() => {
    const listener = () => force();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // 队首变化时打开/关闭原生 dialog。dialog 保持挂载，靠 children 切换内容，
  // 这样排队中的下一个弹窗可以无缝接上。
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

  // 每次队首变化：把输入框重置为初始值（prompt 用 defaultValue，其余清空），
  // 并把焦点落到输入框/确认按钮
  useEffect(() => {
    if (!current) return;
    setTyped(current.kind === 'prompt' ? current.options.defaultValue ?? '' : '');
    window.requestAnimationFrame(() => {
      if (showInput) inputRef.current?.focus();
      else confirmRef.current?.focus();
    });
  }, [current, showInput]);

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
        settle(false, '');
      }}
      onClick={event => {
        // 点击 mask（::backdrop 的点击 retarget 到 dialog 自身）= 取消
        if (event.target === event.currentTarget) settle(false, '');
      }}
    >
      {options ? (
        <div className="confirm-modal-card">
          <h3 id="confirm-modal-title" className="confirm-modal-title">
            {options.title}
          </h3>
          <p id="confirm-modal-message" className="confirm-modal-message">{options.message}</p>
          {showInput ? (
            <div className="confirm-modal-input-row">
              <input
                ref={inputRef}
                type="text"
                className="confirm-modal-input"
                value={typed}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                aria-labelledby="confirm-modal-message"
                onInput={event => setTyped((event.target as HTMLInputElement).value)}
                onKeyDown={event => {
                  // isComposing：IME 组词（中/日/韩）期间的 Enter 是「上屏候选词」，
                  // 不是提交，放行给输入法处理，避免强确认文本或目录被截断误提交。
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing && canConfirm) settle(true, typed);
                }}
              />
            </div>
          ) : null}
          <div className="confirm-modal-footer">
            <button type="button" className="btn-cancel" onClick={() => settle(false, '')}>
              {options.cancelLabel ?? '取消'}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={options.danger ? 'btn-danger' : 'btn-primary'}
              disabled={!canConfirm}
              onClick={() => settle(true, typed)}
            >
              {options.confirmLabel ?? '确认'}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
