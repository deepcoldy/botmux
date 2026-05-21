import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

export interface DropdownOption {
  value: string;
  label: ReactNode;
  /** Optional short label shown in the trigger when this option is selected. */
  triggerLabel?: ReactNode;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  placeholder?: ReactNode;
  className?: string;
  panelClassName?: string;
  /** Minimum trigger width (Tailwind class, e.g. "min-w-32"). */
  minWidth?: string;
}

export function Dropdown({
  value,
  onChange,
  options,
  placeholder,
  className,
  panelClassName,
  minWidth = 'min-w-32',
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const triggerContent = selected ? (selected.triggerLabel ?? selected.label) : placeholder;

  return (
    <div ref={wrapRef} className={cn('relative', minWidth, className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'h-9 w-full pl-3 pr-8 text-sm rounded-md border border-slate-300 bg-white text-slate-700',
          'inline-flex items-center justify-between text-left',
          'hover:border-slate-400 hover:bg-slate-50 transition-colors',
          'focus-visible:outline-none focus-visible:border-slate-500 focus-visible:ring-2 focus-visible:ring-slate-200',
          open && 'border-slate-500 ring-2 ring-slate-200',
        )}
      >
        <span className={cn('truncate', !selected && 'text-slate-400')}>{triggerContent}</span>
        <svg
          className={cn(
            'absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 transition-transform',
            open && 'rotate-180',
          )}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div
          className={cn(
            'absolute z-30 top-full mt-1 left-0 w-full min-w-max',
            'bg-white border border-slate-200 rounded-md shadow-lg overflow-hidden',
            'py-1 max-h-64 overflow-y-auto scrollbar-thin',
            panelClassName,
          )}
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2',
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100',
                )}
              >
                <span>{opt.label}</span>
                {active && (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                    <path
                      fillRule="evenodd"
                      d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.59l7.3-7.3a1 1 0 011.4 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
