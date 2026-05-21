import { cn } from '../../lib/utils.js';

interface Props {
  size?: number;
  label?: string;
  className?: string;
}

export function Spinner({ size = 16, label, className }: Props) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-slate-400 text-sm', className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className="animate-spin"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  );
}
