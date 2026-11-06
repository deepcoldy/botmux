import { spawn } from 'node:child_process';
import type { FeedbackHookRegistration } from './feedback-extension-types.js';
import { normalizeFeedbackHook } from './feedback-hook-config.js';

export interface HookEvent {
  schemaVersion: 1;
  executionId: string;
  eventId: string;
  idempotencyKey: string;
  type: 'action.requested' | 'feedback.revised';
  bot: { appId: string };
  scope: { chatId: string; topicId?: unknown; sourceMessageId?: unknown; subjectId?: unknown };
  action: { id: string } | null;
  [key: string]: unknown;
}
export interface HookResult {
  schemaVersion: 1;
  executionId: string;
  outcome: 'succeeded' | 'blocked' | 'failed_before_effect' | 'unknown';
  publicMessage: string;
  receiptRefs: string[];
}

export async function runFeedbackHook(input: {
  hook: FeedbackHookRegistration; event: HookEvent; hostId: string; env: Record<string, string>;
}): Promise<HookResult> {
  const hook = normalizeFeedbackHook(input.hook);
  const result = (outcome: HookResult['outcome'], publicMessage: string): HookResult =>
    ({ schemaVersion: 1, executionId: input.event.executionId, outcome, publicMessage, receiptRefs: [] });
  if (!hook.enabled || hook.hostId !== input.hostId || !hook.allowedBotAppIds.includes(input.event.bot.appId)
    || !hook.allowedChatIds.includes(input.event.scope.chatId)
    || (input.event.action !== null && !hook.allowedActionIds.includes(input.event.action.id))) {
    return result('blocked', 'Hook is disabled or outside its authorized scope');
  }
  if (Object.keys(input.env).some(name => !(name in hook.envRefs))) return result('blocked', 'Unexpected environment variable');
  if (Object.values(input.env).some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 8192)
    || Buffer.byteLength(JSON.stringify(input.env)) > 32768) return result('failed_before_effect', 'Hook environment is invalid');
  const data = JSON.stringify(input.event);
  if (Buffer.byteLength(data) > 65536) return result('blocked', 'Hook input is too large');
  return new Promise(resolve => {
    let started = false;
    let finished = false;
    let stdout = '';
    let outputBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: HookResult) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.command[0], hook.command.slice(1), {
        cwd: hook.cwd, shell: false, detached: process.platform !== 'win32', env: { ...input.env }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { finish(result('failed_before_effect', 'Hook process could not start')); return; }
    const terminate = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    child.once('spawn', () => { started = true; });
    child.once('error', () => finish(result(started ? 'unknown' : 'failed_before_effect', 'Hook process failed')));
    const consume = (chunk: Buffer, capture: boolean) => {
      outputBytes += chunk.length;
      if (outputBytes > 65536) {
        terminate();
        finish(result('unknown', 'Hook output exceeded its limit'));
      } else if (capture) stdout += chunk.toString('utf8');
    };
    child.stdout!.on('data', chunk => consume(chunk, true));
    child.stderr!.on('data', chunk => consume(chunk, false));
    child.stdin!.on('error', () => {});
    child.once('close', code => {
      if (code !== 0) return finish(result('unknown', 'Hook did not finish successfully'));
      try {
        const parsed = JSON.parse(stdout) as HookResult;
        if (!parsed || parsed.schemaVersion !== 1 || parsed.executionId !== input.event.executionId
          || !['succeeded', 'blocked', 'failed_before_effect', 'unknown'].includes(parsed.outcome)
          || typeof parsed.publicMessage !== 'string' || parsed.publicMessage.length > 500
          || !Array.isArray(parsed.receiptRefs) || parsed.receiptRefs.length > 20
          || parsed.receiptRefs.some(reference => typeof reference !== 'string' || !/^[a-z][a-z0-9_-]*:[a-zA-Z0-9_-]{1,256}$/.test(reference))
          || (parsed.outcome === 'succeeded' && !parsed.receiptRefs.length)) throw new Error('invalid_result');
        finish({ schemaVersion: 1, executionId: parsed.executionId, outcome: parsed.outcome,
          publicMessage: parsed.publicMessage.replace(/[<>&]/g, ''), receiptRefs: parsed.receiptRefs });
      } catch { finish(result('unknown', 'Hook result could not be verified')); }
    });
    timer = setTimeout(() => {
      terminate();
      finish(result('unknown', 'Hook exceeded its timeout'));
    }, hook.timeoutMs);
    child.stdin!.end(data);
  });
}
