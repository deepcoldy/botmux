import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { Checkbox } from './Input.js';

export interface PickerItem {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
}

interface Props {
  items: PickerItem[];
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  empty?: ReactNode;
  className?: string;
  rowClassName?: string;
}

export function CheckboxPicker({
  items, selected, onToggle, empty, className, rowClassName,
}: Props) {
  if (items.length === 0 && empty) return <>{empty}</>;
  return (
    <div className={cn('space-y-0.5 max-h-64 overflow-auto scrollbar-thin', className)}>
      {items.map((it) => (
        <label
          key={it.id}
          className={cn(
            'flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer text-sm',
            rowClassName,
          )}
        >
          <Checkbox
            checked={selected.has(it.id)}
            onChange={(e) => onToggle(it.id, e.target.checked)}
          />
          <span>{it.label}</span>
          {it.hint}
        </label>
      ))}
    </div>
  );
}
