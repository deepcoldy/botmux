#!/usr/bin/env node
/** Framed terminal bridge to Antigravity ACP, without typing prompts into its TUI. */
import { resolve } from 'node:path';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import { runAntigravityAcp } from './services/antigravity-acp.js';

const output = new RunnerControlWriter();
const values = new Map<string, string>();
const offset = process.argv[2] === '__antigravity-runner' ? 3 : 2;
for (let i = offset; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--agy-bin', '--cwd', '--native-session-id', '--model', '--effort', '--log-file'].includes(key) || !value) {
    output.error('Invalid Antigravity runner arguments\n'); process.exit(2);
  }
  values.set(key, value);
}
const executable = values.get('--agy-bin');
if (!executable) { output.error('Antigravity runner requires --agy-bin\n'); process.exit(2); }
const cwd = resolve(values.get('--cwd') ?? process.cwd());
let nativeSessionId = values.get('--native-session-id');
let active: AbortController | undefined;
let processing = false;
let closing = false;
let buffer = '';
const queue: Array<{ content: string; turnId: string }> = [];

/** Prefix every displayed line so native content cannot imitate the ready prompt. */
function display(text: string): void {
  for (const line of text.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').split(/[\n\u2028\u2029]/)) {
    output.line(`│ ${line}`);
  }
}

/** Process each immutable input once, retaining only ACP's exact session identity. */
async function drain(): Promise<void> {
  if (processing || closing) return;
  processing = true;
  try {
    while (queue.length && !closing) {
      const turn = queue.shift()!;
      const startedAtMs = Date.now();
      const controller = new AbortController();
      active = controller;
      output.line('[Antigravity ACP] running…');
      try {
        const content = await runAntigravityAcp({
          executable: executable!, cwd, env: process.env, content: turn.content,
          nativeSessionId, model: values.get('--model'), effort: values.get('--effort'), logFile: values.get('--log-file'),
          onSession(id) {
            nativeSessionId = id;
            output.marker('thread', { threadId: id });
          },
          onText: display,
          onTool: title => display(`[tool] ${title}`),
        }, controller.signal);
        if (!closing) output.marker('final', { content, turnId: turn.turnId, startedAtMs, completedAtMs: Date.now() });
      } catch (error) {
        if (!closing) {
          const errorCode = controller.signal.aborted ? 'cancelled' : 'execution_failed';
          const content = controller.signal.aborted ? 'Antigravity 本轮执行已中断。'
            : `Antigravity ACP 执行失败：${error instanceof Error ? error.message : String(error)}`;
          display(content);
          output.marker('final', { content, errorCode, turnId: turn.turnId, startedAtMs, completedAtMs: Date.now() });
        }
      } finally { active = undefined; }
      if (!closing) output.line('›');
    }
  } finally { processing = false; if (closing) process.exit(0); }
}

/** Reject partial, malformed and uncorrelated frames instead of executing terminal text. */
function receive(line: string): void {
  if (!line.trim() || closing) return;
  const prefix = '::botmux-antigravity:';
  if (!line.startsWith(prefix)) { output.line('[Antigravity ACP] ignoring non-frame input'); return; }
  try {
    const encoded = line.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid encoding');
    const frame: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (!frame || typeof frame !== 'object' || !('type' in frame) || frame.type !== 'message'
      || !('content' in frame) || typeof frame.content !== 'string'
      || !('replyTurnId' in frame) || typeof frame.replyTurnId !== 'string' || !frame.replyTurnId
      || queue.length >= 16) throw new Error('invalid frame');
    queue.push({ content: frame.content, turnId: frame.replyTurnId });
    void drain();
  } catch { output.line('[Antigravity ACP] invalid input frame'); }
}

/** Shutdown affects only the ACP process owned by the active call. */
function close(): void {
  closing = true; queue.length = 0; active?.abort();
  if (!processing) process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGHUP', close);
process.on('SIGINT', () => { if (active) active.abort(); else close(); });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const ch of chunk) {
    if (ch === '\x03') { active?.abort(); buffer = ''; }
    else if (ch === '\r' || ch === '\n') { const line = buffer; buffer = ''; receive(line); }
    else {
      buffer += ch;
      if (buffer.length > 4 * 1024 * 1024) { output.error('Antigravity input frame exceeds limit\n'); close(); break; }
    }
  }
});
process.stdin.on('end', close);
process.stdin.resume();
if (nativeSessionId) output.marker('thread', { threadId: nativeSessionId });
output.line('Antigravity ACP runner ready.');
output.line('›');
