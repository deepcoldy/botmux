const SUBMIT_PREVIEW_MAX_CHARS = 60;

/** 提取用户可见的原始消息，避免提交错误提示泄漏 BotMux 内部信封。 */
export function buildSubmitMessagePreview(value: string, maxChars = SUBMIT_PREVIEW_MAX_CHARS): string {
  const userMessage = value.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)?.[1]
    ?? value;
  const normalized = userMessage
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(normalized);
  return chars.length > maxChars
    ? `${chars.slice(0, maxChars).join('')}…`
    : normalized;
}
