import { collectNativePrint } from './constrained-invocation/print-process.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';

export interface McodeExecOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  content: string;
  nativeSessionId?: string;
  model?: string;
  effort?: string;
  permission: 'full' | 'smart';
  timeoutMs: number;
  onEvent?: (event: Record<string, any>) => void;
}

export interface McodeExecResult {
  sessionId: string;
  content: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number };
}

/** Official v1 stream-json contract. Only exec.completed's result is a final
 * answer; item/turn completion and a clean process exit alone are insufficient. */
export async function runMcodeExec(opts: McodeExecOptions, signal: AbortSignal): Promise<McodeExecResult> {
  const args = ['exec', '--input', '-', '--cwd', opts.cwd, '--output-format', 'stream-json',
    '--permission', opts.permission, '--timeout', `${opts.timeoutMs}ms`];
  if (opts.nativeSessionId) args.push('--session', opts.nativeSessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  const env = { ...opts.env };
  applySessionOwnerEnv(env, opts.env.BOTMUX_OWNER_OPEN_ID);
  let sessionId: string | undefined;
  let runId: string | undefined;
  let turnId: string | undefined;
  let sequence = 0;
  let result: Record<string, any> | undefined;
  try {
    await collectNativePrint(opts.executable, args, { cwd: opts.cwd, env, input: opts.content, onLine(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || event.schemaVersion !== 1
        || !Number.isSafeInteger(event.sequence) || event.sequence <= sequence
        || typeof event.type !== 'string' || typeof event.sessionId !== 'string' || !event.sessionId
        || typeof event.runId !== 'string' || !event.runId || typeof event.turnId !== 'string' || !event.turnId
        || result) throw new Error('mcode_protocol_invalid');
      if (opts.nativeSessionId && event.sessionId !== opts.nativeSessionId) throw new Error('mcode_session_mismatch');
      if (sessionId && (event.sessionId !== sessionId || event.runId !== runId || event.turnId !== turnId)) throw new Error('mcode_run_mismatch');
      sessionId = event.sessionId; runId = event.runId; turnId = event.turnId; sequence = event.sequence;
      if (event.type === 'exec.completed') {
        result = event.result;
        if (!result || result.schemaVersion !== 1 || result.type !== 'exec.result'
          || result.sessionId !== sessionId || result.runId !== runId || result.turnId !== turnId) throw new Error('mcode_protocol_invalid');
      }
      opts.onEvent?.(event);
    } }, signal);
  } catch (error) {
    // Keep the native actionable error (login, pending interaction, etc.), but
    // never turn a nonzero exit into a success even if it printed a result.
    if (result?.status !== 'succeeded' && typeof result?.error?.message === 'string') {
      throw new Error(`mcode: ${result.error.message}`);
    }
    throw error;
  }
  if (!result || result.status !== 'succeeded' || typeof result.output !== 'string') throw new Error('mcode_inference_incomplete');
  const raw = result.usage;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const usage = raw && valid(raw.inputTokens) && valid(raw.outputTokens)
    && valid(raw.cacheReadTokens ?? 0) && valid(raw.cacheWriteTokens ?? 0)
    // Runner final usage has four mutually exclusive buckets. Keep native
    // fresh input unchanged; model-only invocation usage uses inclusive input.
    ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens,
      cacheReadTokens: raw.cacheReadTokens ?? 0, cacheCreateTokens: raw.cacheWriteTokens ?? 0 }
    : undefined;
  return { sessionId: result.sessionId, content: result.output, ...(usage ? { usage } : {}) };
}
