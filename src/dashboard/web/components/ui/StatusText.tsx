import { cn } from '../../lib/utils.js';

export interface Status {
  kind: 'ok' | 'err';
  text: string;
}

export function StatusText({ status, className }: { status: Status | null; className?: string }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        'text-xs',
        status.kind === 'ok' ? 'text-emerald-700' : 'text-amber-800',
        className,
      )}
    >
      {status.text}
    </span>
  );
}
