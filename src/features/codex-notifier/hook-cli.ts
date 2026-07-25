import type { Readable } from 'node:stream';
import { resolveBotmuxDataDir } from '../../core/data-dir.js';
import { createCodexNotifierEvent } from './event.js';
import { readCodexTurnContext, type CodexTurnContext } from './codex-context.js';
import { resolveCodexNotifierConfig, type ResolvedCodexNotifierConfig } from './config.js';
import { enqueueCodexNotifierEvent } from './outbox.js';
import { detectScreenLock, shouldNotifyForLockState, type ScreenLockState } from './screen-lock.js';
import {
  confirmCodexNotifierTurn,
  readConfirmedCodexNotifierTurn,
  removeConfirmedCodexNotifierTurn,
  type ConfirmedCodexTurn,
} from './confirmed-turn.js';
import { isInternalCodexPrompt } from './internal-turn.js';

const MAX_STDIN_BYTES = 1024 * 1024;

export type CodexNotifierHookOutcome =
  | 'enqueued'
  | 'disabled'
  | 'misconfigured'
  | 'managed'
  | 'tracked'
  | 'subagent'
  | 'internal'
  | 'unsupported'
  | 'screen_unlocked'
  | 'platform_unsupported';

export interface CodexNotifierHookDeps {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  config?: ResolvedCodexNotifierConfig;
  lockState?: ScreenLockState;
  readContext?: (transcriptPath: unknown, turnId: unknown, sessionId: unknown) => CodexTurnContext;
  enqueue?: typeof enqueueCodexNotifierEvent;
  confirmTurn?: typeof confirmCodexNotifierTurn;
  readConfirmedTurn?: typeof readConfirmedCodexNotifierTurn;
  removeConfirmedTurn?: typeof removeConfirmedCodexNotifierTurn;
}

function isCodexAmbientSuggestionTurn(
  context: CodexTurnContext,
  lastAssistantMessage: unknown,
): boolean {
  const prompt = context.prompt?.toLowerCase();
  if (
    prompt?.includes('generate 0 to 3 hyperpersonalized suggestions for what this user can do with codex')
    || prompt?.includes('upholding safety and compliance standards for codex ambient suggestions')
  ) {
    return true;
  }

  // Codex 的临时推荐线程当前不落 transcript，只能从其固定 JSON 结果识别。
  // 已提取到真实用户问题时不能只凭回复形状过滤，避免误伤用户主动请求。
  if (context.prompt || typeof lastAssistantMessage !== 'string') return false;
  try {
    const parsed = JSON.parse(lastAssistantMessage);
    return parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Object.keys(parsed).length === 1
      && Array.isArray(parsed.suggestions);
  } catch {
    return false;
  }
}

/** 处理一个 Codex 通知 Hook payload；所有跳过原因都显式返回，便于 Dashboard/测试诊断。 */
export function processCodexNotifierHookPayload(
  payload: Record<string, unknown>,
  deps: CodexNotifierHookDeps = {},
): CodexNotifierHookOutcome {
  const env = deps.env ?? process.env;
  if (env.BOTMUX_SESSION_ID?.trim()) return 'managed';
  const eventName = payload.hook_event_name;
  const dataDir = deps.dataDir ?? resolveBotmuxDataDir();
  const removeConfirmedTurn = deps.removeConfirmedTurn ?? removeConfirmedCodexNotifierTurn;
  const discardConfirmedTurn = (): void => {
    if (eventName === 'Stop') {
      removeConfirmedTurn(dataDir, payload.session_id, payload.turn_id);
    }
  };
  const config = deps.config ?? resolveCodexNotifierConfig();
  if (!config.enabled) {
    discardConfirmedTurn();
    return 'disabled';
  }
  if (!config.targetBotAppId) {
    discardConfirmedTurn();
    return 'misconfigured';
  }

  if (
    typeof payload.agent_id === 'string'
    && payload.agent_id.trim()
    && payload.agent_id !== payload.session_id
  ) {
    discardConfirmedTurn();
    return 'subagent';
  }

  const readContext = deps.readContext ?? readCodexTurnContext;
  if (eventName === 'UserPromptSubmit') {
    const context = readContext(payload.transcript_path, payload.turn_id, payload.session_id);
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : context.prompt;
    if (context.internal || isInternalCodexPrompt(prompt)) return 'internal';
    const confirmTurn = deps.confirmTurn ?? confirmCodexNotifierTurn;
    return confirmTurn(dataDir, payload.session_id, payload.turn_id, prompt) ? 'tracked' : 'internal';
  }
  if (eventName !== 'Stop') return 'unsupported';

  const lockState = deps.lockState ?? detectScreenLock();
  if (lockState === 'unsupported' && config.notifyWhen === 'locked_only') {
    discardConfirmedTurn();
    return 'platform_unsupported';
  }
  if (!shouldNotifyForLockState(config.notifyWhen, lockState)) {
    discardConfirmedTurn();
    return 'screen_unlocked';
  }

  const context = readContext(payload.transcript_path, payload.turn_id, payload.session_id);
  const readConfirmedTurn = deps.readConfirmedTurn ?? readConfirmedCodexNotifierTurn;
  const confirmed: ConfirmedCodexTurn | undefined = readConfirmedTurn(
    dataDir,
    payload.session_id,
    payload.turn_id,
  );
  const prompt = context.prompt ?? confirmed?.prompt;
  if (
    context.internal
    || isInternalCodexPrompt(prompt)
    || isCodexAmbientSuggestionTurn(context, payload.last_assistant_message)
    || !prompt
  ) {
    discardConfirmedTurn();
    return 'internal';
  }
  const event = createCodexNotifierEvent(payload, {
    clientSurface: context.clientSurface,
    // title 只保存用户问题；卡片层统一拼接项目名，避免 project 重复。
    title: prompt,
    finalPreview: typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()
      ? payload.last_assistant_message
      : context.lastAssistantMessage,
  });
  const enqueue = deps.enqueue ?? enqueueCodexNotifierEvent;
  enqueue(dataDir, config.targetBotAppId, event);
  discardConfirmedTurn();
  return 'enqueued';
}

async function readStdinJson(stream: Readable): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of stream) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > MAX_STDIN_BYTES) throw new Error('hook_payload_too_large');
  }
  if (!text.trim()) throw new Error('hook_payload_empty');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hook_payload_invalid');
  return parsed as Record<string, unknown>;
}

/** CLI Hook 不得阻塞 Codex 流程；失败只在 DEBUG 下输出诊断并返回。 */
export async function runCodexNotifierHookCli(
  stream: Readable = process.stdin,
  deps: CodexNotifierHookDeps = {},
): Promise<CodexNotifierHookOutcome | 'error'> {
  try {
    return processCodexNotifierHookPayload(await readStdinJson(stream), deps);
  } catch (error) {
    if (process.env.DEBUG === '1') {
      process.stderr.write(`[codex-notifier] hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 'error';
  }
}
