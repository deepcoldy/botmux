import type { HookAskAdapter } from './types.js';
import claude from './claude-code.js';
import codex from './codex.js';
import opencode from './opencode.js';

const REGISTRY: Record<string, HookAskAdapter> = {
  'claude-code': claude,
  codex,
  opencode,
};

export function getHookAdapter(cliId: string): HookAskAdapter | undefined {
  return REGISTRY[cliId];
}
