import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

type Variant = 'default' | 'primary' | 'destructive' | 'outline' | 'ghost';
type Size = 'sm' | 'md' | 'icon';

const VARIANT: Record<Variant, string> = {
  default:
    'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 active:bg-slate-100 shadow-xs',
  primary:
    'bg-slate-900 text-white border border-slate-900 hover:bg-slate-800 active:bg-slate-700 shadow-xs',
  destructive:
    'bg-red-600 text-white border border-red-600 hover:bg-red-700 active:bg-red-800 shadow-xs',
  outline:
    'bg-transparent text-slate-700 border border-slate-300 hover:bg-slate-100 active:bg-slate-200',
  ghost:
    'bg-transparent text-slate-700 border border-transparent hover:bg-slate-100 active:bg-slate-200',
};

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs rounded-md',
  md: 'h-9 px-3.5 text-sm rounded-md',
  icon: 'h-8 w-8 rounded-md text-sm',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { className, variant = 'default', size = 'md', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  );
});
