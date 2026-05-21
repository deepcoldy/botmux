import { useState } from 'react';
import { cn } from '../../lib/utils.js';

interface Props {
  src?: string | null;
  name?: string;
  size?: number;
  className?: string;
}

function initials(s: string): string {
  const cleaned = s.trim();
  if (!cleaned) return '?';
  // Take the first 2 char (cope with CJK by codepoint, not byte).
  return [...cleaned].slice(0, 2).join('').toUpperCase();
}

const FALLBACK_BG = ['bg-slate-700', 'bg-indigo-600', 'bg-emerald-600', 'bg-rose-600', 'bg-amber-600', 'bg-violet-600'];

function bgFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_BG[h % FALLBACK_BG.length];
}

export function BotAvatar({ src, name = '', size = 36, className }: Props) {
  const [failed, setFailed] = useState(false);

  const showImg = src && !failed;
  const dim = { width: size, height: size };

  return (
    <span
      className={cn(
        'inline-grid place-items-center rounded-full overflow-hidden ring-1 ring-slate-200 text-white font-semibold select-none',
        !showImg && bgFor(name || 'bot'),
        className,
      )}
      style={{ ...dim, fontSize: Math.round(size * 0.4) }}
    >
      {showImg ? (
        <img
          src={src!}
          alt={name}
          width={size}
          height={size}
          className="block object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
