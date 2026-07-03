// Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming card disabled):
//   - RECEIVED lands the instant the bot starts working on the turn (冲! `GoGoGo`).
//   - On turn completion the RECEIVED reaction is removed and DONE (✅) replaces it.
// These are the DEFAULTS; a bot can override either emoji_type via bots.json
// (receivedReactionEmoji / doneReactionEmoji). Setting both to the same value
// keeps the marker visually unchanged on turn-end — handy for CLIs whose idle
// detection can fire early (e.g. Pi), where a premature ✅ would mislead.
export const RECEIVED_REACTION_EMOJI_TYPE = 'GoGoGo';
export const DONE_REACTION_EMOJI_TYPE = 'DONE';
