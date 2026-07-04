// Decorative motion layer for the "2077" cyberpunk skin, distilled from the kaboo
// webui (frontend/src/components/shared/CyberpunkEffects.tsx + cyberpunk.css):
//
//   • ambient (behind content, #cyber-fx)  — neon grid, scanlines, vignette,
//     Matrix data-rain, CRT flicker, roll line
//   • HUD frame (above content, #cyber-hud) — corner brackets + NETWATCH tag
//   • glitch overlay (#cyber-glitch)        — driven by random cp-fx-* classes
//     the controller toggles on <body> (tear/invert/blackout over the overlay,
//     shake/rgb/slice on <main>)
//   • boot loader (#cyber-boot)             — the "KIROSHI NETLINK" decrypt
//     terminal that plays once when you switch INTO the skin
//
// All motion is gated on prefers-reduced-motion. Everything is torn down when the
// skin is switched off, so nothing leaks into the normal skin.

const RAIN_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃ0123456789ﾊﾋﾌﾍﾎ$#%&@*+=<>/\\';
const RAIN_COLORS = ['186 100% 60%', '56 97% 60%', '330 100% 64%', '150 80% 58%'];

// Page-glitch flavors fired at random intervals. Each adds `cp-fx-<key>` to <body>
// for `dur` ms; the CSS drives the look.
const GLITCH = [
  { key: 'shake', dur: 280 },
  { key: 'rgb', dur: 340 },
  { key: 'tear', dur: 400 },
  { key: 'invert', dur: 220 },
  { key: 'slice', dur: 320 },
  { key: 'blackout', dur: 260 },
] as const;

const BOOT_PHRASES = [
  'ESTABLISHING NETLINK',
  'BYPASSING ICE',
  'DECRYPTING DATAFLOW',
  'SYNCING BOTMUX TELEMETRY',
  'ACCESS GRANTED',
];
const BOOT_SCRAMBLE = '0123456789ABCDEF#<>*/=+ｱｲｳｴｵｶｷｸﾅﾆﾇﾈﾉﾊﾋﾌ';
const BOOT_MS = 3200;

let glitchTimers: number[] = [];
let bootInterval = 0;
let bootTimer = 0;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function randGlyphs(count: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < count; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function buildRain(host: HTMLElement): void {
  const rain = document.createElement('div');
  rain.className = 'cyber-rain';
  const cols = Math.max(10, Math.min(26, Math.round(window.innerWidth / 70)));
  for (let i = 0; i < cols; i++) {
    const col = document.createElement('span');
    col.className = 'cyber-rain-col';
    col.textContent = randGlyphs(28 + Math.floor(Math.random() * 22), RAIN_GLYPHS);
    const color = RAIN_COLORS[Math.floor(Math.random() * RAIN_COLORS.length)];
    col.style.cssText =
      `left:${((i + 0.5) / cols) * 100}%;` +
      `--rc:${color};` +
      `--sz:${10 + Math.floor(Math.random() * 9)}px;` +
      `--op:${(0.25 + Math.random() * 0.45).toFixed(2)};` +
      `--dur:${(6 + Math.random() * 9).toFixed(1)}s;` +
      `--delay:${(-Math.random() * 12).toFixed(1)}s;`;
    rain.appendChild(col);
  }
  host.appendChild(rain);
}

// ── random glitch controller ─────────────────────────────────────────────────
function startGlitches(): void {
  if (reducedMotion()) return;
  const body = document.body;
  const fire = () => {
    const v = GLITCH[Math.floor(Math.random() * GLITCH.length)];
    const cls = `cp-fx-${v.key}`;
    body.classList.add(cls);
    glitchTimers.push(window.setTimeout(() => body.classList.remove(cls), v.dur));
    glitchTimers.push(window.setTimeout(fire, 2400 + Math.random() * 4200));
  };
  glitchTimers.push(window.setTimeout(fire, 1800 + Math.random() * 2600));
}

function stopGlitches(): void {
  glitchTimers.forEach(id => window.clearTimeout(id));
  glitchTimers = [];
  for (const v of GLITCH) document.body.classList.remove(`cp-fx-${v.key}`);
}

// ── boot decrypt loader (plays on switch-in) ─────────────────────────────────
function playBoot(): void {
  if (reducedMotion() || document.getElementById('cyber-boot')) return;
  const boot = document.createElement('div');
  boot.id = 'cyber-boot';
  boot.className = 'cyber-boot';
  boot.setAttribute('aria-hidden', 'true');
  boot.innerHTML =
    '<div class="cyber-boot-grid"></div>' +
    '<div class="cyber-loader"><div class="cyber-loader-frame">' +
    '<div class="cyber-loader-head"><span>KIROSHI NETLINK</span>' +
    '<span class="cyber-loader-jp">侵入中</span></div>' +
    '<div class="cyber-loader-line"><span class="cyber-loader-prompt">&gt;</span>' +
    '<span class="cyber-loader-text"></span><span class="cyber-loader-cursor">_</span></div>' +
    '<div class="cyber-loader-stream"></div></div></div>';
  document.body.appendChild(boot);

  const textEl = boot.querySelector<HTMLElement>('.cyber-loader-text');
  const streamEl = boot.querySelector<HTMLElement>('.cyber-loader-stream');
  let phrase = 0;
  let locked = 0;
  let hold = 0;
  bootInterval = window.setInterval(() => {
    const target = BOOT_PHRASES[phrase];
    if (textEl) {
      if (locked < target.length) {
        locked += 1;
        textEl.textContent = target.slice(0, locked) + randGlyphs(target.length - locked, BOOT_SCRAMBLE);
        textEl.classList.remove('done');
      } else if (hold < 16) {
        hold += 1;
        textEl.textContent = target;
        textEl.classList.add('done');
      } else {
        phrase = (phrase + 1) % BOOT_PHRASES.length;
        locked = 0;
        hold = 0;
      }
    }
    if (streamEl) streamEl.textContent = randGlyphs(26, BOOT_SCRAMBLE);
  }, 50);

  bootTimer = window.setTimeout(() => {
    window.clearInterval(bootInterval);
    bootInterval = 0;
    boot.remove();
  }, BOOT_MS);
}

function stopBoot(): void {
  if (bootInterval) { window.clearInterval(bootInterval); bootInterval = 0; }
  if (bootTimer) { window.clearTimeout(bootTimer); bootTimer = 0; }
  document.getElementById('cyber-boot')?.remove();
}

// ── BREACH PROTOCOL easter egg ───────────────────────────────────────────────
// Once you're at the bottom of the page, keep pulling further down; the
// accumulated over-scroll past the end detonates a full-screen RGB-split glitch
// storm (so simply reaching the bottom never sets it off). Re-arms after you
// scroll away. Ported from kaboo's CyberpunkBreach.
const BREACH_OVERSCROLL = 320;
const BREACH_SHARDS = 16;
let breachArmed = true;
let breachAccum = 0;
let breachLastTouchY = 0;
let breaching = false;
let breachTimers: number[] = [];
let breachHandlers: Array<[string, EventListener]> = [];

function triggerBreach(): void {
  if (breaching) return;
  breaching = true;
  breachArmed = false;
  breachAccum = 0;
  const reduced = reducedMotion();

  let shards = '';
  for (let i = 0; i < BREACH_SHARDS; i++) {
    const hue = i % 3 === 0 ? '186 100% 52%' : i % 3 === 1 ? '330 100% 58%' : '56 97% 52%';
    const shift = (i % 2 === 0 ? 1 : -1) * (8 + (i % 5) * 7);
    shards +=
      `<span class="cyber-breach-shard" style="top:${(i / BREACH_SHARDS) * 100}%;` +
      `height:${2 + (i % 4) * 3}%;--shift:${shift}px;--delay:${(i % 8) * 0.09}s;` +
      `--dur:${(0.36 + (i % 5) * 0.12).toFixed(2)}s;--hue:${hue}"></span>`;
  }
  const el = document.createElement('div');
  el.id = 'cyber-breach';
  el.className = 'cyber-breach';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML =
    '<span class="cyber-breach-flash"></span><span class="cyber-breach-grid"></span>' +
    `<div class="cyber-breach-shards">${shards}</div>` +
    '<div class="cyber-breach-banner">' +
    '<span class="cyber-breach-tag">// BREACH PROTOCOL — SYSTEM OVERRIDE</span>' +
    '<span class="cyber-breach-caption" data-text="SYSTEM BREACH">SYSTEM BREACH</span>' +
    '<span class="cyber-breach-sub" data-text="NETWATCH OVERRIDE ENGAGED">NETWATCH OVERRIDE ENGAGED</span>' +
    '</div>';
  document.body.appendChild(el);

  if (!reduced) document.body.classList.add('cyber-breach-quake');
  breachTimers.push(window.setTimeout(() => document.body.classList.remove('cyber-breach-quake'), 760));
  breachTimers.push(window.setTimeout(() => { el.remove(); breaching = false; }, reduced ? 2600 : 4200));
}

function startBreach(): void {
  breachArmed = true;
  breachAccum = 0;
  const docEl = document.documentElement;
  const atBottom = () => docEl.scrollHeight - (window.innerHeight + window.scrollY) <= 4;
  const bump = (delta: number) => {
    if (delta <= 0 || !atBottom()) return;
    breachAccum += delta;
    if (breachAccum > BREACH_OVERSCROLL && breachArmed) triggerBreach();
  };
  const onWheel: EventListener = e => bump((e as WheelEvent).deltaY);
  const onTouchStart: EventListener = e => { breachLastTouchY = (e as TouchEvent).touches[0]?.clientY ?? 0; };
  const onTouchMove: EventListener = e => {
    const y = (e as TouchEvent).touches[0]?.clientY ?? 0;
    const dy = breachLastTouchY - y; // swipe up = pulling content further down
    breachLastTouchY = y;
    bump(dy);
  };
  const onScroll: EventListener = () => {
    if (!atBottom()) { breachAccum = 0; breachArmed = true; }
  };
  const reg = (type: string, h: EventListener) => {
    window.addEventListener(type, h, { passive: true });
    breachHandlers.push([type, h]);
  };
  reg('wheel', onWheel);
  reg('touchstart', onTouchStart);
  reg('touchmove', onTouchMove);
  reg('scroll', onScroll);
}

function stopBreach(): void {
  for (const [type, h] of breachHandlers) window.removeEventListener(type, h);
  breachHandlers = [];
  breachTimers.forEach(id => window.clearTimeout(id));
  breachTimers = [];
  document.body.classList.remove('cyber-breach-quake');
  document.getElementById('cyber-breach')?.remove();
  breaching = false;
  breachArmed = true;
  breachAccum = 0;
}

/**
 * Mount (active=true) or tear down (active=false) the cyberpunk FX. When `withBoot`
 * is set (i.e. the user just switched into the skin), the decrypt loader plays.
 */
export function applyCyberFx(active: boolean, withBoot = false): void {
  if (typeof document === 'undefined') return;

  if (!active) {
    document.getElementById('cyber-fx')?.remove();
    document.getElementById('cyber-hud')?.remove();
    document.getElementById('cyber-glitch')?.remove();
    stopGlitches();
    stopBoot();
    stopBreach();
    return;
  }

  if (!document.getElementById('cyber-fx')) {
    const host = document.createElement('div');
    host.id = 'cyber-fx';
    host.className = 'cyber-fx';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML =
      '<div class="cyber-fx-grid"></div><div class="cyber-fx-scan"></div>' +
      '<span class="cyber-flicker"></span><span class="cyber-rollline"></span>';
    buildRain(host);
    document.body.appendChild(host);

    const hud = document.createElement('div');
    hud.id = 'cyber-hud';
    hud.className = 'cyber-hud';
    hud.setAttribute('aria-hidden', 'true');
    hud.innerHTML =
      '<span class="cyber-hud-corner tl"></span><span class="cyber-hud-corner tr"></span>' +
      '<span class="cyber-hud-corner bl"></span><span class="cyber-hud-corner br"></span>' +
      '<span class="cyber-hud-tag">NIGHT CITY // NETWATCH</span>';
    document.body.appendChild(hud);

    const glitch = document.createElement('div');
    glitch.id = 'cyber-glitch';
    glitch.className = 'cyber-glitch';
    glitch.setAttribute('aria-hidden', 'true');
    document.body.appendChild(glitch);

    startGlitches();
    startBreach();
  }

  if (withBoot) playBoot();
}
