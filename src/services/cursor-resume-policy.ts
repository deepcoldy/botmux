import type { CliId } from '../adapters/cli/types.js';

export function shouldObserveCursorChatId(opts: {
  cliId?: CliId | string;
  effectiveResume: boolean;
  effectiveCliSessionId?: string;
}): boolean {
  if (opts.cliId !== 'cursor') return false;
  if (!opts.effectiveResume) return true;
  return !!opts.effectiveCliSessionId;
}

export function shouldPersistObservedCursorChatId(opts: {
  effectiveResume: boolean;
  effectiveCliSessionId?: string;
  observedChatId: string;
}): boolean {
  if (!opts.observedChatId) return false;
  if (!opts.effectiveResume) return true;
  return opts.effectiveCliSessionId === opts.observedChatId;
}
