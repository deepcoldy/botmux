#!/usr/bin/env node
/** Long-lived Botmux framed stdin bridge around AtomCode's native ACP sessions. */
import { resolve } from 'node:path';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import { MinimaxTurnBudget, parseMinimaxTurnTimeout } from './services/minimax-turn-budget.js';
import { writeMinimaxFinal } from './services/minimax-final-control.js';
import { runAtomcodeAcp } from './services/atomcode-acp.js';
import { bridgeAtomcodeForm, bridgeAtomcodePermission } from './services/atomcode-user-input.js';

const FRAME_PREFIX = '::botmux-atomcode:';
const output = new RunnerControlWriter();
const values = new Map<string, string>();
// CLI dispatch keeps the hidden token in argv when re-execing a standalone binary.
const argOffset = process.argv[2] === '__atomcode-runner' ? 3 : 2;
for (let i = argOffset; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (![
    '--atomcode-bin',
    '--data-dir',
    '--cwd',
    '--native-session-id',
    '--model',
    '--effort',
    '--permission',
    '--turn-timeout-ms',
  ].includes(key) || value === undefined) {
    output.error('Invalid atomcode runner arguments\n');
    process.exit(2);
  }
  values.set(key, value);
}

const executable = values.get('--atomcode-bin');
const permission = values.get('--permission') ?? 'full';
let timeoutMs: number | undefined;
try {
  timeoutMs = parseMinimaxTurnTimeout(values.get('--turn-timeout-ms'));
} catch {
  output.error('atomcode runner: invalid --turn-timeout-ms (expected an integer from 1 to 2147483647)\n');
  process.exit(2);
}
if (!executable || !['full', 'smart'].includes(permission)) {
  output.error('atomcode runner: missing --atomcode-bin or invalid --permission\n');
  process.exit(2);
}

const cwd = resolve(values.get('--cwd') ?? process.cwd());
const nativeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...(values.has('--data-dir') ? { ATOMCODE_HOME: values.get('--data-dir') } : {}),
};

let nativeSessionId = values.get('--native-session-id');
let active: AbortController | undefined;
let closing = false;
let processing = false;
let buffer = '';
const queue: Array<{ content: string; turnId?: string; dispatchAttempt?: number }> = [];
const prompt = () => output.line('›');
let displayLineStart = true;

// Prefix every displayed line and strip control bytes so model text can neither clear readyPattern nor forge OSC frames.
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
      output.line('[AtomCode] running…');
      try {
        const result = await runAtomcodeAcp({
          executable: executable!,
          cwd,
          env: nativeEnv,
          content: turn.content,
          nativeSessionId,
          model: values.get('--model'),
          effort: values.get('--effort'),
          permission: permission as 'full' | 'smart',
          onSession(sessionId) {
            // Publish immediately so a mid-turn runner crash still preserves this session for resume.
            if (nativeSessionId === sessionId) return;
            nativeSessionId = sessionId;
            output.marker('thread', { threadId: sessionId });
          },
          onInteractionPending: waiting => {
            if (controller.signal.aborted || closing) budget.dispose();
            else budget.waitingForHuman(waiting);
          },
          onUserInput(method, params, signal) {
            const context = {
              sessionId: nativeEnv.BOTMUX_SESSION_ID ?? '',
              larkAppId: nativeEnv.BOTMUX_LARK_APP_ID ?? '',
              chatId: nativeEnv.BOTMUX_CHAT_ID ?? '',
              rootMessageId: nativeEnv.BOTMUX_ROOT_MESSAGE_ID,
              originTurnId: turn.turnId,
              env: nativeEnv,
            };
            return method === 'elicitation/create'
              ? bridgeAtomcodeForm(context, params, signal)
              : bridgeAtomcodePermission(context, params, signal);
          },
          onUpdate(update) {
            if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
              displayText(update.content.text);
            } else if (update.sessionUpdate === 'tool_call') {
              finishDisplay();
              displayText(`[tool] ${update.title ?? 'tool'}`);
              finishDisplay();
            }
          },
        }, controller.signal);
        if (!closing) {
          writeMinimaxFinal(output, {
            content: result.content,
            ...(turn.turnId ? { turnId: turn.turnId } : {}),
            ...(turn.dispatchAttempt !== undefined ? { dispatchAttempt: turn.dispatchAttempt } : {}),
            startedAtMs,
            completedAtMs: Date.now(),
          });
        }
      } catch (error) {
        if (!closing) {
          const errorCode = controller.signal.reason === 'turn_budget_exhausted'
            ? 'turn_budget_exhausted'
            : controller.signal.aborted
              ? 'cancelled'
              : 'execution_failed';
          const message = errorCode === 'turn_budget_exhausted'
            ? `AtomCode 单轮总预算已耗尽（${timeoutMs}ms）。模型输出和工具进度不会重置此预算；可在机器人设置中调大或清空单轮总预算后重新拉起会话。`
            : controller.signal.aborted
              ? 'AtomCode 本轮执行已中断。'
              : `AtomCode 执行失败：${(error instanceof Error ? error.message : String(error)).slice(0, 16_384)}`;
          finishDisplay();
          displayText(message);
          finishDisplay();
          writeMinimaxFinal(output, {
            content: message,
            errorCode,
            ...(turn.turnId ? { turnId: turn.turnId } : {}),
            ...(turn.dispatchAttempt !== undefined ? { dispatchAttempt: turn.dispatchAttempt } : {}),
            startedAtMs,
            completedAtMs: Date.now(),
          });
        }
      } finally {
        budget.dispose();
        active = undefined;
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
  if (!line.startsWith(FRAME_PREFIX)) {
    output.line('[AtomCode] ignoring non-frame input');
    return;
  }
  try {
    const value = JSON.parse(Buffer.from(line.slice(FRAME_PREFIX.length), 'base64').toString('utf8'));
    if (value?.type !== 'message' || typeof value.content !== 'string') throw new Error('invalid frame');
    queue.push({
      content: value.content,
      ...(typeof value.replyTurnId === 'string' ? { turnId: value.replyTurnId } : {}),
      ...(typeof value.replyDispatchAttempt === 'number' ? { dispatchAttempt: value.replyDispatchAttempt } : {}),
    });
    void drain();
  } catch {
    output.line('[AtomCode] invalid input frame');
  }
}

function close(): void {
  closing = true;
  queue.length = 0;
  active?.abort();
  if (!processing) process.exit(0);
}

process.on('SIGTERM', close);
process.on('SIGHUP', close);
process.on('SIGINT', () => {
  if (active) active.abort();
  else close();
});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data: string) => {
  for (const ch of data) {
    if (ch === '\x03') {
      active?.abort();
      buffer = '';
    } else if (ch === '\r' || ch === '\n') {
      const line = buffer;
      buffer = '';
      receiveLine(line);
    } else if (ch === '\x7f' || ch === '\b') {
      buffer = buffer.slice(0, -1);
    } else {
      buffer += ch;
      if (buffer.length > 4 * 1024 * 1024) {
        output.error('AtomCode input frame exceeds limit\n');
        close();
        break;
      }
    }
  }
});
process.stdin.on('end', close);
process.stdin.resume();

if (nativeSessionId) output.marker('thread', { threadId: nativeSessionId });
output.line('AtomCode runner ready (atomcode ACP).');
prompt();
