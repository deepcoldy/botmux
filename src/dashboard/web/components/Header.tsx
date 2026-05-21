import { useEffect, useState } from 'react';
import { cn } from '../lib/utils.js';
import { store, useStoreVersion } from '../store.js';
import { Logo } from './Logo.js';
import { useLang } from '../i18n.js';

export function Header({ active }: { active: string }) {
  useStoreVersion();
  const { t, lang, setLang } = useLang();
  const online = store.online;
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(i);
  }, []);

  const NAV: Array<{ hash: string; label: string }> = [
    { hash: '#/', label: t.nav.sessions },
    { hash: '#/schedules', label: t.nav.schedules },
    { hash: '#/groups', label: t.nav.groups },
    { hash: '#/bot-defaults', label: t.nav.botDefaults },
  ];

  return (
    <header className="sticky top-0 z-20 backdrop-blur bg-white/90 border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center gap-6">
        <a href="#/" className="flex items-center gap-2.5 text-slate-900 hover:opacity-80">
          <span className="grid place-items-center h-8 w-8 rounded-lg bg-black text-white">
            <Logo size={20} />
          </span>
          <strong className="text-[15px] tracking-tight">botmux</strong>
          <span className="text-xs text-slate-400 font-normal">dashboard</span>
        </a>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => {
            const isActive =
              (n.hash === '#/' && (active === '#/' || active === '')) ||
              (n.hash !== '#/' && active.startsWith(n.hash));
            return (
              <a
                key={n.hash}
                href={n.hash}
                className={cn(
                  'h-8 px-3 rounded-md text-sm flex items-center transition-colors',
                  isActive
                    ? 'bg-black text-white font-medium'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setLang('zh')}
              className={cn(
                'h-6 px-2 rounded transition-colors',
                lang === 'zh'
                  ? 'bg-slate-900 text-white font-medium'
                  : 'text-slate-500 hover:bg-slate-100',
              )}
              aria-pressed={lang === 'zh'}
            >
              中
            </button>
            <button
              type="button"
              onClick={() => setLang('en')}
              className={cn(
                'h-6 px-2 rounded transition-colors',
                lang === 'en'
                  ? 'bg-slate-900 text-white font-medium'
                  : 'text-slate-500 hover:bg-slate-100',
              )}
              aria-pressed={lang === 'en'}
            >
              EN
            </button>
          </div>
          <span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-1 rounded-md font-medium',
              online
                ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200'
                : 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200',
            )}
            title={online ? 'SSE connected' : 'SSE disconnected'}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                online ? 'bg-emerald-500 animate-pulse' : 'bg-red-500',
              )}
            />
            {online ? t.status.live : t.status.offline}
          </span>
        </div>
      </div>
    </header>
  );
}
