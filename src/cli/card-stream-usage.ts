import type { CliId } from '../adapters/cli/types.js';
import {
  getSessionUsageSnapshot,
  type SessionUsageSnapshot,
  type SessionTokenUsageQuery,
} from '../core/cost-calculator.js';
import type { CardStreamUsageSnapshot } from './card-stream-dispatch.js';

export interface CardStreamUsageSession {
  sessionId: string;
  cliId?: string;
  cliSessionId?: string;
  workingDir?: string;
  adoptedFrom?: { cliId?: string; sessionId?: string; cwd?: string };
}

/**
 * Read native cumulative usage for an explicitly-authorized custom CardKit
 * stream. This is intentionally independent from `usageDisplay`: that setting
 * controls Botmux's built-in reply/control cards, while `card stream snapshot`
 * is an opt-in capability consumed by the custom card that owns the stream.
 */
export function readCardStreamUsageSnapshot(
  session: CardStreamUsageSession,
  larkAppId: string,
  reader: (query: SessionTokenUsageQuery) => SessionUsageSnapshot = getSessionUsageSnapshot,
): CardStreamUsageSnapshot | null {
  const snapshot = reader({
    cliId: (session.cliId ?? session.adoptedFrom?.cliId ?? 'unknown') as CliId | 'unknown',
    sessionId: session.sessionId,
    cliSessionId: session.cliSessionId ?? session.adoptedFrom?.sessionId,
    cwd: session.workingDir ?? session.adoptedFrom?.cwd,
    larkAppId,
    fresh: true,
  });
  const usage = snapshot.tokens;
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreateTokens: usage.cacheCreateTokens,
    totalTokens: usage.inputTokens + usage.outputTokens
      + usage.cacheReadTokens + usage.cacheCreateTokens,
  };
}
