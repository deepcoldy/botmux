// Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming card disabled):
//   - RECEIVED lands the instant the bot starts working on the turn (冲! `GoGoGo`).
//   - On turn completion the RECEIVED reaction is removed and DONE (✅) replaces it.
// These are the DEFAULTS; a bot can override either emoji_type via bots.json
// (receivedReactionEmoji / doneReactionEmoji). Setting both to the same value
// keeps the marker visually unchanged on turn-end — handy for CLIs whose idle
// detection can fire early (e.g. Pi), where a premature ✅ would mislead.
export const RECEIVED_REACTION_EMOJI_TYPE = 'GoGoGo';
export const SUBSTITUTE_RECEIVED_REACTION_EMOJI_TYPE = 'Get';
export const DONE_REACTION_EMOJI_TYPE = 'DONE';

/**
 * 文档评论里「这条 @ 我没能处理」的可见标记（❌）。
 *
 * 和上面三个不同，它不是回合状态指示器，而是**失败信号**：文档评论链路一旦丢弃
 * 事件，飞书那边不会重投、mention-only 也不进轮询兜底，用户侧只会看到「bot 不理
 * 我」，与「bot 正在忙」无法区分（doc 会话在飞书完全不可见，只能去 dashboard 翻
 * terminal）。给触发回复打上这个 emoji，至少让「已丢弃」在文档里是**看得见**的。
 */
export const DROPPED_REACTION_EMOJI_TYPE = 'ERROR';
