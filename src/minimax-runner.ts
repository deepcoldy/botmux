#!/usr/bin/env node
/** Long-lived Botmux stdin bridge around MiniMax Code's native exec sessions.
 * No latest-session lookup, shell-interpolated prompts, or mmx compatibility. */
import { resolve } from 'node:path';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import { runMcodeExec } from './services/mcode-exec.js';

const output = new RunnerControlWriter();
const values = new Map<string, string>();
// CLI dispatch keeps the hidden token in argv when re-execing a standalone binary.
const argOffset = process.argv[2] === '__minimax-runner' ? 3 : 2;
for (let i = argOffset; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--mcode-bin', '--data-dir', '--cwd', '--native-session-id', '--model', '--effort', '--permission', '--turn-timeout-ms'].includes(key) || value === undefined) {
    output.error('Invalid minimax runner arguments\n'); process.exit(2);
  }
  values.set(key, value);
}
const executable = values.get('--mcode-bin');
const permission = values.get('--permission') ?? 'full';
const timeoutMs = Number(values.get('--turn-timeout-ms') ?? 600_000);
if (!executable || !['full', 'smart'].includes(permission) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  output.error('minimax runner requires --mcode-bin, a valid permission policy and timeout\n'); process.exit(2);
}
const cwd = resolve(values.get('--cwd') ?? process.cwd());
let nativeSessionId = values.get('--native-session-id');
let active: AbortController | undefined;
let closing = false;
let processing = false;
let buffer = '';
const queue: Array<{ content: string; turnId?: string }> = [];
const prompt = () => output.line('›');
let displayLineStart = true;
// Keep model text distinct from the standalone ready prompt, even across
// streamed chunks. No model/tool text can clear the static busy latch.
function displayText(text: string): void {
  for (const piece of text.replace(/\r/g, '').split(/(\n)/)) {
    if (!piece) continue;
    if (displayLineStart) output.display('│ ');
    output.display(piece.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ch => ch === '\x1b' ? '␛' : ''));
    displayLineStart = piece === '\n';
  }
}
function finishDisplay(): void {
  if (!displayLineStart) output.line();
  displayLineStart = true;
}

async function drain(): Promise<void> {
  if (processing || closing) return;
  processing = true;
  try {
    while (queue.length && !closing) {
      const turn = queue.shift()!;
      const startedAtMs = Date.now();
      const controller = new AbortController();
      active = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      output.line('[MiniMax Code] running…');
      const streamedItems = new Set<string>();
      try {
        const result = await runMcodeExec({ executable: executable!, cwd, env: { ...process.env, ...(values.has('--data-dir') ? { MINIMAX_DATA_DIR: values.get('--data-dir') } : {}) },
          content: turn.content, nativeSessionId, model: values.get('--model'), effort: values.get('--effort'),
          permission: permission as 'full' | 'smart', timeoutMs,
          onEvent(event) {
            // Publish the authoritative ID as soon as native execution starts,
            // so a runner death mid-turn still resumes THIS conversation.
            if (!nativeSessionId) {
              nativeSessionId = event.sessionId;
              output.marker('thread', { threadId: nativeSessionId });
            }
            const item = event.item;
            if (item?.type === 'agent_message') {
              if (typeof item.contentDelta === 'string') {
                streamedItems.add(item.id);
                displayText(item.contentDelta);
              } else if (event.type === 'item.completed' && typeof item.content === 'string') {
                if (!streamedItems.has(item.id)) displayText(item.content);
                finishDisplay();
              }
            } else if (item?.type === 'tool_call' && event.type === 'item.started') {
              finishDisplay();
              displayText(`[tool] ${item.toolCall?.name ?? 'tool'}`);
              finishDisplay();
            }
          },
        }, controller.signal);
        if (!closing) output.marker('final', { content: result.content, usage: result.usage,
          ...(turn.turnId ? { turnId: turn.turnId } : {}), startedAtMs, completedAtMs: Date.now() });
      } catch (error) {
        if (!closing) {
          const message = controller.signal.aborted ? 'MiniMax Code 执行已中断或超时。'
            : `MiniMax Code 执行失败：${error instanceof Error ? error.message : String(error)}`;
          finishDisplay(); displayText(message); finishDisplay();
          output.marker('final', { content: message, ...(turn.turnId ? { turnId: turn.turnId } : {}),
            startedAtMs, completedAtMs: Date.now() });
        }
      } finally {
        clearTimeout(timer); active = undefined;
      }
      finishDisplay();
      if (!closing) prompt();
    }
  } finally {
    processing = false;
    if (closing) process.exit(0);
  }
}

function receiveLine(line: string): void {
  if (!line.trim() || closing) return;
  if (!line.startsWith('::botmux-minimax:')) { output.line('[MiniMax Code] ignoring non-frame input'); return; }
  try {
    const value = JSON.parse(Buffer.from(line.slice('::botmux-minimax:'.length), 'base64').toString('utf8'));
    if (value?.type !== 'message' || typeof value.content !== 'string') throw new Error('invalid frame');
    queue.push({ content: value.content, ...(typeof value.replyTurnId === 'string' ? { turnId: value.replyTurnId } : {}) });
    void drain();
  } catch { output.line('[MiniMax Code] invalid input frame'); }
}

function close(): void {
  closing = true; queue.length = 0;
  active?.abort();
  if (!processing) process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGHUP', close);
process.on('SIGINT', () => { if (active) active.abort(); else close(); });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data: string) => {
  for (const ch of data) {
    if (ch === '\x03') { active?.abort(); buffer = ''; }
    else if (ch === '\r' || ch === '\n') { const line = buffer; buffer = ''; receiveLine(line); }
    else if (ch === '\x7f' || ch === '\b') buffer = buffer.slice(0, -1);
    else {
      buffer += ch;
      if (buffer.length > 4 * 1024 * 1024) { output.error('MiniMax input frame exceeds limit\n'); close(); break; }
    }
  }
});
process.stdin.on('end', close);
process.stdin.resume();
if (nativeSessionId) output.marker('thread', { threadId: nativeSessionId });
output.line('MiniMax Code runner ready (mcode exec stream-json).');
prompt();
