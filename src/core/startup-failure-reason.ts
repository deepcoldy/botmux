import { basename } from 'node:path';

const EXEC_FAILURE_PREFIX = 'Command failed: ';
const MAX_STDERR_LINES = 5;
const MAX_STDERR_CHARS = 600;

/**
 * The chat-facing text of a fatal worker error.
 *
 * execFileSync / execSync failures read "Command failed: <file> <every
 * argument>\n<stderr>" (Node and Bun alike), and the worker forwards its fatal
 * error message into the chat as the startup-failure reason. A launch command
 * carries prompts, env names and values, PATH — so keep only what failed (the
 * program, its exit status, the tail of its stderr). Anything else passes
 * through unchanged; the caller logs the original locally.
 */
export function chatSafeFatalErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.startsWith(EXEC_FAILURE_PREFIX)) return message;
  const program = basename(message.slice(EXEC_FAILURE_PREFIX.length).split(/\s/, 1)[0] ?? '') || 'command';
  const status = (err as { status?: unknown } | null)?.status;
  let stderr = String((err as { stderr?: unknown } | null)?.stderr ?? '')
    .split('\n').map(line => line.trim()).filter(Boolean).slice(-MAX_STDERR_LINES).join('\n');
  if (stderr.length > MAX_STDERR_CHARS) stderr = `…${stderr.slice(-MAX_STDERR_CHARS)}`;
  return `${program} 执行失败${typeof status === 'number' ? `（退出码 ${status}）` : ''}，完整命令只写入本机日志`
    + (stderr ? `：\n${stderr}` : '');
}
