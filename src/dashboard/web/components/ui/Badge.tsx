import { cn } from '../../lib/utils.js';

const CLI_COLORS: Record<string, string> = {
  'claude-code': 'bg-indigo-100 text-indigo-800 ring-indigo-200',
  codex: 'bg-orange-100 text-orange-800 ring-orange-200',
  cursor: 'bg-violet-100 text-violet-800 ring-violet-200',
  gemini: 'bg-pink-100 text-pink-800 ring-pink-200',
  opencode: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  aiden: 'bg-amber-100 text-amber-800 ring-amber-200',
  coco: 'bg-green-100 text-green-800 ring-green-200',
  unknown: 'bg-slate-100 text-slate-600 ring-slate-200',
};

const STATUS_COLORS: Record<string, string> = {
  working: 'text-blue-600 font-semibold',
  idle: 'text-slate-500',
  closed: 'text-slate-400 line-through',
  analyzing: 'text-amber-600',
  starting: 'text-purple-600',
};

export function CliBadge({ cli }: { cli?: string }) {
  const id = cli ?? 'unknown';
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ring-inset',
        CLI_COLORS[id] ?? CLI_COLORS.unknown,
      )}
    >
      {id}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn('text-xs', STATUS_COLORS[status] ?? 'text-slate-600')}>{status}</span>
  );
}
