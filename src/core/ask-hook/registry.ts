import type { HookAskAdapter } from './types.js';
import claude from './claude-code.js';
import codex from './codex.js';
import opencode from './opencode.js';
import coco from './coco.js';

const REGISTRY: Record<string, HookAskAdapter> = {
  'claude-code': claude,
  // Seed CLI is a Claude Code fork — identical AskUserQuestion hook payload,
  // so it reuses the claude hook adapter (the `botmux hook seed` command's
  // payload parses the same way).
  seed: claude,
  // Relay is the current release name of the Seed fork — same Claude-compatible
  // AskUserQuestion hook payload, so `botmux hook relay` reuses the claude adapter.
  relay: claude,
  codex,
  opencode,
  // opencode2 的 V2 插件在插件内把新事件流 payload 规范成与 V1 插件相同的
  // `{ hook_event_name: 'question.asked', question_id, session_id, tool_input }`
  // 形状再喂 `botmux hook opencode2`，所以复用同一个解析/作答适配器。
  opencode2: opencode,
  // CoCo (Trae CLI): AskUserQuestion payload is Claude-compatible (parseQuestions
  // reuses claude), but it CANNOT be answered via a hook directive — the answer
  // is delivered by keystroke-driving CoCo's native picker (see coco.ts +
  // daemon /api/asks coco branch + worker driveCocoPicker).
  coco,
};

export function getHookAdapter(cliId: string): HookAskAdapter | undefined {
  return REGISTRY[cliId];
}
