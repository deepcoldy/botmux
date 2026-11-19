/**
 * Per-process latch for the "bots.json `env` carries botmux-reserved keys"
 * warning (#2007).
 *
 * Why a latch is needed: that warning is emitted from
 * `parseBotConfigsFromText`, and several config reads inside ONE turn go through
 * the uncached `loadBotConfigs()` (session-manager's skill/injection lookups,
 * event-dispatcher's sibling-name resolution, …). A bot whose `bots.json` keeps
 * an unusable reserved key therefore repeats the identical line every turn,
 * 2–4 lines per message, forever — the exact noise `utils/logger.ts` splits
 * stdout/stderr to avoid. The config is static between reloads, so repeating the
 * line adds nothing an operator can act on.
 *
 * Scope / reset semantics:
 *   - Latch key includes the appId AND the dropped-key set, so the unit of
 *     suppression is "this bot, with exactly this mistake". Editing `env` from
 *     `CODEX_HOME` to `GROK_HOME` changes the set and warns again — that
 *     particular config CHANGE re-arms itself, no restart needed.
 *   - The set is MODULE-level, so it is shared by every caller that parses bot
 *     configs in this process, including the single-entry parsers
 *     (`loadBotConfigAtIndex` / core-only synthesis). That is intentional: they
 *     re-parse the same row, so they must not re-log it.
 *   - ONLY A PROCESS RESTART FULLY RE-ARMS the latch. There is no reload hook:
 *     `bots.json` is re-read on every parser call and the latch is never
 *     cleared by it. Concretely, for one appId within one process lifetime:
 *     warn (CODEX_HOME) → fix it (clean env, no line) → re-introduce the SAME
 *     CODEX_HOME mistake → STILL SILENT until the daemon restarts.
 *
 *     That is accepted, not accidental: the line already sits in this process's
 *     log, the operator has been told about exactly this mistake, and the strip
 *     behaviour (the part that matters) still runs on every parse. Keying on a
 *     config generation (e.g. a `bots.json` text hash) would re-warn here but
 *     means threading a generation through the parser signatures — not worth it
 *     for a diagnostic line.
 *   - Generation is bounded by process lifetime; memory is one short string per
 *     distinct (appId, key set) pair ever seen — bounded by the fleet size ×
 *     key sets.
 */
const warnedDroppedReservedEnv = new Set<string>();

/** Stable latch identity: appId + the exact dropped-key set (order-insensitive). */
export function droppedReservedEnvWarnKey(larkAppId: string, droppedKeys: readonly string[]): string {
  return `${larkAppId}\0${[...droppedKeys].sort().join('\0')}`;
}

/**
 * Claim the right to log this (appId, dropped-key set) once per process.
 * Returns true on the first sighting, false on every repeat.
 */
export function shouldWarnDroppedReservedEnv(larkAppId: string, droppedKeys: readonly string[]): boolean {
  const key = droppedReservedEnvWarnKey(larkAppId, droppedKeys);
  if (warnedDroppedReservedEnv.has(key)) return false;
  warnedDroppedReservedEnv.add(key);
  return true;
}

/**
 * Drop every latch entry. Test-only: `bun test` shares one process across test
 * files, so a spec that must observe the warning has to start from a clean
 * latch. Production never calls this (a restart is the real reset).
 */
export function resetDroppedReservedEnvWarnLatch(): void {
  warnedDroppedReservedEnv.clear();
}
