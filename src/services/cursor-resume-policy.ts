import type { CliId } from '../adapters/cli/types.js';

export function shouldObserveCursorChatId(opts: {
  cliId?: CliId | string;
  effectiveResume: boolean;
  effectiveCliSessionId?: string;
}): boolean {
  if (opts.cliId !== 'cursor') return false;
  // cursor's buildArgs never emits `--continue` (removed as a cross-session
  // leak hazard — it resumed the globally most recent chat, which is shared
  // across botmux sessions of this bot). So every launch is either fresh or a
  // precise `--resume <id>` — both safe to observe. In particular,
  // resume=true WITHOUT a cliSessionId now falls back to a FRESH launch, and
  // observing there captures the new chat id that would otherwise stay
  // uncaptured (the old policy blocked it for the --continue era, leaving the
  // session permanently without a persisted id).
  return true;
}

export function shouldPersistObservedCursorChatId(opts: {
  effectiveResume: boolean;
  effectiveCliSessionId?: string;
  observedChatId: string;
}): boolean {
  if (!opts.observedChatId) return false;
  if (!opts.effectiveResume) return true;
  // resume=true without a cliSessionId: the adapter started FRESH (no
  // --continue fallback), so the observed id is this session's own new chat
  // id — persist it. Previously blocked because --continue resumed a foreign
  // session whose id must not be captured; that hazard is gone.
  if (!opts.effectiveCliSessionId) return true;
  return opts.effectiveCliSessionId === opts.observedChatId;
}
