import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'h-9 px-3 text-sm rounded-md border border-slate-300 bg-white text-slate-900',
          'placeholder:text-slate-400',
          'focus-visible:outline-none focus-visible:border-slate-500 focus-visible:ring-2 focus-visible:ring-slate-200',
          'disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Checkbox({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'h-4 w-4 rounded border-slate-300 text-slate-900',
          'focus:ring-slate-400 focus:ring-offset-1 cursor-pointer',
          className,
        )}
        {...rest}
      />
    );
  },
);
