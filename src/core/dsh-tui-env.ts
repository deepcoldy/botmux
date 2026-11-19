/**
 * dsh-tui resume-marker hygiene.
 *
 * The dsh-tui launcher (`bin/dsh-tui`) turns `DSH_TUI_RESUME_SESSION` /
 * `DSH_TUI_RESUME_BACKEND` / `DSH_TUI_RESUME_RETRY` into "resume this native
 * session", and a BARE `--resume` additionally reads the machine-wide
 * `~/.dsh-tui/resume.txt` (the last session ANY process touched). Botmux only
 * ever expresses a precise resume (`--resume <id>`), so a spawn that ends up
 * starting a FRESH session must not carry those markers: one inherited from the
 * daemon env, a bot's `env`, a tmux/zellij/herdr server's global environment or
 * a shell rcfile would silently resume a conversation this session never asked
 * for.
 *
 * Applied in the worker AFTER both env layers are built — an adapter cannot do
 * it from `buildArgs`, which only shapes argv. `core/child-spawn-env.ts` folds
 * this into the three values handed to `backend.spawn()`.
 */

/** The launcher's resume markers (`bin/dsh-tui` `setResumeEnv`). */
export const DSH_TUI_RESUME_ENV_KEYS = [
  'DSH_TUI_RESUME_SESSION',
  'DSH_TUI_RESUME_BACKEND',
  'DSH_TUI_RESUME_RETRY',
] as const;

export interface DshTuiResumeEnvScope {
  /** True when this spawn intends a FRESH session: `effectiveResume === false`,
   *  including the worker's Tier-0/1/2 fresh demotions. */
  fresh: boolean;
  /** The EFFECTIVE adapter id at spawn time (`cliAdapter.id`), which is
   *  'dsh-tui' for the dshRuntime='tui' variant while `cfg.cliId` stays 'dsh'. */
  cliId?: string;
  /** The worker predicted a persistent-pane reattach (no cold spawn). The
   *  backends freeze that prediction but still downgrade to a real spawn when
   *  the pane is provably gone (zellij `frozenReattach`), so a resume-intent
   *  launch can become a fresh one after `effectiveResume` was already
   *  computed — the markers must go in that case too. Harmless on a true
   *  reattach, which starts no process. */
  willReattachPersistent?: boolean;
}

/** The scope of one spawn, derived from the worker's resolved decisions.
 *
 * `resume` is the EFFECTIVE resume intent (`effectiveResume`, i.e. after the
 * Tier demotions), and `willReattachPersistent` is REQUIRED: the backends may
 * downgrade a predicted reattach to a real spawn (zellij `frozenReattach`), so
 * a call site that forgets the flag would hand the launcher its resume markers
 * on a launch that actually starts a new session. Keeping it non-optional makes
 * that omission a type error instead of a silent regression. */
export function dshTuiResumeScope(input: {
  resume: boolean;
  cliId?: string;
  willReattachPersistent: boolean;
}): DshTuiResumeEnvScope {
  return {
    fresh: !input.resume,
    cliId: input.cliId,
    willReattachPersistent: input.willReattachPersistent,
  };
}

/**
 * Which launcher markers this spawn must drop.
 *
 * A resume keeps `SESSION`/`BACKEND` — that pair is how a precise resume is
 * expressed — but never `RETRY`: the launcher only honors it from its own
 * safe-mode retry, and an INHERITED `1` turns an explicit (bad) `--resume <id>`
 * into a silent downgrade instead of dsh's own boot-fatal, i.e. it hides the
 * failure we deliberately do not swallow.
 */
export function dshTuiResumeEnvKeysToDrop(scope: DshTuiResumeEnvScope): readonly string[] {
  if (scope.cliId !== 'dsh-tui') return [];
  if (scope.fresh || scope.willReattachPersistent === true) return DSH_TUI_RESUME_ENV_KEYS;
  return ['DSH_TUI_RESUME_RETRY'];
}

/**
 * Delete the markers above from `env` for a dsh-tui spawn; other CLIs are left
 * untouched. Returns `env` so a call site can use the scrubbed value directly.
 */
export function scrubDshTuiResumeEnv<E extends Record<string, string | undefined>>(
  env: E,
  scope: DshTuiResumeEnvScope,
): E {
  for (const key of dshTuiResumeEnvKeysToDrop(scope)) delete env[key];
  return env;
}

/**
 * The same removal expressed as pane-side `env -u KEY` removals
 * (`SpawnOpts.unsetEnv`).
 *
 * Deleting the keys from the env layers is not enough on the persistent
 * backends: tmux/zellij/zmx/herdr start the CLI under a login shell that
 * inherits a shared server's global environment and re-reads the user's
 * rcfile. Those backends turn `unsetEnv` into `-u KEY` on the pane's FINAL
 * exec, i.e. after both of those sources, so a stale marker cannot reach the
 * CLI.
 */
export function dshTuiResumeEnvUnset(
  scope: DshTuiResumeEnvScope,
  base?: string[],
): string[] | undefined {
  const drop = dshTuiResumeEnvKeysToDrop(scope);
  if (drop.length === 0) return base?.length ? base : undefined;
  const merged = [...(base ?? [])];
  for (const key of drop) {
    if (!merged.includes(key)) merged.push(key);
  }
  return merged;
}
