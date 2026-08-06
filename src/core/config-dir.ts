/**
 * Resolve Botmux's configuration directory (`~/.botmux` by default) from one
 * canonical precedence rule: `BOTMUX_CONFIG_DIR` > `$HOME/.botmux`.
 *
 * Why this exists: the config dir was previously computed inline as
 * `join(homedir(), '.botmux')` at ~30 call sites, which silently ties the
 * *location of bots.json* to the *value of HOME*. That coupling breaks any
 * deployment where a daemon runs under a HOME that differs from the HOME its
 * spawned CLI children see.
 *
 * The concrete failure: running a second fleet via
 * `HOME=~/alt-home botmux start` makes the daemon load
 * `~/alt-home/.botmux/bots.json`, but the daemon injects only `cwd` and the
 * `BOTMUX_*` family into CLI children — never `HOME`. The child therefore
 * resolves `homedir()/.botmux/bots.json` (the *default* home), does not find
 * the bot it is running as, and every `botmux send` / `botmux history` from
 * inside that session fails with `Bot not registered: <appId>`.
 *
 * Injecting `HOME` into children is NOT a viable fix: `HOME` also anchors the
 * CLI's own config discovery (e.g. Claude Code falls back to `$HOME/.claude`
 * when `CLAUDE_CONFIG_DIR` is unset), so overriding it to point at the fleet
 * home silently relocates skills/settings for the spawned agent. A dedicated
 * variable decouples "where botmux keeps bots.json" from "who the OS user is",
 * which is the actual distinction the multi-fleet case needs.
 *
 * `BOTMUX_CONFIG_DIR` is honoured only as an absolute path. A relative value
 * would resolve against each process's cwd — daemon, forked worker and pane
 * child do not share one — so it is ignored rather than silently pointing
 * different processes at different stores.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ResolveBotmuxConfigDirOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to HOME/USERPROFILE from env, then os.homedir(). */
  homeDir?: string;
}

/** The env var that overrides the config dir. Reserved from per-bot `env`
 *  (see core/per-bot-env.ts): a bot must not be able to redirect the registry
 *  that defines it. */
export const BOTMUX_CONFIG_DIR_ENV = 'BOTMUX_CONFIG_DIR';

/**
 * Priority: `BOTMUX_CONFIG_DIR` (absolute only) > `$HOME/.botmux`.
 *
 * Mirrors {@link resolveBotmuxDataDir}'s shape so the two roots stay
 * predictable: env override first, HOME-derived default last.
 */
export function resolveBotmuxConfigDir(
  options: ResolveBotmuxConfigDirOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env[BOTMUX_CONFIG_DIR_ENV]?.trim();
  if (explicit && isAbsolute(explicit)) return resolve(explicit);

  const home = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.botmux');
}
