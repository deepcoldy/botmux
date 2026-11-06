/**
 * Claude and Codex in every private-chat and regular-group mode. Kept free of
 * browser imports so the scenario registry stays cheap to load; the cases live
 * in feishu-chat-modes.e2e.ts.
 *
 * - `dm-<mode>-<bot>`: `/reply-mode chat|topic|group` in the bot's DM.
 * - `group-reply-<mode>-<bot>`: `@bot /reply-mode chat-topic|chat|topic|new-topic`.
 * - `group-mention-<mode>-<bot>`: `@bot /mention-mode always|never|ambient|topic`.
 */
export const CHAT_MODE_BOTS = ['Claude', 'Codex'] as const;
export type ChatModeBot = (typeof CHAT_MODE_BOTS)[number];

export const DM_MODES = ['chat', 'thread', 'group'] as const;
export const GROUP_REPLY_MODES = ['chat-topic', 'chat', 'topic', 'new-topic'] as const;
export const GROUP_MENTION_MODES = ['always', 'never', 'ambient', 'topic'] as const;

export type DmMode = (typeof DM_MODES)[number];
export type GroupReplyMode = (typeof GROUP_REPLY_MODES)[number];
export type GroupMentionMode = (typeof GROUP_MENTION_MODES)[number];

export const CHAT_MODE_SCENARIOS = [
  'dm-chat-claude',
  'dm-thread-claude',
  'dm-group-claude',
  'dm-chat-codex',
  'dm-thread-codex',
  'dm-group-codex',
  'group-reply-chat-topic-claude',
  'group-reply-chat-claude',
  'group-reply-topic-claude',
  'group-reply-new-topic-claude',
  'group-reply-chat-topic-codex',
  'group-reply-chat-codex',
  'group-reply-topic-codex',
  'group-reply-new-topic-codex',
  'group-mention-always-claude',
  'group-mention-never-claude',
  'group-mention-ambient-claude',
  'group-mention-topic-claude',
  'group-mention-always-codex',
  'group-mention-never-codex',
  'group-mention-ambient-codex',
  'group-mention-topic-codex',
] as const;

export type ChatModeScenario = (typeof CHAT_MODE_SCENARIOS)[number];

export type ParsedChatModeScenario =
  | { kind: 'dm'; mode: DmMode; bot: ChatModeBot }
  | { kind: 'group-reply'; mode: GroupReplyMode; bot: ChatModeBot }
  | { kind: 'group-mention'; mode: GroupMentionMode; bot: ChatModeBot };

function botOf(suffix: string): ChatModeBot {
  const bot = CHAT_MODE_BOTS.find((name) => name.toLowerCase() === suffix);
  if (!bot) throw new Error(`Unknown chat-mode bot: ${suffix}`);
  return bot;
}

export function parseChatModeScenario(scenario: ChatModeScenario): ParsedChatModeScenario {
  let match = /^dm-(chat|thread|group)-(claude|codex)$/.exec(scenario);
  if (match) return { kind: 'dm', mode: match[1] as DmMode, bot: botOf(match[2]) };
  match = /^group-reply-(chat-topic|chat|topic|new-topic)-(claude|codex)$/.exec(scenario);
  if (match) return { kind: 'group-reply', mode: match[1] as GroupReplyMode, bot: botOf(match[2]) };
  match = /^group-mention-(always|never|ambient|topic)-(claude|codex)$/.exec(scenario);
  if (match) return { kind: 'group-mention', mode: match[1] as GroupMentionMode, bot: botOf(match[2]) };
  throw new Error(`Unrecognised chat-mode scenario: ${scenario}`);
}
