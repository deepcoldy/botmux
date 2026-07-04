// Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming card disabled):
//   - RECEIVED lands the instant the bot starts working on the turn (冲! `GoGoGo`).
//   - On turn completion the RECEIVED reaction is removed and DONE (✅) replaces it.
export const RECEIVED_REACTION_EMOJI_TYPE = 'GoGoGo';
export const DONE_REACTION_EMOJI_TYPE = 'DONE';
