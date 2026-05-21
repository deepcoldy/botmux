import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className={cn('w-full text-sm tabular-nums border-collapse', className)} {...rest} />
    </div>
  );
}

export function Thead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}

export function Tbody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-slate-100 hover:bg-slate-50 transition-colors',
        className,
      )}
      {...rest}
    />
  );
}

export function Th({
  className,
  sortable,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { sortable?: boolean }) {
  return (
    <th
      className={cn(
        'px-3 py-2.5 text-left font-medium text-slate-600 bg-slate-50 border-b border-slate-200 whitespace-nowrap',
        sortable && 'cursor-pointer select-none hover:bg-slate-100',
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn('px-3 py-2.5 text-slate-800 whitespace-nowrap', className)}
      {...rest}
    />
  );
}
