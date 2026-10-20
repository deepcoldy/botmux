/**
 * Message-content helpers shared by the Pi-family session readers
 * (pi / Oh My Pi / ebsd). They read the same pi-agent-core record shapes, so
 * the three transcripts project text, spot tool calls and stamp events the
 * same way. Pure functions; no I/O.
 */

/** Canonical text projection for a pi-agent-core message `content`: a bare
 *  string is trimmed; an array contributes its `text` blocks joined by '\n'. */
export function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ((item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('\n').trim();
}

/** True when an assistant message `content` carries a `toolCall` block. */
export function contentHasToolCall(content: unknown): boolean {
  return Array.isArray(content) && content.some(item =>
    !!item
    && typeof item === 'object'
    && (item as { type?: unknown }).type === 'toolCall');
}

/** Event timestamp for an OMP-style session entry: the entry's ISO string,
 *  else the message's numeric epoch-ms, else the drain wall clock. */
export function entryTimestampMs(entry: Record<string, unknown>, message?: Record<string, unknown>): number {
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  return Date.now();
}
