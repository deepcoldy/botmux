import { useEffect, useReducer } from 'react';

// ── Toast 系统 ────────────────────────────────────────────────────────────────
// 全局单例：模块级事件发射器 + 容器组件，不依赖 React Context。
// 用法：toast('已保存', { kind: 'success' })；
// 容器 <ToastStack /> 在 app.tsx 的 DashboardShell 里挂载一次。

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  /** 自动关闭毫秒数，默认 3000 */
  duration?: number;
  /** 可选动作按钮（如「撤销」），点击后 Toast 立即退出 */
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  duration: number;
  action?: ToastAction;
  leaving: boolean;
}

const MAX_TOASTS = 3;
const EXIT_MS = 200;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, number>();

function emit(): void {
  for (const listener of listeners) listener();
}

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
}

function beginExit(id: number): void {
  const item = items.find(i => i.id === id);
  if (!item || item.leaving) return;
  clearTimer(id);
  items = items.map(i => (i.id === id ? { ...i, leaving: true } : i));
  emit();
  window.setTimeout(() => {
    items = items.filter(i => i.id !== id);
    emit();
  }, EXIT_MS);
}

export function toast(message: string, options?: ToastOptions): void {
  // node 环境（如 vitest 无 jsdom）无 window，静默丢弃——toast 是纯 UI 反馈
  if (typeof window === 'undefined') return;
  const id = ++seq;
  const item: ToastItem = {
    id,
    message,
    kind: options?.kind ?? 'info',
    duration: options?.duration ?? 3000,
    action: options?.action,
    leaving: false,
  };
  items = [...items, item];
  // 最多同时 3 条：超出直接移除最早的（它的自动关闭计时器一并清掉）
  if (items.length > MAX_TOASTS) {
    const overflow = items.slice(0, items.length - MAX_TOASTS);
    items = items.slice(items.length - MAX_TOASTS);
    for (const old of overflow) clearTimer(old.id);
  }
  emit();
  timers.set(
    id,
    window.setTimeout(() => beginExit(id), item.duration),
  );
}

export function ToastStack() {
  const [, force] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    const listener = () => force();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div className="toast-stack" aria-live="polite">
      {items.map(item => (
        <div
          key={item.id}
          className={`toast-item toast-item-${item.kind}${item.leaving ? ' is-leaving' : ''}`}
          role="status"
        >
          <span className="toast-message">{item.message}</span>
          {item.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                item.action?.onClick();
                beginExit(item.id);
              }}
            >
              {item.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
