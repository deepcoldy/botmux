/**
 * The exact three values the worker hands to `backend.spawn()`:
 * `env` (inherited + session env), `injectEnv` (per-bot `bots.json` env) and
 * `unsetEnv` (post-rcfile `env -u` removals for shell-wrapped backends).
 *
 * Extracted from `worker.ts` so the assembly — including the dsh-tui resume
 * markers scrub — is testable directly instead of only through a spawned
 * worker. All three products are derived from the SAME scope, which is what
 * keeps the two env layers and the pane removal list from drifting apart: a
 * marker dropped from one product but not the others still reaches the CLI
 * (pty merges `env`+`injectEnv`; tmux/zellij/zmx/herdr re-read the shell
 * environment after the worker's env object is gone).
 *
 * Pure: the inputs are never mutated.
 */
import { scrubDshTuiResumeEnv, dshTuiResumeEnvUnset, type DshTuiResumeEnvScope } from './dsh-tui-env.js';

export type ChildSpawnEnvScope = DshTuiResumeEnvScope;

export interface ChildSpawnEnvInput {
  /** Worker-composed base env (`buildSessionChildEnv` output, already mutated
   *  by the caller for session-owned values). */
  baseEnv: NodeJS.ProcessEnv;
  /** Per-bot `bots.json` env (`botInjectedEnv` output). */
  botEnv?: Record<string, string>;
  /** Session env overlay removals (`cfg.envUnset`). */
  envUnset?: readonly string[];
  scope: ChildSpawnEnvScope;
}

export interface ChildSpawnEnvPlan {
  childEnv: NodeJS.ProcessEnv;
  /** Undefined when nothing will be injected — same contract as before. */
  injectEnv?: Record<string, string>;
  /** Undefined when there is nothing to remove. */
  unsetEnv?: string[];
}

export function planChildSpawnEnv(input: ChildSpawnEnvInput): ChildSpawnEnvPlan {
  const childEnv = scrubDshTuiResumeEnv({ ...input.baseEnv }, input.scope);
  let injectEnv: Record<string, string> | undefined;
  if (input.botEnv) {
    const botEnv = scrubDshTuiResumeEnv({ ...input.botEnv }, input.scope);
    if (Object.keys(botEnv).length > 0) injectEnv = botEnv;
  }
  return {
    childEnv,
    injectEnv,
    unsetEnv: dshTuiResumeEnvUnset(input.scope, input.envUnset ? [...input.envUnset] : undefined),
  };
}
