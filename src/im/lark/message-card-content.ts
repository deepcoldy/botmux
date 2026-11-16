/** The original card JSON of an interactive message fetched with
 * `user_card_content`, only when it belongs to the expected chat. */
export function messageCardContent(detail: any, expectedChatId: string): string | undefined {
  const message = detail?.items?.[0] ?? detail?.message ?? detail;
  if (message?.chat_id !== expectedChatId || message?.msg_type !== 'interactive') return undefined;
  const content = message?.body?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (content && typeof content === 'object') return JSON.stringify(content);
  return undefined;
}
