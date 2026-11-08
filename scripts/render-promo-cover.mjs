#!/usr/bin/env node
// Renders the README promo-video covers: docs/assets/botmux-promo-cover.gif and botmux-promo-cover-en.gif.
//   node scripts/render-promo-cover.mjs [zh|en]
// Needs ffprobe on PATH, the Noto Serif CJK SC / Noto Sans CJK SC fonts, and playwright's Chromium
// (or PLAYWRIGHT_CHROMIUM_EXECUTABLE). sharp is not a direct dependency; it is installed via @midscene/shared.
// Re-run after replacing the promo videos: the cover shows their duration.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1200;
const H = 675;
const FPS = 15;
const LOOP_S = 9;

const COPY = {
  zh: {
    out: 'docs/assets/botmux-promo-cover.gif',
    video: 'docs-site/static/img/video-promo.mp4',
    lang: 'zh-CN',
    headline: '在飞书里，遥控你的 AI 编程 CLI',
    sub: '一条消息启动一个会话 · 每个会话一个独立 CLI · 手机、电脑、终端三端同步',
    topic: '飞书 · 话题群',
    you: '你',
    ask: '@Claude 修一下登录页的报错',
    bot: 'Claude',
    botTag: '机器人',
    doneTitle: '已修复：登录页报错',
    doneLines: ['改动 src/login.ts（+12 −3）', '42 项测试全部通过'],
    watch: '视频简介',
  },
  en: {
    out: 'docs/assets/botmux-promo-cover-en.gif',
    video: 'docs-site/static/img/video-promo-en.mp4',
    lang: 'en',
    headline: 'Drive your AI coding CLI from Lark',
    sub: 'One message, one session, one isolated CLI — synced across phone, desktop and terminal',
    topic: 'Lark · Topic group',
    you: 'You',
    ask: '@Claude fix the login page error',
    bot: 'Claude',
    botTag: 'Bot',
    doneTitle: 'Fixed: login page error',
    doneLines: ['Changed src/login.ts (+12 −3)', 'All 42 tests passed'],
    watch: 'Video intro',
  },
};

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

function videoDuration(file) {
  const seconds = Math.floor(Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])));
  if (!Number.isFinite(seconds)) throw new Error(`cannot read duration of ${file}`);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(copy, duration) {
  return `<!doctype html><html lang="${copy.lang}"><head><meta charset="utf-8"><style>
:root{--bg:#F0EEE6;--paper:#FAF9F5;--ink:#141413;--muted:#5E5D59;--faint:#87867F;--line:#D1CFC5;
  --clay:#D97757;--kraft:#D4A27F;--oat:#E3DACC;--olive:#788C5D}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:var(--bg)}
body{position:relative;color:var(--ink);font-family:'Noto Sans CJK SC','Noto Sans',sans-serif}
.mono{font-family:'Noto Sans Mono','DejaVu Sans Mono',monospace}
#brand{position:absolute;left:72px;top:40px;display:flex;align-items:center;gap:10px;font-size:22px;font-weight:700}
#brand i{width:12px;height:12px;border-radius:50%;background:var(--clay)}
#site{position:absolute;right:72px;top:45px;font-size:15px;color:var(--faint)}
h1{position:absolute;left:0;right:0;top:90px;text-align:center;font:600 50px/1.2 'Noto Serif CJK SC',serif;letter-spacing:.01em}
#sub{position:absolute;left:0;right:0;top:170px;text-align:center;font-size:19px;color:var(--muted)}
.panel{position:absolute;top:248px;width:360px;height:304px;border:2px solid var(--ink);border-radius:20px;overflow:hidden}
#chat{left:72px;background:var(--paper)}
#chat header{height:46px;display:flex;align-items:center;gap:8px;padding:0 18px;border-bottom:1.5px solid var(--line);font-size:15px;color:var(--muted)}
#chat header b{color:var(--clay);font-size:18px}
.msg{position:absolute;left:18px;right:18px;display:flex;gap:10px}
.avatar{flex:none;width:30px;height:30px;border-radius:50%;border:1.5px solid var(--ink)}
.who{font-size:13px;color:var(--faint);margin-bottom:4px;display:flex;align-items:center;gap:6px}
.who em{font-style:normal;font-size:11px;color:var(--muted);background:var(--oat);border-radius:4px;padding:0 5px}
.bubble{display:inline-block;background:var(--oat);border-radius:4px 14px 14px 14px;padding:8px 12px;font-size:16px;line-height:1.4}
.card{background:var(--bg);border:1.5px solid var(--line);border-left:4px solid var(--clay);border-radius:10px;padding:10px 12px;width:270px}
.card .t{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600;line-height:24px}
.card .t i{flex:none;width:18px;height:18px;border-radius:50%;background:var(--olive);color:var(--paper);font:700 12px/18px sans-serif;text-align:center;font-style:normal}
.card p{font-size:14px;line-height:22px;color:var(--muted)}
#term{right:72px;background:var(--ink)}
#term header{height:40px;display:flex;align-items:center;gap:8px;padding:0 16px;position:relative}
#term header i{width:12px;height:12px;border-radius:50%}
#term header span{position:absolute;left:0;right:0;text-align:center;font-size:13px;color:var(--faint)}
#tbody{padding:12px 20px;font-size:15px;line-height:30px;color:var(--paper);white-space:pre}
.c{color:var(--clay)}.o{color:#9DB07F}.f{color:var(--faint)}
.cursor{display:inline-block;width:9px;height:18px;background:var(--clay);vertical-align:-3px}
#bar{position:absolute;left:72px;right:72px;top:594px;height:24px;display:flex;align-items:center;gap:14px;font-size:14px;color:var(--muted)}
#track{flex:1;height:4px;border-radius:2px;background:var(--line);position:relative}
#track i{position:absolute;left:-6px;top:-5px;width:14px;height:14px;border-radius:50%;background:var(--ink)}
#fx{position:absolute;inset:0;pointer-events:none}
#watch{position:absolute;left:0;right:0;top:516px;text-align:center;font-size:17px;font-weight:500}
#watch span{color:var(--faint);margin-left:6px}
</style></head><body>
<div id="brand"><i></i>botmux</div>
<div id="site" class="mono">deepcoldy.github.io/botmux</div>
<h1>${esc(copy.headline)}</h1>
<div id="sub">${esc(copy.sub)}</div>
<svg id="fx" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <line x1="432" y1="400" x2="768" y2="400" stroke="#87867F" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 9"/>
  <g id="dots"></g>
  <circle id="ring0" cx="600" cy="400" r="62" fill="none" stroke="#D97757" stroke-width="2"/>
  <circle id="ring1" cx="600" cy="400" r="62" fill="none" stroke="#D97757" stroke-width="2"/>
  <g id="play">
    <circle cx="600" cy="400" r="62" fill="#D97757"/>
    <path d="M591 379 L591 421 L627 400 Z" fill="#FAF9F5" stroke="#FAF9F5" stroke-width="6" stroke-linejoin="round"/>
  </g>
</svg>
<div id="watch">${esc(copy.watch)}<span class="mono">${duration}</span></div>
<section class="panel" id="chat">
  <header><b>#</b>${esc(copy.topic)}</header>
  <div class="msg" id="m1" style="top:62px">
    <div class="avatar" style="background:var(--kraft)"></div>
    <div><div class="who">${esc(copy.you)}</div><div class="bubble">${esc(copy.ask)}</div></div>
  </div>
  <div class="msg" id="m2" style="top:146px">
    <div class="avatar" style="background:var(--clay)"></div>
    <div><div class="who">${esc(copy.bot)}<em>${esc(copy.botTag)}</em></div>
      <div class="card"><div class="t" id="r0"><i>✓</i>${esc(copy.doneTitle)}</div>
        ${copy.doneLines.map((l, i) => `<p id="r${i + 1}">${esc(l)}</p>`).join('')}</div></div>
  </div>
</section>
<section class="panel" id="term">
  <header><i style="background:var(--clay)"></i><i style="background:var(--kraft)"></i><i style="background:var(--oat)"></i>
    <span class="mono">claude — ~/app</span></header>
  <div id="tbody" class="mono"></div>
</section>
<div id="bar">
  <svg width="14" height="16" viewBox="0 0 14 16"><path d="M1 1 L13 8 L1 15 Z" fill="#141413"/></svg>
  <span class="mono">0:00 / ${duration}</span>
  <div id="track"><i></i></div>
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#141413" stroke-width="2" stroke-linecap="round">
    <path d="M1 6V1h5M12 1h5v5M17 12v5h-5M6 17H1v-5"/></svg>
</div>
<script>
const LOOP = ${LOOP_S};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const span = (t, a, b) => clamp01((t - a) / (b - a));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const $ = (id) => document.getElementById(id);
const X0 = 432, X1 = 768, CY = 400, R = 62;

function show(el, p, rise = 10) {
  el.style.opacity = p;
  el.style.transform = 'translateY(' + ((1 - p) * rise).toFixed(2) + 'px)';
}
function reveal(el, p) {
  el.style.clipPath = 'inset(0 ' + (100 - 100 * p).toFixed(2) + '% 0 0)';
}
function dots(t, start, forward) {
  let out = '';
  for (let k = 0; k < 3; k++) {
    const p = span(t, start + k * 0.18, start + k * 0.18 + 0.9);
    if (p <= 0 || p >= 1) continue;
    const x = forward ? X0 + (X1 - X0) * p : X1 - (X1 - X0) * p;
    const a = Math.min(1, p * 8, (1 - p) * 8);
    out += '<circle cx="' + x.toFixed(1) + '" cy="' + CY + '" r="5" fill="#D97757" opacity="' + a.toFixed(2) + '"/>';
  }
  return out;
}
const PROMPT = '<span class="c">~/app</span> <span class="f">$</span> ';
const LINES = [
  [2.8, '<span class="c">●</span> Read src/login.ts'],
  [3.3, '<span class="c">●</span> Update src/login.ts <span class="o">+12</span> <span class="c">−3</span>'],
  [3.8, '<span class="c">●</span> Bash npm test'],
  [4.3, '  <span class="o">✓ 42 passed</span>'],
];

window.renderFrame = (t) => {
  const keep = 1 - span(t, LOOP - 0.8, LOOP - 0.3);
  const reset = t >= LOOP - 0.3;

  show($('m1'), ease(span(t, 0.3, 0.9)) * keep);
  show($('m2'), ease(span(t, 5.5, 6.0)) * keep);
  reveal($('r0'), span(t, 5.6, 6.1));
  reveal($('r1'), span(t, 6.0, 6.4));
  reveal($('r2'), span(t, 6.3, 6.7));

  $('dots').innerHTML = dots(t, 1.0, true) + dots(t, 4.6, false);

  for (let k = 0; k < 2; k++) {
    const p = ((t / 1.8) + k * 0.5) % 1;
    const ring = $('ring' + k);
    ring.setAttribute('r', (R + 44 * (1 - Math.pow(1 - p, 2))).toFixed(2));
    ring.setAttribute('opacity', (0.55 * (1 - p)).toFixed(3));
  }
  const breathe = 1 + 0.035 * Math.sin((t / 1.8) * 2 * Math.PI);
  $('play').setAttribute('transform', 'translate(600 400) scale(' + breathe.toFixed(4) + ') translate(-600 -400)');

  const cursorOn = (t % 1) < 0.55 && !(t > LOOP - 0.8 && !reset);
  const cursor = cursorOn ? '<span class="cursor"></span>' : '';
  const typedLen = reset ? 0 : Math.round(span(t, 2.0, 2.5) * 6);
  const rows = [PROMPT + '<span style="opacity:' + keep + '">' + 'claude'.slice(0, typedLen) + '</span>'];
  if (!reset) {
    for (const [at, html] of LINES) {
      const p = span(t, at, at + 0.15);
      if (p > 0) rows.push('<span style="opacity:' + (p * keep).toFixed(3) + '">' + html + '</span>');
    }
    if (t >= 4.5) rows.push('<span style="opacity:' + keep + '">' + PROMPT + '</span>');
  }
  rows[rows.length - 1] += cursor;
  $('tbody').innerHTML = rows.join('\\n');
};
window.renderFrame(0);
</script></body></html>`;
}

async function render(lang, browser) {
  const copy = COPY[lang];
  const duration = videoDuration(join(ROOT, copy.video));
  const frames = mkdtempSync(join(tmpdir(), `botmux-cover-${lang}-`));
  try {
    const tab = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await tab.setContent(page(copy, duration));
    await tab.evaluate(() => document.fonts.ready);
    const files = Array.from({ length: LOOP_S * FPS }, (_, i) => join(frames, `f${String(i).padStart(4, '0')}.png`));
    for (const [i, path] of files.entries()) {
      await tab.evaluate((t) => window.renderFrame(t), i / FPS);
      await tab.screenshot({ path });
    }
    await tab.close();
    const out = join(ROOT, copy.out);
    await sharp(files, { join: { animated: true } })
      .gif({ colours: 96, effort: 10, dither: 0, loop: 0, delay: files.map(() => Math.round(1000 / FPS)) })
      .toFile(out);
    console.log(`${copy.out}  ${(statSync(out).size / 1024).toFixed(0)} KiB  (${files.length} frames, video ${duration})`);
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(COPY);
for (const lang of langs) if (!COPY[lang]) throw new Error(`unknown language: ${lang}`);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
try {
  for (const lang of langs) await render(lang, browser);
} finally {
  await browser.close();
}
