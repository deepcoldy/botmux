import { Button } from './Button.js';
import { cn } from '../../lib/utils.js';

interface Props {
  onClick: () => void;
  loading?: boolean;
  title?: string;
  className?: string;
}

export function RefreshButton({ onClick, loading, title, className }: Props) {
  return (
    <Button
      size="icon"
      variant="outline"
      onClick={onClick}
      disabled={loading}
      title={title}
      aria-label={title}
      className={className}
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(loading && 'animate-spin')}
        aria-hidden
      >
        <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    </Button>
  );
}
