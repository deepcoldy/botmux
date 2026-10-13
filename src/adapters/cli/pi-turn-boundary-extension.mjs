/**
 * Pi 回合边界与系统提示词扩展的运行时真源：纯 JS、自包含，由外部 pi 进程直接加载。
 *
 * 1. 监听 session_start、agent_end、agent_settled 事件，写入回合边界自定义 marker；
 * 2. 监听 before_agent_start 事件，在 Pi 原生完成资源加载与项目信任决策后，追加 Botmux 系统提示词。
 */
import { existsSync, readFileSync } from 'node:fs';

export const PI_TURN_BOUNDARY_CUSTOM_TYPE = 'botmux-turn-settled';
export const PI_TURN_BOUNDARY_STOP_REASON_ERROR = 'error';

export function lastAssistantStopReason(event) {
  const messages = event?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    return typeof message.stopReason === 'string' ? message.stopReason : undefined;
  }
  return undefined;
}

export default function registerBotmuxTurnBoundaryExtension(pi) {
  pi.on('session_start', () => {
    try {
      pi.appendEntry(PI_TURN_BOUNDARY_CUSTOM_TYPE, { lastStopReason: null });
    } catch { /* ignore */ }
  });

  let lastStopReason;

  pi.on('agent_end', (event) => {
    const stopReason = lastAssistantStopReason(event);
    if (stopReason !== undefined) lastStopReason = stopReason;
  });

  pi.on('agent_settled', () => {
    const data = { lastStopReason: lastStopReason ?? null };
    lastStopReason = undefined;
    try {
      pi.appendEntry(PI_TURN_BOUNDARY_CUSTOM_TYPE, data);
    } catch { /* ignore */ }
  });

  pi.on('before_agent_start', (event) => {
    let prompt = process.env.BOTMUX_APPEND_SYSTEM_PROMPT;
    const promptFile = process.env.BOTMUX_APPEND_SYSTEM_PROMPT_FILE;
    if (!prompt && promptFile && existsSync(promptFile)) {
      try {
        prompt = readFileSync(promptFile, 'utf-8');
      } catch { /* ignore */ }
    }
    if (!prompt) return;
    const current = event?.systemPrompt;
    if (Array.isArray(current)) {
      return {
        systemPrompt: [...current, prompt],
      };
    }
    return {
      systemPrompt: current ? `${current}\n\n${prompt}` : prompt,
    };
  });
}
