/**
 * Resolve Botmux's configuration directory (`~/.botmux`) and the bots.json
 * registry inside it, from ONE canonical precedence rule that matches the
 * registry loader: `BOTS_CONFIG` (exact file) > `os.homedir()/.botmux/bots.json`.
 *
 * The home half is `os.homedir()` — deliberately the SAME single semantic
 * `cli.ts` uses — NOT a hand-rolled `HOME`/`USERPROFILE` read, which forks from
 * `cli.ts` on win32. See {@link resolveBotmuxConfigDir} for the platform contract.
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 * `HOME=~/alt botmux start` makes the daemon load `~/alt/.botmux/bots.json`, but
 * the daemon injects only `cwd` and the `BOTMUX_*` family into CLI children —
 * never `HOME`. The child therefore resolves `homedir()/.botmux/bots.json` (the
 * *default* home), does not find the bot it is running as, and every
 * `botmux send` / `botmux history` from inside that session fails with
 * `Bot not registered: <appId>`.
 *
 * ── Why the child is pinned to a FILE, not a DIRECTORY ───────────────────────
 * The registry's real precedence is `BOTS_CONFIG` > `<config dir>/bots.json`,
 * and `BOTS_CONFIG` may name an ARBITRARY file (`/srv/fleet-a.json`). A
 * directory-shaped hint therefore cannot express what the daemon actually
 * loaded: `dirname` + a hardcoded `bots.json` guesses wrong for every custom
 * filename, and it sits BELOW `BOTS_CONFIG` in precedence, so a stale ambient
 * `BOTS_CONFIG` in a shared tmux server's global env would silently outrank it
 * and hand the child a foreign registry (verified: the child loaded the stale
 * file while the daemon had the correct one).
 *
 * So the daemon pins the EXACT path it loaded — `getLoadedConfigPath()`, already
 * frozen into `loadedBotsConfigPath` for the sandbox fs-policy — into the
 * child's `BOTS_CONFIG`. That is one authority, at the TOP of the precedence
 * chain, and file-shaped so any filename survives. `BOTS_CONFIG` is also
 * reserved from per-bot `env` and scrubbed off the pane/tmux paths, because a
 * bot must not be able to redirect the registry that defines it.
 *
 * Injecting `HOME` into children was considered and rejected: `HOME` also
 * anchors the CLI's own config discovery (Claude Code falls back to
 * `$HOME/.claude` when `CLAUDE_CONFIG_DIR` is unset), so overriding it to point
 * at the fleet home silently relocates skills/settings for the spawned agent.
 *
 * ── Scope (deliberately narrow) ──────────────────────────────────────────────
 * This is an INTERNAL daemon→child propagation fix, not a new public
 * "relocate botmux" knob. `os.homedir()` already follows `$HOME`, so
 * `HOME=~/alt botmux start` ALREADY relocates cli.ts's `CONFIG_DIR` / `DATA_DIR`
 * / `PM2_HOME` / `BOTS_JSON_FILE`, the dashboard's write path and setup —
 * verified: `HOME=<fleet> botmux setup list` reads the fleet registry with no
 * code change. The daemon-spawned CLI child was the ONLY process that diverged,
 * precisely because it is the only one that does not inherit `HOME`. Introducing
 * a second, dir-shaped public variable would have created a rival source of
 * truth that governs the registry but not the data dir, pm2 home or dashboard
 * writes — half-relocated deployments — so no public variable is added.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ResolveBotmuxConfigDirOptions {
  /**
   * Consulted for `BOTS_CONFIG` ONLY (see {@link resolveBotsConfigFile}) —
   * never to derive the home directory. Reading `HOME`/`USERPROFILE` here would
   * fork the config dir away from `cli.ts`'s `join(homedir(), '.botmux')` on
   * win32; see {@link resolveBotmuxConfigDir}.
   */
  env?: NodeJS.ProcessEnv;
  /** Test seam ONLY (production passes nothing); defaults to os.homedir(). */
  homeDir?: string;
}

/**
 * The env var naming the EXACT bots.json to load. Top of the registry's
 * precedence chain, and the channel the daemon uses to pin its own loaded path
 * onto a spawned CLI child.
 *
 * Reserved from per-bot `env` (see core/per-bot-env.ts) and stripped from the
 * tmux client env + pane wrapper (see utils/child-env.ts): a bot must not be
 * able to redirect the registry that defines it, and a stale value in a shared
 * tmux server's global env must not reach a pane.
 */
export const BOTS_CONFIG_ENV = 'BOTS_CONFIG';

/**
 * `<home>/.botmux`, where `<home>` is `os.homedir()` — the SAME single semantic
 * `cli.ts` uses for `CONFIG_DIR` / `DATA_DIR` / `PM2_HOME` / `BOTS_JSON_FILE`
 * and the dashboard write path (`cli.ts`: `join(homedir(), '.botmux')`).
 *
 * ── Why NOT `env.HOME ?? env.USERPROFILE ?? homedir()` ───────────────────────
 * Because `os.homedir()` is ALREADY the env-following rule, per platform, and
 * re-deriving it by hand gets the platform wrong. Node's contract
 * (https://nodejs.org/api/os.html#oshomedir):
 *   · POSIX — uses `$HOME` when set, else getpwuid(). So `HOME=~/alt botmux …`
 *     relocates the config dir with NO extra code; the hand-rolled `HOME` arm
 *     buys nothing here.
 *   · win32 — uses `%USERPROFILE%`; `HOME` is NOT consulted.
 * A HOME-first rule therefore FORKS from `cli.ts` on win32 whenever `HOME` and
 * `USERPROFILE` are both set to different values (Git-for-Windows/MSYS shells set
 * `HOME`): `setup`/`start`/PM2 would write `%USERPROFILE%\.botmux` while the
 * daemon's registry read `%HOME%\.botmux` — reconstructing the very daemon/child
 * registry split this module exists to close, on a platform the repo supports
 * (win32 PM2 / Task Scheduler / `.cmd` wrapper paths). master's bot-registry used
 * bare `homedir()` and agreed with `cli.ts`, so a HOME-first rule here would be a
 * REGRESSION, not a new feature.
 *
 * A hand-rolled env read is also wrong in a platform-INDEPENDENT way: `??` is
 * nullish, so `HOME=''` (which does occur in stripped service environments) is
 * accepted as a real value and `join('', '.botmux')` yields the RELATIVE,
 * cwd-dependent `.botmux`. `homedir()` has no such hole on POSIX — an empty
 * `$HOME` falls through to getpwuid().
 *
 * Custom homes in TESTS go through the `homeDir` seam, never through env.
 *
 * Note this resolves the DIRECTORY only, and is therefore NOT the whole story
 * for the registry: `BOTS_CONFIG` may point at an arbitrary file outside this
 * dir. Use {@link resolveBotsConfigFile} whenever you need the registry path.
 */
export function resolveBotmuxConfigDir(
  options: ResolveBotmuxConfigDirOptions = {},
): string {
  return join(options.homeDir ?? homedir(), '.botmux');
}

/**
 * The bots.json path implied by the environment: `BOTS_CONFIG` (absolute-ized
 * against cwd, exactly as the loader does) else `<config dir>/bots.json`.
 *
 * `env` is consulted for `BOTS_CONFIG` ONLY. The home half comes from
 * {@link resolveBotmuxConfigDir} (i.e. `os.homedir()`), so this never re-derives
 * a home from `HOME`/`USERPROFILE` and cannot fork from `cli.ts` on win32.
 *
 * Existence is NOT checked here — callers differ on what an absent file means
 * (the loader throws for an explicit `BOTS_CONFIG`, degrades for the default).
 */
export function resolveBotsConfigFile(
  options: ResolveBotmuxConfigDirOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env[BOTS_CONFIG_ENV]?.trim();
  if (explicit) return resolve(explicit);
  return join(resolveBotmuxConfigDir(options), 'bots.json');
}

/**
 * Where a `loadedBotsConfigPath` came from. This is the PROVENANCE the pin
 * decision turns on, and it is carried explicitly because it is NOT derivable
 * from the path or from the filesystem:
 *
 *  · `'loaded'`  — the daemon actually opened and parsed this exact file
 *                  (`resolveBotConfigPath` set it). It is the registry authority.
 *  · `'synthetic'` — nothing was parsed. Core-only synthesis
 *                  (`maybeSynthesizeCoreOnlyConfig`) pins the DEFAULT
 *                  `<config dir>/bots.json` purely so the no-transport fs-policy
 *                  sees the config inside the default authority root; that file
 *                  is ignored by design and may not even exist.
 *
 * An `existsSync` probe cannot stand in for this:
 * existence and provenance are independent, so the probe is wrong in BOTH
 * directions. A real loaded file that later vanished reads as "absent" and the
 * pin gets dropped (the child then silently loads a FOREIGN registry from its own
 * HOME); a synthetic placeholder that happens to exist reads as "present" and
 * gets pinned even though the daemon never parsed it.
 */
export type BotsConfigProvenance = 'loaded' | 'synthetic';

/**
 * Decide the `BOTS_CONFIG` value to pin onto a spawned CLI child.
 *
 * The rule is provenance-driven, NOT existence-driven:
 *
 *  · provenance `'loaded'` → pin UNCONDITIONALLY (absolute-ized, since daemon /
 *    worker / pane share no cwd). Even if the file has since vanished, the pin
 *    stays: the child must then FAIL LOUDLY in the loader
 *    (`BOTS_CONFIG file not found`, bot-registry.ts) rather than silently switch
 *    authority to whatever `<its own HOME>/.botmux/bots.json` contains. Under a
 *    multi-fleet non-default HOME that fallback is a DIFFERENT registry — same
 *    appId can carry another fleet's secret and another oncall routing — so
 *    "fail closed" is strictly correct and "degrade gracefully" is the bug.
 *    (A read-ISOLATED child still works: Seatbelt allows the metadata read, so
 *    the loader's `existsSync` passes and its `EPERM + underReadIsolation`
 *    branch takes over.)
 *
 *  · provenance `'synthetic'` (or no path at all) → return null, and the caller
 *    must DELETE `BOTS_CONFIG` from the child env rather than leave an inherited
 *    value: `BOTS_CONFIG` is the TOP of the precedence chain, so a stale ambient
 *    value would outrank the on-disk default and hand the child a foreign
 *    registry. Omitting it is right here precisely because nothing was parsed —
 *    there is no authority to propagate.
 */
export function resolveChildBotsConfig(
  loadedConfigPath: string | undefined,
  provenance: BotsConfigProvenance | undefined,
): string | null {
  if (provenance !== 'loaded') return null;
  const trimmed = loadedConfigPath?.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}
