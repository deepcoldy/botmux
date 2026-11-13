// Fake Kimi Code for test/worker-kimi-cache-expiry.integration.test.ts.
//
// Screens are the real Kimi Code 2.5.3 captures in test/fixtures/stuck-pages
// (160x50, botmux's default pane). OSC 7501 follows what the real binary sent
// in the probes those captures come from:
//   - a turn: `working` on submit, `done` when the reply is drawn;
//   - the cache-expiry menu: NOTHING (the last state stays) — on an idle submit
//     the message is parked, on resume the menu shows right after `idle`;
//   - Enter on "Compact and continue": `working` at once, compaction, then the
//     parked message runs in the same busy period and ends with `done`; with
//     nothing parked (resume) compaction ends with `idle`;
//   - a paste while the menu is up is swallowed, and its Enter picks the
//     highlighted row (resume scene: the message is lost).
// Every input event is appended as a JSON line to $FAKE_KIMI_LOG.
//
// Env:
//   FAKE_KIMI_SCENARIO   'idle' (menu on the Nth submit, N = FAKE_KIMI_MENU_ON,
//                        default 2) | 'resume' (menu right after startup)
//   FAKE_KIMI_POINTER    initial highlight: compact | new | continue
//   FAKE_KIMI_IGNORE_ENTER=1  Enter on the menu does nothing
//   FAKE_KIMI_WORKING_DELAY_MS  report `working` this long after the Enter
//                        (default: at once, like the real binary)
//   FAKE_KIMI_START_FILE paint the first frame only once this file exists
//                        (tmux backend: the test creates it when the worker's
//                        pane is piped, see startWorker in the test)
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'stuck-pages');
// Kimi repaints with cursor addressing, not line feeds: each row is placed
// with CUP and cleared to the end, so a frame never arrives as plain lines.
const frame = name => readFileSync(join(DIR, name), 'utf8').replace(/\s+$/, '').split('\n').slice(-50)
  .map((row, i) => `\x1b[${i + 1};1H${row}\x1b[K`).join('');
const FRAMES = {
  composer: frame('kimi-2.5.3-composer-after-compact-resend.txt'),
  compacting: frame('kimi-2.5.3-compacting-after-enter.txt'),
  menu: {
    compact: frame('kimi-2.5.3-cache-expiry-idle-submit.txt'),
    new: frame('kimi-2.5.3-cache-expiry-highlight-new-session.txt'),
    continue: frame('kimi-2.5.3-cache-expiry-highlight-continue.txt'),
  },
};
const POINTERS = ['compact', 'new', 'continue'];

const LOG = process.env.FAKE_KIMI_LOG;
const SCENARIO = process.env.FAKE_KIMI_SCENARIO || 'idle';
const MENU_ON = Number(process.env.FAKE_KIMI_MENU_ON || 2);
const IGNORE_ENTER = process.env.FAKE_KIMI_IGNORE_ENTER === '1';
const WORKING_DELAY_MS = Number(process.env.FAKE_KIMI_WORKING_DELAY_MS || 0);
let pointer = process.env.FAKE_KIMI_POINTER || 'compact';

const record = ev => { if (LOG) appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...ev }) + '\n'); };
const out = s => process.stdout.write(s);
const draw = screen => out(`\x1b[2J${screen}`);
const osc = state => out(process.env.TMUX
  ? `\x1bPtmux;\x1b\x1b]7501;state=${state}:app=kimi-code\x1b\x1b\\\x1b\\`
  : `\x1b]7501;state=${state}:app=kimi-code\x1b\\`);

let state = 'composer';
let draft = '';
let submits = 0;
let parked;

function runTurn(text, after = () => {}) {
  record({ ev: 'turn', text });
  setTimeout(() => {
    draw(FRAMES.composer);
    osc('done');
    record({ ev: 'turn-done', text });
    after();
  }, 300);
}

function showMenu() {
  state = 'menu';
  draw(FRAMES.menu[pointer]);
  record({ ev: 'menu-shown', pointer, parked: parked ?? null });
}

function submit(text) {
  submits += 1;
  record({ ev: 'submit', text });
  if (SCENARIO === 'idle' && submits === MENU_ON) {
    parked = text;
    showMenu();
    return;
  }
  osc('working');
  runTurn(text);
}

function menuEnter() {
  record({ ev: 'menu-enter', pointer });
  if (IGNORE_ENTER) return;
  if (pointer !== 'compact') {
    // Never expected from botmux: the test fails on this record.
    record({ ev: 'wrong-row', pointer });
    state = 'composer';
    draw(FRAMES.composer);
    return;
  }
  state = 'compacting';
  if (WORKING_DELAY_MS > 0) setTimeout(() => osc('working'), WORKING_DELAY_MS);
  else osc('working');
  draw(FRAMES.compacting);
  record({ ev: 'compact' });
  setTimeout(() => {
    const text = parked;
    parked = undefined;
    state = 'composer';
    if (text !== undefined) runTurn(text);
    else {
      draw(FRAMES.composer);
      osc('idle');
      record({ ev: 'compact-done' });
    }
  }, 500);
}

function onKey(key) {
  if (state === 'menu') {
    if (key === 'enter') menuEnter();
    else if (key === 'down' || key === 'up') {
      const i = POINTERS.indexOf(pointer) + (key === 'down' ? 1 : -1);
      pointer = POINTERS[Math.max(0, Math.min(POINTERS.length - 1, i))];
      draw(FRAMES.menu[pointer]);
      record({ ev: 'menu-move', pointer });
    } else record({ ev: 'menu-key', key });
    return;
  }
  if (state !== 'composer') { record({ ev: 'key-while-busy', key }); return; }
  if (key === 'enter' && draft) {
    const text = draft;
    draft = '';
    submit(text);
  }
}

let buf = '';
function parse() {
  for (;;) {
    if (!buf) return;
    const pasteStart = buf.indexOf('\x1b[200~');
    if (pasteStart === 0) {
      const end = buf.indexOf('\x1b[201~');
      if (end < 0) return;
      const text = buf.slice(6, end);
      buf = buf.slice(end + 6);
      if (state === 'menu') record({ ev: 'paste-in-menu', text });
      else if (state === 'composer') draft += text;
      else record({ ev: 'paste-while-busy', text });
      continue;
    }
    if (buf.startsWith('\x1b[A')) { buf = buf.slice(3); onKey('up'); continue; }
    if (buf.startsWith('\x1b[B')) { buf = buf.slice(3); onKey('down'); continue; }
    if (buf.startsWith('\x1b[') && buf.length < 6) return;
    const ch = buf[0];
    buf = buf.slice(1);
    if (ch === '\r' || ch === '\n') onKey('enter');
    else if (ch === '\x1b') onKey('esc');
    else if (ch === '\x03') onKey('ctrl-c');
    else if (state === 'composer') draft += ch;
    else if (state === 'menu') record({ ev: 'menu-char', ch });
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; parse(); });

const START_FILE = process.env.FAKE_KIMI_START_FILE;
const bootedAt = Date.now();
if (START_FILE) record({ ev: 'booted' });
function start() {
  if (START_FILE && !existsSync(START_FILE)) {
    setTimeout(start, 10);
    return;
  }
  out('\x1b[?2004h');
  draw(FRAMES.composer);
  osc('idle');
  record({ ev: 'started', scenario: SCENARIO, argv: process.argv.slice(2), heldMs: Date.now() - bootedAt });
  // Real 2.5.3 on resume: `idle` first, the replayed history, then the menu
  // ~0.22s after the `idle` report.
  if (SCENARIO === 'resume') setTimeout(showMenu, 220);
}
start();
setInterval(() => {}, 60_000);
