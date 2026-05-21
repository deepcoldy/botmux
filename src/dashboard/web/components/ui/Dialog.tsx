import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  maxWidth?: string;
}

export function Dialog({ open, onClose, children, className, maxWidth = 'max-w-2xl' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    const handleClose = () => onClose();
    el.addEventListener('cancel', handleCancel);
    el.addEventListener('close', handleClose);
    return () => {
      el.removeEventListener('cancel', handleCancel);
      el.removeEventListener('close', handleClose);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={cn(
        'rounded-xl shadow-2xl border border-slate-200 p-0 backdrop:bg-slate-900/40 backdrop:backdrop-blur-sm w-full',
        maxWidth,
        className,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl">{children}</div>
    </dialog>
  );
}

export function DialogHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-6 py-4 border-b border-slate-100">
      <h3 className="text-base font-semibold text-slate-900">{children}</h3>
    </div>
  );
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-6 py-4 space-y-3 text-sm text-slate-700', className)}>{children}</div>;
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="px-6 py-3 border-t border-slate-100 flex items-center gap-2 justify-end bg-slate-50/50 rounded-b-xl">
      {children}
    </div>
  );
}
