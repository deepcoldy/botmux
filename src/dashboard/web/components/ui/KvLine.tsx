import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from './Button.js';
import { useT } from '../../i18n.js';

interface Props {
  label: string;
  copy?: string;
  mono?: boolean;
  labelWidth?: string;
  children: ReactNode;
}

export function KvLine({ label, copy, mono, labelWidth = 'w-20', children }: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className={cn('text-slate-500 shrink-0', labelWidth)}>{label}</span>
      <code
        className={cn(
          'px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 break-all',
          mono && 'font-mono',
        )}
      >
        {children}
      </code>
      {copy && (
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(copy);
            setCopied(true);
            setTimeout(() => setCopied(false), 800);
          }}
        >
          {copied ? t.common.copied : t.common.copy}
        </Button>
      )}
    </div>
  );
}
