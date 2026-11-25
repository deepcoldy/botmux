/** Option labels and descriptions are model-written text: a literal mention tag in them must
 *  never ping anyone (a bot target makes Feishu reject the whole card). Same rule on every card. */
export function escapeOptionText(text: string): string {
  return text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/[\\`*_~[\]]/g, c => `\\${c}`)
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** At most `cap` UTF-16 units, never ending on half a surrogate pair. One cap is shared by every description,
 *  so when their emoji sit at different offsets some cut always lands mid-pair. */
export function capChars(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.max(0, cap));
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}
