/**
 * Shared v3 bot resolution — selector → BotConfig → BotSnapshot.
 *
 * The daemon-driven run path (`daemon-run.ts`) and the standalone CLI path
 * (`cli-run.ts`) both turn a `--bot`/node.bot selector into the `BotSnapshot`
 * the runtime freezes per node.  This module is the single source of that
 * matching + working-dir fallback so the two entries can't drift.
 *
 * (cli-run.ts currently keeps equivalent local copies — codex's runtime file,
 * which this feature doesn't touch; dedupe it to this module next time that
 * file is edited.)
 */

import { effectiveDefaultWorkingDir, type BotConfig } from '../../bot-registry.js';
import type { BotSnapshot } from './contract.js';

export function resolveBotConfig(selector: string | undefined, bots: BotConfig[]): BotConfig {
  if (!selector) {
    if (bots.length === 0) throw new Error('v3: bots.json has no bots — run `botmux setup` first');
    return bots[0]!;
  }
  const match = bots.find((b) => b.larkAppId === selector || b.name === selector);
  if (!match) {
    const known = bots.map((b) => b.name ?? b.larkAppId).join(', ') || '(none)';
    throw new Error(`v3: no bot matches "${selector}" (known: ${known})`);
  }
  return match;
}

/** The configured working dir for a bot, before `~` expansion (the pool
 *  expands).  An explicit override wins over the bot's configured value. */
export function botWorkingDir(bot: BotConfig, override?: string): string {
  return override
    ?? effectiveDefaultWorkingDir(bot)
    ?? bot.workingDir
    ?? bot.workingDirs?.[0]
    ?? '~';
}

/** BotConfig → BotSnapshot (the runtime-frozen, secret-free per-node identity). */
export function botToSnapshot(bot: BotConfig, workingDirOverride?: string): BotSnapshot {
  return {
    larkAppId: bot.larkAppId,
    cliId: bot.cliId,
    ...(bot.cliPathOverride ? { cliPathOverride: bot.cliPathOverride } : {}),
    ...(bot.model ? { model: bot.model } : {}),
    // 受限 bot 的全部节点保持受限（P2 不可提权红线的 bot 侧入口）。
    ...(bot.disableCliBypass === true ? { disableCliBypass: true } : {}),
    workingDir: botWorkingDir(bot, workingDirOverride),
  };
}
