// Per-skin switch-in intro overlays (the 2077 skin has its own boot loader in
// cyber-fx.ts). These are short, original CSS animations that *evoke* each theme
// without copying any game's actual loading screen or characters:
//   genshin   — a rotating elemental loading spinner + glow
//   zzz       — a TV "NOW LOADING" static / channel-switch burst
//   dragonball— a golden 筋斗云 (cloud) whooshing across with speed lines
//   ikun      — a spinning basketball
// Plays once on user switch-in; skipped under prefers-reduced-motion.
import type { SkinId } from './preferences.js';

const DURATION: Partial<Record<SkinId, number>> = {
  genshin: 2000,
  zzz: 1900,
  dragonball: 1900,
  ikun: 1900,
};

// Basketball: a CSS-shaded 3D sphere (static highlight/shading) with only the
// seam lines on a spinning overlay — reads as a real ball rolling, not a flat disc.
const BALL =
  '<span class="si-bball" aria-hidden="true"><span class="si-bball-seams">' +
  '<svg viewBox="0 0 100 100"><g fill="none" stroke="#3a1d08" stroke-width="3.4" ' +
  'stroke-linecap="round"><path d="M50 4V96"/><path d="M4 50H96"/>' +
  '<path d="M50 4 Q14 50 50 96"/><path d="M50 4 Q86 50 50 96"/></g></svg></span></span>';

function inner(skin: SkinId): string {
  switch (skin) {
    case 'genshin':
      // ZZZ-style text loader, but with Genshin's palette — the "原神，启动" meme.
      return '<span class="si-gi-shine" aria-hidden="true"></span><span class="si-gi-text">原神，启动</span>';
    case 'zzz':
      return '<span class="si-static" aria-hidden="true"></span><span class="si-roll" aria-hidden="true"></span><span class="si-now">NOW&nbsp;LOADING</span>';
    case 'dragonball':
      // 悟空骑筋斗云 — user-supplied art whooshing across with speed lines.
      return '<span class="si-speed" aria-hidden="true"></span><img class="si-cloud" src="/assets/skins/dragonball-wukong.webp" alt="">';
    case 'ikun':
      return BALL;
    default:
      return '';
  }
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Play the switch-in intro for a skin (no-op for skins without one). */
export function playSkinIntro(skin: SkinId): void {
  if (typeof document === 'undefined' || reducedMotion()) return;
  const dur = DURATION[skin];
  if (!dur) return;
  document.getElementById('skin-intro')?.remove();
  const el = document.createElement('div');
  el.id = 'skin-intro';
  el.className = `skin-intro si-${skin}`;
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--si-dur', `${dur}ms`);
  el.innerHTML = inner(skin);
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), dur + 80);
}
