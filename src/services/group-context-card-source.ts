import { config } from '../config.js';
import { projectGroupContextCard } from '../im/lark/group-context-card.js';
import { readBotsInfoJson } from './bots-info-cache.js';
import { readPeerCrossRef } from './peer-cross-ref-store.js';

/** Sender evidence belongs to observation, not to the pure card renderer.
 * Peer open_ids must come from this observer app's cross-reference. */
export function projectObservedGroupContextCard(raw: string, observerAppId: string, senderId: string) {
  const projected = projectGroupContextCard(raw);
  if (projected || !senderId) return projected;
  let botmuxSender = senderId === observerAppId;
  try {
    const rawEntries = readBotsInfoJson(config.session.dataDir);
    const entries = Array.isArray(rawEntries) ? rawEntries.filter(entry => entry && typeof entry.larkAppId === 'string') : [];
    botmuxSender ||= entries.some(entry => entry.larkAppId === senderId
      || entry.larkAppId === observerAppId && entry.botOpenId === senderId);
    if (!botmuxSender) {
      const names = new Set(entries.flatMap(entry => typeof entry.botName === 'string' ? [entry.botName.toLowerCase()] : []));
      botmuxSender = Object.entries(readPeerCrossRef(config.session.dataDir, observerAppId))
        .some(([name, openId]) => openId === senderId && names.has(name.toLowerCase()));
    }
  } catch { /* Missing/corrupt identity data is not evidence of a Botmux producer. */ }
  return botmuxSender ? projectGroupContextCard(raw, { botmuxSender: true }) : undefined;
}
