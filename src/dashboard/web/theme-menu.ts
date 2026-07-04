// Custom theme dropdown — a native <select> can't render SVG per option, so this
// is a small listbox that shows the real Lucide line-icons kaboo uses for each
// skin (cpu / sparkles / zap / terminal / key-round / network / swords …).
// Icons: Lucide v1.17.0 (ISC).
import { ui, t } from './ui.js';

type Opt = { value: string; labelKey: string; icon: string };
type Group = { labelKey: string; options: Opt[] };

// inner shapes only; wrapped by iconSvg() with a shared 24×24 stroke frame
const ICON: Record<string, string> = {
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  cpu: '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  sparkles: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  terminal: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>',
  keyRound: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/>',
  flame: '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
  ball: '<path d="M11 7a16 16 20 0 1 10.98 4.362"/><path d="M12 12a13 13 0 0 1-8.66 5"/><path d="M16.83 13.634a16 16 0 0 1-9.267 7.328"/><path d="M20.66 17A13 13 0 0 0 12 12a13 13 0 0 1 0-10"/><path d="M8.17 15.366a16 16 0 0 1-1.713-11.69"/><circle cx="12" cy="12" r="10"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

const GROUPS: Group[] = [
  { labelKey: 'theme.base', options: [
    { value: 'system', labelKey: 'status.system', icon: 'monitor' },
    { value: 'light', labelKey: 'status.light', icon: 'sun' },
    { value: 'dark', labelKey: 'status.dark', icon: 'moon' },
  ] },
  { labelKey: 'theme.skins', options: [
    { value: 'cyber', labelKey: 'skin.cyber', icon: 'cpu' },
    { value: 'genshin', labelKey: 'skin.genshin', icon: 'sparkles' },
    { value: 'fallout', labelKey: 'skin.fallout', icon: 'zap' },
    { value: 'prts', labelKey: 'skin.prts', icon: 'terminal' },
    { value: 'bluearchive', labelKey: 'skin.bluearchive', icon: 'keyRound' },
    { value: 'zzz', labelKey: 'skin.zzz', icon: 'network' },
    { value: 'dragonball', labelKey: 'skin.dragonball', icon: 'flame' },
    { value: 'ikun', labelKey: 'skin.ikun', icon: 'ball' },
  ] },
];

const ALL = GROUPS.flatMap(g => g.options);
let open = false;

function iconSvg(name: string): string {
  return `<svg class="tm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function initThemeMenu(): void {
  const root = document.getElementById('theme-menu');
  const btn = document.getElementById('theme-menu-btn');
  const pop = document.getElementById('theme-menu-pop');
  if (!root || !btn || !pop) return;

  pop.innerHTML = GROUPS.map(g =>
    `<div class="tm-group" data-label-key="${g.labelKey}"></div>` +
    g.options.map(o =>
      `<button type="button" class="tm-item" role="option" data-value="${o.value}">` +
      `<span class="tm-ic">${iconSvg(o.icon)}</span>` +
      `<span class="tm-label" data-label-key="${o.labelKey}"></span></button>`,
    ).join(''),
  ).join('');

  const setOpen = (next: boolean) => {
    open = next;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    root.classList.toggle('open', open);
  };

  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(!open); });
  pop.addEventListener('click', e => {
    const item = (e.target as HTMLElement).closest('.tm-item') as HTMLElement | null;
    if (!item) return;
    ui.setTheme(item.dataset.value ?? 'system');
    setOpen(false);
  });
  document.addEventListener('click', e => {
    if (open && !root.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  paintThemeMenu();
}

export function paintThemeMenu(): void {
  const btn = document.getElementById('theme-menu-btn');
  if (!btn) return;
  const active = ALL.find(o => o.value === ui.theme) ?? ALL[0];
  btn.innerHTML =
    `<span class="tm-ic">${iconSvg(active.icon)}</span>` +
    `<span class="tm-current">${esc(t(active.labelKey))}</span>` +
    `<span class="tm-chev">${iconSvg('chevron')}</span>`;
  document.querySelectorAll<HTMLElement>('#theme-menu-pop [data-label-key]').forEach(el => {
    el.textContent = t(el.dataset.labelKey ?? '');
  });
  document.querySelectorAll<HTMLElement>('#theme-menu-pop .tm-item').forEach(el => {
    el.classList.toggle('active', (el as HTMLElement).dataset.value === ui.theme);
  });
}
