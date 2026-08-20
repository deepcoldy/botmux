import { normalizeBotConfig } from '../setup/bot-config-editor.js';

/**
 * Resolve the DM recipient for a first-upgrade restart failure, inside the SAME
 * bot application that will send the notification.
 *
 * Critically, this ALSO registers the sending bot in the in-process bot
 * registry on BOTH resolution paths. The fresh `botmux restart` CLI is a new
 * process whose registry starts empty and is never populated elsewhere on the
 * restart path (loadBotsJson only reads the file). Without registration here,
 * the subsequent `sendUserMessage → getBotClient → getBot` throws
 * `Bot not registered`, which would silently defeat the notification on the
 * most common (persisted `ownerOpenId`) path. See PR #843 R2 review.
 */

export interface RestartFailureOwnerDeps {
  /** Register the sending bot so getBotClient can build its Lark client. */
  registerBot: (cfg: any) => void;
  /** Resolve stable allowedUsers entries through the sending app itself. */
  resolveAllowedUsers: (larkAppId: string, raw: string[]) => Promise<string[]>;
}

export async function resolveRestartFailureOwner(
  bot: any,
  deps: RestartFailureOwnerDeps,
): Promise<string | undefined> {
  // The sending app must be registered before ANY delivery, regardless of which
  // resolution branch wins — this is the blocker R2 flagged. registerBot is
  // idempotent (it overwrites the same larkAppId entry), so registering here and
  // again in a later fallback is harmless.
  const registerSender = (): void => deps.registerBot(normalizeBotConfig(bot));

  if (typeof bot?.ownerOpenId === 'string' && bot.ownerOpenId.startsWith('ou_')) {
    registerSender();
    return bot.ownerOpenId;
  }

  const allowedUsers = Array.isArray(bot?.allowedUsers)
    ? bot.allowedUsers.filter((entry: unknown): entry is string => (
        typeof entry === 'string'
        && !!entry.trim()
        // A literal ou_ has no independent proof that it belongs to this app.
        // Only the app's persisted ownerOpenId above may use that shape; all
        // allowedUsers fallbacks must cross the stable email/mobile/union-id
        // boundary and be resolved by the sending app itself.
        && !entry.startsWith('ou_')
      ))
    : [];
  if (allowedUsers.length === 0) return undefined;

  registerSender();
  return (await deps.resolveAllowedUsers(bot.larkAppId, allowedUsers))
    .find(openId => openId.startsWith('ou_'));
}
