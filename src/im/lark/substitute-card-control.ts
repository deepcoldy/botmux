import type { SubstituteModeConfig } from '../../bot-registry.js';
import { getCachedChatModeStrict } from './client.js';
import { isSubstituteEnabledForChat } from '../../services/substitute-chat-toggle-store.js';

/** Live-card state for the per-chat substitute toggle. */
export interface SubstituteCardControl {
  /** Current per-chat substitute state at render time. */
  enabled: boolean;
}

/**
 * Decide whether the live card should render the「在本群关闭/开启替身模式」button,
 * and what its current state is.
 *
 * This is deliberately NOT a pure function: it reads the real per-chat toggle
 * store and the strict chat-mode cache. Both are cheap local reads; callers
 * re-render cards frequently and must always show the current state.
 *
 * Visibility is fail-closed:
 *   • only group chats (p2p has no meaningful per-chat group toggle);
 *   • bot-level substitute mode must be enabled;
 *   • configured excludedChats (hard off) hides the button;
 *   • a configured chats allow-list must include this chat;
 *   • topic groups are hidden when the bot disabled topicGroups support.
 *     A strict cache miss is treated as unknown and hidden when topicGroups is
 *     false — a lenient `unknown → group` fallback must never prove flat mode.
 */
export function resolveSubstituteCardControl(
  larkAppId: string,
  chatId: string,
  chatType: 'group' | 'p2p' | undefined,
  cfg: SubstituteModeConfig | undefined,
): SubstituteCardControl | undefined {
  if (chatType !== 'group' || !chatId) return undefined;
  if (cfg?.enabled !== true) return undefined;
  if (cfg.excludedChats?.includes(chatId)) return undefined;
  if (cfg.chats?.length && !cfg.chats.includes(chatId)) return undefined;

  const strictMode = getCachedChatModeStrict(larkAppId, chatId);
  if (strictMode === 'p2p') return undefined;
  if (cfg.topicGroups === false) {
    // topicGroups=false: only a proven flat group may show the toggle. A topic
    // chat cannot use it, and an unproven mode is not safe to treat as flat.
    if (strictMode !== 'group') return undefined;
  }

  return { enabled: isSubstituteEnabledForChat(larkAppId, chatId) };
}
