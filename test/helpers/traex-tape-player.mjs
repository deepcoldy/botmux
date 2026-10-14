#!/usr/bin/env node
// Fake `traex` that replays a tape recorded from the real TraeX binary by
// scripts/record-traex-tape.ts. TraeX is distributed internally only, so CI
// replays real PTY bytes instead of running it.
//
// Startup bytes play until the first recorded submit. Each submit the worker
// types (bracketed paste + Enter) replays the next recorded turn segment —
// PTY chunks, history.jsonl receipt and rollout records — at the recorded
// offsets; extra submits cycle through the recorded turns with fresh turn ids
// and queue behind an active turn like TraeX's type-ahead. While idle, the
// banner-logo blink chunks recorded between turns keep repeating, as the real
// TUI never goes byte-silent.
//
// Env:
//   TRAEX_TAPE                    tape JSON path (required)
//   TRAEX_TAPE_ROLLOUT            rollout JSONL path to append to (required)
//   TRAEX_TAPE_HISTORY            history.jsonl path to append to (required)
//   TRAEX_TAPE_SUBMISSIONS        optional JSONL log of received submits
//   TRAEX_TAPE_TERMINAL_DELAY_MS  extra delay for each task_complete record,
//                                 i.e. the rollout terminal lands after the
//                                 composer already went quiet
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const tape = JSON.parse(readFileSync(process.env.TRAEX_TAPE, 'utf8'));
const rolloutPath = process.env.TRAEX_TAPE_ROLLOUT;
const historyPath = process.env.TRAEX_TAPE_HISTORY;
const submissionsPath = process.env.TRAEX_TAPE_SUBMISSIONS;
const terminalDelayMs = Number(process.env.TRAEX_TAPE_TERMINAL_DELAY_MS) || 0;
const cwd = process.cwd();

const fill = text => text.replaceAll('{{CWD}}', cwd).replaceAll('{{HOME}}', process.env.HOME ?? '');

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[78]/g;
const isBlink = data => /^[◆─\s]*$/.test(data.replace(ANSI, ''));

const submits = tape.events.filter(e => e.kind === 'submit');
const startup = tape.events.filter(e => e.t < submits[0].t);
const turns = submits.map((submit, i) => {
  const end = submits[i + 1]?.t ?? Infinity;
  return {
    prompt: submit.text,
    events: tape.events
      .filter(e => e.t > submit.t && e.t < end && e.kind !== 'submit')
      .map(e => ({ ...e, t: e.t - submit.t })),
  };
});
// TraeX receipts a submit in history.jsonl at SUBMIT time, even while a
// running turn parks it in its queue — never at dequeue time.
const historyRecord = tape.events.find(e => e.kind === 'history');
const historyOffsetMs = historyRecord ? historyRecord.t - submits[0].t : 200;
function receipt(text) {
  at(historyOffsetMs, () => appendFileSync(
    historyPath,
    `${JSON.stringify({ ...historyRecord?.record, text, ts: Math.floor(Date.now() / 1000) })}\n`,
  ));
}
// Idle blink: recorded logo-only chunks after the first turn settled.
const lastTurnEnd = turns[0].events.findLast(e => e.kind === 'rollout' && e.record?.payload?.type === 'task_complete')?.t ?? 0;
const blinkChunks = turns[0].events.filter(e => e.kind === 'pty' && e.t > lastTurnEnd && isBlink(e.data));

const timers = new Set();
function at(ms, fn) {
  const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
  timers.add(timer);
}

let blinkTimer = null;
function startBlink() {
  if (blinkTimer || blinkChunks.length === 0) return;
  let i = 0;
  const tick = () => {
    const chunk = blinkChunks[i % blinkChunks.length];
    const next = blinkChunks[(i + 1) % blinkChunks.length];
    process.stdout.write(chunk.data);
    i += 1;
    const gap = next.t > chunk.t ? next.t - chunk.t : 2_200;
    blinkTimer = setTimeout(tick, gap);
  };
  blinkTimer = setTimeout(tick, blinkChunks[0].t - lastTurnEnd);
}
function stopBlink() {
  if (blinkTimer) clearTimeout(blinkTimer);
  blinkTimer = null;
}

let playIndex = 0;
let active = false;
const queue = [];

function playTurn(text) {
  active = true;
  stopBlink();
  const turn = turns[playIndex % turns.length];
  const cycle = Math.floor(playIndex / turns.length);
  playIndex += 1;
  // Later cycles replay the same records as new native turns.
  const turnIds = cycle === 0 ? [] : [...new Set(turn.events
    .filter(e => e.kind === 'rollout' && e.record?.payload?.turn_id)
    .map(e => e.record.payload.turn_id))];
  const renamed = new Map(turnIds.map(id => [id, randomUUID()]));
  const remap = record => {
    let json = JSON.stringify(record);
    for (const [from, to] of renamed) json = json.replaceAll(from, to);
    return JSON.parse(json);
  };
  let doneAt = 0;
  for (const event of turn.events) {
    let t = event.t;
    if (event.kind === 'pty') {
      at(t, () => process.stdout.write(fill(event.data)));
    } else if (event.kind === 'rollout') {
      const record = remap(event.record);
      const payload = record.payload ?? {};
      if (payload.type === 'user_message') payload.message = text;
      for (const completion of payload.display_completions ?? []) {
        if (completion.item?.type === 'UserMessage') completion.item.content = [{ type: 'text', text }];
      }
      if (payload.type === 'task_complete') t += terminalDelayMs;
      at(t, () => {
        record.timestamp = new Date().toISOString();
        appendFileSync(rolloutPath, `${JSON.stringify(record)}\n`);
      });
    }
    doneAt = Math.max(doneAt, t);
  }
  at(doneAt + 10, () => {
    active = false;
    const next = queue.shift();
    if (next !== undefined) playTurn(next);
    else startBlink();
  });
}

for (const event of startup) {
  if (event.kind === 'pty') at(event.t, () => process.stdout.write(fill(event.data)));
}
at((startup.at(-1)?.t ?? 0) + 10, startBlink);

process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
let input = '';
let pasted = '';
process.stdin.on('data', chunk => {
  input += chunk;
  while (true) {
    const start = input.indexOf('\x1b[200~');
    if (start < 0) break;
    const end = input.indexOf('\x1b[201~', start + 6);
    if (end < 0) break;
    pasted = input.slice(start + 6, end);
    input = input.slice(end + 6);
  }
  while (input.includes('\r') || input.includes('\n')) {
    const cr = input.indexOf('\r');
    const lf = input.indexOf('\n');
    const idx = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
    input = input.slice(idx + 1);
    if (!pasted) continue;
    const text = pasted;
    pasted = '';
    if (submissionsPath) appendFileSync(submissionsPath, `${JSON.stringify({ pid: process.pid, text })}\n`);
    receipt(text);
    if (active) queue.push(text);
    else playTurn(text);
  }
});

process.on('SIGTERM', () => process.exit(0));
