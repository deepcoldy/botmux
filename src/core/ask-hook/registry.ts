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
  codex,
  opencode,
  // CoCo (Trae CLI): AskUserQuestion payload is Claude-compatible (parseQuestions
  // reuses claude), but it CANNOT be answered via a hook directive — the answer
  // is delivered by keystroke-driving CoCo's native picker (see coco.ts +
  // daemon /api/asks coco branch + worker driveCocoPicker).
  coco,
};

export function getHookAdapter(cliId: string): HookAskAdapter | undefined {
  return REGISTRY[cliId];
}
