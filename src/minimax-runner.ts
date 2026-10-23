#!/usr/bin/env node
/** Long-lived Botmux stdin bridge around MiniMax Code's native ACP sessions.
 * No latest-session lookup, shell-interpolated prompts, or mmx compatibility. */
import { delimiter, dirname, resolve } from 'node:path';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import { MinimaxTurnBudget, parseMinimaxTurnTimeout } from './services/minimax-turn-budget.js';
import { runMcodeExec } from './services/mcode-exec.js';
import { runMinimaxAcp } from './services/minimax-acp.js';
import { bridgeMinimaxForm, bridgeMinimaxPermission } from './services/minimax-user-input.js';

const output = new RunnerControlWriter();
const values = new Map<string, string>();
// CLI dispatch keeps the hidden token in argv when re-execing a standalone binary.
const argOffset = process.argv[2] === '__minimax-runner' ? 3 : 2;
for (let i = argOffset; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--mcode-bin', '--node-bin', '--data-dir', '--cwd', '--native-session-id', '--model', '--effort', '--permission', '--turn-timeout-ms', '--transport'].includes(key) || value === undefined) {
    output.error('Invalid minimax runner arguments\n'); process.exit(2);
  }
  values.set(key, value);
}
const executable = values.get('--mcode-bin');
const permission = values.get('--permission') ?? 'full';
let timeoutMs: number | undefined;
try { timeoutMs = parseMinimaxTurnTimeout(values.get('--turn-timeout-ms')); }
catch { output.error('minimax runner: invalid --turn-timeout-ms (expected an integer from 1 to 2147483647)\n'); process.exit(2); }
const transport = values.get('--transport') ?? 'acp';
if (!executable || !['acp', 'exec'].includes(transport) || !['full', 'smart'].includes(permission)) {
  output.error('minimax runner: missing --mcode-bin or invalid --permission/--transport\n'); process.exit(2);
}
const cwd = resolve(values.get('--cwd') ?? process.cwd());
// npm's executable uses /usr/bin/env node. Its host PATH entry may be a symlink
// under /run, absent inside bwrap; use the same canonical runtime the adapter
// declared as an executable bind. Official launchers supply their own runtime.
const nativeEnv: NodeJS.ProcessEnv = { ...process.env,
  ...(values.has('--data-dir') ? { MINIMAX_DATA_DIR: values.get('--data-dir') } : {}),
  ...(values.has('--node-bin') ? { PATH: [dirname(values.get('--node-bin')!), process.env.PATH ?? ''].join(delimiter) } : {}),
};
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
      const budget = new MinimaxTurnBudget(timeoutMs, () => controller.abort('turn_budget_exhausted'));
      output.line('[MiniMax Code] running…');
      const streamedItems = new Set<string>();
      try {
        const common = { executable: executable!, cwd, env: nativeEnv,
          content: turn.content, nativeSessionId, model: values.get('--model'), effort: values.get('--effort'),
          permission: permission as 'full' | 'smart', timeoutMs };
        const result = transport === 'acp' ? await runMinimaxAcp({ ...common,
          onSession(sessionId) {
            if (nativeSessionId === sessionId) return;
            nativeSessionId = sessionId;
            output.marker('thread', { threadId: sessionId });
          },
          onInteractionPending: waiting => {
            if (controller.signal.aborted || closing) budget.dispose();
            else budget.waitingForHuman(waiting);
          },
          onUserInput(method, params, signal) {
            const context = { sessionId: nativeEnv.BOTMUX_SESSION_ID ?? '',
              larkAppId: nativeEnv.BOTMUX_LARK_APP_ID ?? '', chatId: nativeEnv.BOTMUX_CHAT_ID ?? '',
              rootMessageId: nativeEnv.BOTMUX_ROOT_MESSAGE_ID, originTurnId: turn.turnId, env: nativeEnv };
            return method === 'elicitation/create' ? bridgeMinimaxForm(context, params, signal)
              : bridgeMinimaxPermission(context, params, signal);
          },
          onUpdate(update) {
            if (update.sessionUpdate === 'agent_message_chunk') displayText(update.content.text);
            else if (update.sessionUpdate === 'tool_call') {
              finishDisplay(); displayText(`[tool] ${update.title ?? 'tool'}`); finishDisplay();
            }
          },
        }, controller.signal) : await runMcodeExec({ ...common,
          onEvent(event: Record<string, any>) {
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
          const errorCode = controller.signal.reason === 'turn_budget_exhausted' ? 'turn_budget_exhausted'
            : controller.signal.aborted ? 'cancelled' : 'execution_failed';
          const message = errorCode === 'turn_budget_exhausted'
            ? `MiniMax Code 单轮总预算已耗尽（${timeoutMs}ms）。模型输出和工具进度不会重置此预算；可在机器人设置中调大或清空单轮总预算后重新拉起会话。`
            : controller.signal.aborted ? 'MiniMax Code 本轮执行已中断。'
            : `MiniMax Code 执行失败：${error instanceof Error ? error.message : String(error)}`;
          finishDisplay(); displayText(message); finishDisplay();
          output.marker('final', { content: message, errorCode, ...(turn.turnId ? { turnId: turn.turnId } : {}),
            startedAtMs, completedAtMs: Date.now() });
        }
      } finally {
        budget.dispose(); active = undefined;
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
output.line(`MiniMax Code runner ready (mcode ${transport === 'acp' ? 'ACP' : 'exec stream-json'}).`);
prompt();
