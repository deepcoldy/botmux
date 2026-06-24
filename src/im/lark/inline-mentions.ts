/**
 * Inline `@Name` → Lark `<at id=…>` rewriting for outgoing card bodies.
 *
 * When `botmux send --mention 'open_id:Name'` registers a name↔open_id map, the
 * model can write `@Name` anywhere in the prose and we rewrite it in place into
 * a real `<at id=open_id></at>` so the mention renders exactly where it was
 * written (next to the relevant line) instead of being dangled in the footer.
 * The open_ids that were inlined are returned so the caller can drop them from
 * the footer `发送给：` addressing line (no double @).
 *
 * Boundary mirrors the `@BotName` auto-injection matcher in cli.ts:
 *   - lookbehind `(?<![A-Za-z0-9_])` blocks only ASCII word chars, so an
 *     email-/handle-like `user@Owner` / `a@张三` is rejected, while a natural
 *     `负责人 @张三` and a CJK-prefixed `看看@张三` are accepted (CJK isn't an
 *     ASCII word char);
 *   - lookahead `(?![\p{L}\p{N}_])` (needs the `u` flag) blocks any Unicode
 *     letter/digit so `@Owner2` won't half-match name "Owner", and on a prefix
 *     collision (`@张三丰` with both `张三` and `张三丰` registered) it forces the
 *     engine to backtrack onto the longer, fully-bounded alternative.
 *
 * This replaces the previous `@(name)\b` matcher whose `\b` word boundary never
 * matched after a CJK character — pure-Chinese display names (`@张三`) silently
 * fell through to the footer and never rendered inline.
 */
export interface NamedMention {
  open_id: string;
  name: string;
}

export interface InlineMentionResult {
  /** Body text with matched `@Name` rewritten to `<at id=…></at>`. */
  text: string;
  /** open_ids that were inlined into the body (skip these in the footer). */
  usedIds: Set<string>;
}

export function applyInlineMentions(
  text: string,
  mentions: NamedMention[],
): InlineMentionResult {
  const usedIds = new Set<string>();
  const named = mentions.filter(m => m.name);
  if (named.length === 0) return { text, usedIds };

  // Lowercased lookup map; the `i` flag means the matched text may differ in
  // case from the registered name.
  const map = new Map<string, string>();
  for (const m of named) map.set(m.name.toLowerCase(), m.open_id);

  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])@(${named
      .map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  );

  const out = text.replace(pattern, (full: string, name: string) => {
    const openId = map.get(name.toLowerCase());
    if (!openId) return full;
    usedIds.add(openId);
    return `<at id=${openId}></at>`;
  });

  return { text: out, usedIds };
}
