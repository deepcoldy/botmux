#!/usr/bin/env node
// A Codex that draws the Codex 0.166 composer and answers every pasted prompt
// after 800 ms through its rollout (user message, then task_complete), holding
// the rollout open the way Codex does. Frames as in
// worker-codex-first-prompt-input-box.integration.test.ts.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
const sid = '019dd80d-d922-7a11-8339-0208d8c5b4ee';
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
const rollout = fs.openSync(path.join(home, 'sessions', 'rollout-2026-11-12T00-00-00-' + sid + '.jsonl'), 'a');
const event = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
fs.writeSync(rollout, event('session_meta', { id: sid, cwd: process.cwd() }));
const HEADER = '\x1b[2J\x1b[H\r\n  >_ OpenAI Codex (v0.166.0)\r\n     ' + process.cwd() + '\r\n';
const READY = HEADER + '  permissions: YOLO mode\r\n\r\n\r\n› Ask Codex to do anything\r\n\r\n  custom-model · ' + process.cwd() + '\x1b[7;3H';
const WORKING = HEADER + '  permissions: YOLO mode\r\n\r\n• Working (1s • esc to interrupt)\r\n\r\n› Ask Codex to do anything\r\n\r\n  custom-model · ' + process.cwd() + '\x1b[8;3H';
process.stdout.write('\x1b[?2004h');
process.stdin.setRawMode(true);
let input = '';
let answered = 0;
process.stdin.on('data', buf => {
  input += buf.toString('utf8');
  const pastes = [...input.matchAll(/\x1b\[200~([\s\S]*?)\x1b\[201~\r/g)];
  for (const m of pastes.slice(answered)) {
    const turn = ++answered;
    const text = m[1];
    fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({ session_id: sid, text, ts: Date.now() / 1000 }) + '\n');
    fs.writeSync(rollout, event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }));
    process.stdout.write(WORKING);
    setTimeout(() => {
      fs.writeSync(rollout, event('event_msg', { type: 'task_complete', turn_id: 'native-' + turn, last_agent_message: 'reply: ' + text }));
      process.stdout.write(READY);
    }, 800);
  }
});
// Drawn again until the worker's output pipe has surely attached.
for (const atMs of [0, 200, 500, 1000]) setTimeout(() => process.stdout.write(READY), atMs);
setInterval(() => {}, 1000);
