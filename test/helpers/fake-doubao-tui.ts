import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A stand-in for Doubao CLI 2.37's interactive TUI, for real-worker tests.
 *
 * Modeled on the 2.37.2 composer/queue source (resources/js_app/entry-cli-router):
 *   - the composer row is `❯ <text>` between two horizontal rules, with the
 *     `Ask Doubao to do anything` placeholder when empty; a paste of 4+ lines
 *     collapses to `[Pasted text #N +M lines]`;
 *   - Enter moves the composer text into Doubao's OWN send queue and clears the
 *     composer. The queue is pumped only while no turn is active, so an input
 *     submitted while busy shows `N queued · <prompt> · Ctrl+Q manage` under
 *     the composer and reaches assignment.md only after the running turn ends;
 *   - a running turn draws `<spinner> Running tool… (Ns • esc to interrupt)`;
 *     Esc stops it without writing anything to trajectory.jsonl.
 *
 * Control files in `ctlDir` drive the scenario:
 *   - `drop-enter`      Enter is ignored and the draft stays in the composer
 *                       (Doubao's `canSubmit` returning false);
 *   - `finish-<n>`      turn n writes its tool result and final answer
 *                       (file content, default `ANSWER_<n>`) and ends;
 *   - `midfinal-<n>`    turn n writes a content-only assistant record (file
 *                       content) but keeps running;
 *   - `background-busy` the next Enter finds Doubao busy with work that is not
 *                       a botmux turn; it ends when the file is removed,
 *                       writing `background-final` (if present) as its own
 *                       content-only answer row just before the queue pumps;
 *   - `drop-queue`      the user removes everything from Doubao's send queue
 *                       (Ctrl+Q → remove);
 *   - `submit-delay`    milliseconds between sending a request and its
 *                       assignment.md section (default 300);
 *   - `paste-delay`     clipboard probe delay before text appears in the
 *                       composer; Enter is ignored while it is pending;
 *   - `paste-hold`      keep the clipboard probe pending until removed;
 *   - `row-first`       the request's `role:user` trajectory row lands first,
 *                       its assignment.md section this many ms later;
 *   - `row-after`       the section lands first, the request row this many
 *                       ms later;
 *   - `panel`           a full-screen panel (Ctrl+Q queue manager) covers the
 *                       conversation, busy footer, composer and queue line.
 *   - `export-only`     answers are exported but no trajectory rows are written;
 *   - `export-error`    the read-only export command exits nonzero;
 *   - `export-delay`    delays returning an export snapshot, in milliseconds.
 * Every stdin chunk is appended to `inputLog` as one JSON line.
 */
export function writeFakeDoubaoTui(dir: string, opts: {
  systemDir: string;
  ctlDir: string;
  inputLog: string;
}): string {
  mkdirSync(opts.ctlDir, { recursive: true });
  const path = join(dir, 'fake-doubao.cjs');
  writeFileSync(path, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SYSTEM_DIR = ${JSON.stringify(opts.systemDir)};
const CTL = ${JSON.stringify(opts.ctlDir)};
const INPUT_LOG = ${JSON.stringify(opts.inputLog)};
const ASSIGNMENT = path.join(SYSTEM_DIR, 'assignment.md');
const TRAJECTORY = path.join(SYSTEM_DIR, 'trajectory.jsonl');
const ctl = name => path.join(CTL, name);
const has = name => fs.existsSync(ctl(name));
const read = name => { try { return fs.readFileSync(ctl(name), 'utf8').trim(); } catch { return ''; } };
const appendJson = row => fs.appendFileSync(TRAJECTORY, JSON.stringify(row) + '\\n');
const EXPORT = ctl('export.json');
if (process.argv.includes('--hold-export-pipes')) { setInterval(() => {}, 100); return; }
if (process.argv.includes('--export')) {
  const stdin = fs.fstatSync(0);
  if (!process.stdin.isTTY && !stdin.isFIFO() && !stdin.isFile()) {
    process.stderr.write('stdin must be a terminal, pipe or regular file\\n');
    process.exit(2);
  }
  fs.appendFileSync(ctl('exports.log'), 'export\\n');
  fs.writeFileSync(ctl('export-process.pid'), String(process.pid));
  if (has('export-hang')) { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); return; }
  if (has('export-held-pipes')) {
    const child = require('node:child_process').spawn(process.execPath, [__filename, '--hold-export-pipes'], { stdio: ['ignore', 1, 2] });
    fs.writeFileSync(ctl('export-child.pid'), String(child.pid));
    process.stdout.write('[]'); process.exit(0);
  }
  if (has('export-error')) process.exit(2);
  const snapshot = has('export-invalid') ? '{' : (has('export.json') ? fs.readFileSync(EXPORT, 'utf8') : '[]');
  setTimeout(() => { process.stdout.write(snapshot); process.exit(0); }, Number(read('export-delay')) || 0);
  return;
}
const exported = has('export.json') ? JSON.parse(fs.readFileSync(EXPORT, 'utf8')) : [];

let composer = '';
let pasted = 0;
let pendingPaste = false;
let pasteGeneration = 0;
let turn = null;            // { n, startedAt, midDone }
let background = null;      // { startedAt }
let turnCount = 0;
const queue = [];
const transcript = [];
let lastFrame = '';

process.stdout.write('\\x1b[?1049h\\x1b[?2004h');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

function composerRow() {
  if (!composer) return '❯  Ask Doubao to do anything';
  const lines = composer.split('\\n');
  if (lines.length >= 4) return '❯ [Pasted text #' + pasted + ' +' + (lines.length - 1) + ' lines]';
  return '❯ ' + lines.join(' ');
}

function render() {
  if (has('panel')) {
    const h = Math.max(20, (process.stdout.rows || 40) - 1);
    const rows = ['Queued messages', '', ...queue.map((q, i) => (i + 1) + '. ' + q.replace(/\\s+/g, ' ').slice(0, 50)), '', 'Esc close · remove'];
    while (rows.length < h) rows.push('');
    const frame = rows.join('\\r\\n');
    if (frame === lastFrame) return;
    lastFrame = frame;
    process.stdout.write('\\x1b[H\\x1b[2J' + frame);
    return;
  }
  // Like the real layout, the conversation fills the screen and the activity
  // footer, composer box, model line and queue line sit at the bottom.
  const height = Math.max(20, (process.stdout.rows || 40) - 1);
  const bottom = [];
  const active = turn || background;
  if (active) {
    const secs = Math.floor((Date.now() - active.startedAt) / 1000);
    const spin = ['◐', '◓', '◑', '◒'][Math.floor(Date.now() / 250) % 4];
    bottom.push(spin + ' Running tool… (' + secs + 's • esc to interrupt)');
  } else bottom.push('');
  const rule = '─'.repeat(60);
  bottom.push(rule, composerRow(), rule, '  Default model · Default · /work');
  if (queue.length) bottom.push(queue.length + ' queued · ' + queue[0].replace(/\\s+/g, ' ').slice(0, 50) + ' · Ctrl+Q manage');
  const top = ['Doubao CLI (test double)', '', ...transcript.slice(-8)];
  while (top.length + bottom.length < height) top.push('');
  const frame = [...top, ...bottom].join('\\r\\n');
  if (frame === lastFrame) return;
  lastFrame = frame;
  process.stdout.write('\\x1b[H\\x1b[2J' + frame);
}

function pump() {
  if (turn || background || queue.length === 0) return;
  const prompt = queue.shift();
  const n = ++turnCount;
  turn = { n, startedAt: Date.now(), midDone: false, prompt, exportIndex: exported.length };
  setTimeout(() => {
    if (!turn || turn.n !== n) return;
    const section = () => fs.appendFileSync(ASSIGNMENT, '## [' + new Date().toISOString() + '] 需求\\n' + prompt + '\\n\\n');
    if (has('row-first')) setTimeout(section, Number(read('row-first')) || 3000); else section();
    exported.push({ query: prompt, response: '' });
    fs.writeFileSync(EXPORT, JSON.stringify(exported));
    if (has('export-only')) return;
    if (has('row-after')) setTimeout(() => appendJson({ role: 'user', content: prompt }), Number(read('row-after')) || 400);
    else appendJson({ role: 'user', content: prompt });
    appendJson({ role: 'assistant', content: '', tool_calls: [{ id: 'call-' + n, function: { name: 'Read', arguments: '{}' } }] });
    transcript.push('> ' + prompt.split('\\n')[0].slice(0, 50));
  }, Number(read('submit-delay')) || 300);
}

function submit() {
  if (!composer || pendingPaste) return;
  if (has('drop-enter')) return;
  const text = composer;
  composer = '';
  pasted = 0;
  if (has('background-busy') && !turn && !background) background = { startedAt: Date.now() };
  queue.push(text);
  pump();
}

function stop() {
  if (turn) { transcript.push('Stopped'); turn = null; }
  setTimeout(pump, 200);
}

let pending = '';
let inPaste = false;
let pasteBuf = '';
process.stdin.on('data', chunk => {
  fs.appendFileSync(INPUT_LOG, JSON.stringify({ t: Date.now(), data: chunk }) + '\\n');
  pending += chunk;
  while (pending) {
    if (inPaste) {
      const end = pending.indexOf('\\x1b[201~');
      if (end < 0) { pasteBuf += pending; pending = ''; break; }
      pasteBuf += pending.slice(0, end);
      pending = pending.slice(end + 6);
      inPaste = false;
      const text = pasteBuf.replace(/\\r\\n?/g, '\\n');
      const generation = ++pasteGeneration;
      pendingPaste = true;
      const readyAt = Date.now() + (Number(read('paste-delay')) || 0);
      const finishPaste = () => {
        if (generation !== pasteGeneration) return;
        if (has('paste-hold') || Date.now() < readyAt) { setTimeout(finishPaste, 50); return; }
        pendingPaste = false;
        if (text.split('\\n').length >= 4) pasted++;
        composer += text;
        render();
      };
      setTimeout(finishPaste, 0);
      pasteBuf = '';
      continue;
    }
    if (pending.startsWith('\\x1b[200~')) { inPaste = true; pending = pending.slice(6); continue; }
    if (pending === '\\x1b') { pending = ''; stop(); break; }
    if (pending.startsWith('\\x1b[')) {
      const m = /^\\x1b\\[[0-?]*[ -\\/]*[@-~]/.exec(pending);
      if (!m) break;
      pending = pending.slice(m[0].length);
      continue;
    }
    const ch = pending[0];
    pending = pending.slice(1);
    if (ch === '\\r' || ch === '\\x13') submit();
    else if (ch === '\\n') composer += '\\n';
    else if (ch === '\\x7f') composer = composer.slice(0, -1);
    else if (ch === '\\x15') { composer = ''; pasted = 0; pendingPaste = false; pasteGeneration++; }
    else if (ch === '\\x03') process.exit(0);
    else if (ch >= ' ') composer += ch;
  }
  render();
});

setInterval(() => {
  if (has('drop-queue') && queue.length) queue.length = 0;
  if (background && !has('background-busy')) {
    if (has('background-final')) appendJson({ role: 'assistant', content: read('background-final') });
    background = null;
    pump();
  }
  if (turn) {
    const n = turn.n;
    if (!turn.midDone && has('midfinal-' + n)) {
      turn.midDone = true;
      appendJson({ role: 'assistant', content: read('midfinal-' + n) || 'Still working on it.' });
    }
    if (has('finish-' + n)) {
      const answer = read('finish-' + n) || ('ANSWER_' + n);
      if (!has('export-only')) {
        appendJson({ role: 'tool', tool_call_id: 'call-' + n, content: 'ok' });
        appendJson({ role: 'assistant', content: answer });
      }
      if (exported[turn.exportIndex]) {
        exported[turn.exportIndex].response = answer;
        fs.writeFileSync(EXPORT, JSON.stringify(exported));
      }
      transcript.push(answer);
      turn = null;
      setTimeout(pump, 200);
    }
  }
  render();
}, 200);
render();
`, { mode: 0o755 });
  return path;
}
