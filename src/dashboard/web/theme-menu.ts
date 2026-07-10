// Custom theme dropdown — a native <select> can't render SVG per option, so this
// is a small listbox that shows the real Lucide line-icons used for each skin.
// Icons: Lucide v1.17.0 (ISC).
import { ui, t } from './ui.js';

type Opt = { value: string; labelKey: string; icon: string };
type Group = { labelKey: string; options: Opt[] };
export const CLOSE_THEME_MENU_EVENT = 'botmux:close-theme-menu';

// inner shapes only; wrapped by iconSvg() with a shared 24×24 stroke frame
const ICON: Record<string, string> = {
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2a10 10 0 0 0 0 20h1.7a2.3 2.3 0 0 0 1.6-4c-.5-.5-.2-1.3.5-1.3H17a5 5 0 0 0 5-5 9.7 9.7 0 0 0-10-9.7z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  cpu: '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
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
    { value: 'fallout', labelKey: 'skin.fallout', icon: 'zap' },
  ] },
];

const ALL = GROUPS.flatMap(g => g.options);
let open = false;
let closeTimer: number | null = null;
let hideTimer: number | null = null;
const CLOSE_DELAY_MS = 70;
const HIDE_DELAY_MS = 120;

function iconSvg(name: string): string {
  return `<svg class="tm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function initThemeMenu(): void {
  const root = document.getElementById('theme-menu');
  const btn = document.getElementById('theme-menu-btn');
  const pop = document.getElementById('theme-menu-pop');
  if (!root || !btn || !pop) return;
  if (root.dataset.themeMenuInit === '1') return;
  root.dataset.themeMenuInit = '1';

  pop.innerHTML = GROUPS.map(g =>
    `<div class="tm-group" data-label-key="${g.labelKey}"></div>` +
    g.options.map(o =>
      `<button type="button" class="tm-item" role="option" data-value="${o.value}">` +
      `<span class="tm-ic">${iconSvg(o.icon)}</span>` +
      `<span class="tm-label" data-label-key="${o.labelKey}"></span></button>`,
    ).join(''),
  ).join('');

  const positionPop = () => {
    if (!open) return;
    const rect = btn.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(Math.max(pop.offsetWidth || 216, 216), Math.max(0, window.innerWidth - margin * 2));
    const minLeft = margin + width / 2;
    const maxLeft = window.innerWidth - margin - width / 2;
    const center = rect.left + rect.width / 2;
    const left = Math.min(Math.max(center, minLeft), Math.max(minLeft, maxLeft));
    const availableHeight = Math.max(180, window.innerHeight - rect.bottom - 20);
    pop.style.setProperty('--theme-menu-pop-left', `${Math.round(left)}px`);
    pop.style.setProperty('--theme-menu-pop-top', `${Math.round(rect.bottom + 8)}px`);
    pop.style.setProperty('--theme-menu-pop-max-height', `${Math.round(availableHeight)}px`);
  };

  const setOpen = (next: boolean) => {
    if (closeTimer != null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (hideTimer != null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    open = next;
    btn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('theme-menu-open', open);
    if (open) {
      pop.hidden = false;
      positionPop();
      window.requestAnimationFrame(() => root.classList.add('open'));
    } else {
      root.classList.remove('open');
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        if (!open) pop.hidden = true;
      }, HIDE_DELAY_MS);
    }
  };

  const openMenu = () => setOpen(true);
  const scheduleClose = () => {
    if (closeTimer != null) return;
    closeTimer = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  root.addEventListener('pointerenter', openMenu);
  root.addEventListener('pointerleave', scheduleClose);
  pop.addEventListener('pointerenter', openMenu);
  pop.addEventListener('pointerleave', scheduleClose);
  btn.addEventListener('focus', openMenu);
  root.addEventListener('focusout', e => {
    const next = e.relatedTarget;
    if (!(next instanceof Node) || !root.contains(next)) scheduleClose();
  });
  pop.addEventListener('click', e => {
    const item = (e.target as HTMLElement).closest('.tm-item') as HTMLElement | null;
    if (!item) return;
    ui.setTheme(item.dataset.value ?? 'system');
    setOpen(false);
  });
  document.addEventListener('click', e => {
    if (open && !root.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener('pointermove', e => {
    if (!open) return;
    const target = e.target;
    if (target instanceof Node && root.contains(target)) return;
    scheduleClose();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) setOpen(false);
  });
  window.addEventListener('resize', positionPop);
  window.addEventListener('scroll', positionPop, true);
  window.addEventListener(CLOSE_THEME_MENU_EVENT, () => {
    if (open) setOpen(false);
  });

  paintThemeMenu();
}

export function paintThemeMenu(): void {
  const btn = document.getElementById('theme-menu-btn');
  if (!btn) return;
  const active = ALL.find(o => o.value === ui.theme) ?? ALL[0];
  btn.innerHTML =
    `<span class="tm-ic">${iconSvg('palette')}</span>` +
    `<span class="tm-current">${esc(t(active.labelKey))}</span>` +
    `<span class="tm-chev">${iconSvg('chevron')}</span>`;
  document.querySelectorAll<HTMLElement>('#theme-menu-pop [data-label-key]').forEach(el => {
    el.textContent = t(el.dataset.labelKey ?? '');
  });
  document.querySelectorAll<HTMLElement>('#theme-menu-pop .tm-item').forEach(el => {
    el.classList.toggle('active', (el as HTMLElement).dataset.value === ui.theme);
  });
}
