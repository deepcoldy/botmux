export interface MentionTrigger {
  start: number;
  end: number;
  query: string;
}

/** Find the active @ token immediately before the caret. The trigger starts at
 * line start or after whitespace; this avoids turning email addresses into bot
 * mentions. Display names may contain spaces once a suggestion has been
 * inserted, but an in-progress query intentionally stops at whitespace. */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, safeCaret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: safeCaret - query.length - 1, end: safeCaret, query };
}

export function insertBotMention(
  text: string,
  trigger: Pick<MentionTrigger, 'start' | 'end'>,
  botName: string,
): { text: string; caret: number } {
  const replacement = `@${botName} `;
  const suffixStart = text[trigger.end] === ' ' ? trigger.end + 1 : trigger.end;
  const next = text.slice(0, trigger.start) + replacement + text.slice(suffixStart);
  return { text: next, caret: trigger.start + replacement.length };
}

export function filterMentionBots<T extends { botName: string; larkAppId: string }>(
  bots: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...bots];
  return bots.filter(bot =>
    bot.botName.toLocaleLowerCase().includes(normalized)
      || bot.larkAppId.toLocaleLowerCase().includes(normalized));
}

/** Insert visible attachment markers at the textarea selection. Images remain
 * binary attachments, while the markers preserve their intended position in
 * the plain-text task body and make the preview order unambiguous. */
export function insertImageMarkers(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  markers: readonly string[],
): { text: string; caret: number } {
  if (markers.length === 0) return { text, caret: Math.max(0, Math.min(selectionStart, text.length)) };
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const leading = before && !/\s$/u.test(before) ? ' ' : '';
  const trailing = after && !/^\s/u.test(after) ? ' ' : '';
  const insertion = `${leading}${markers.join(' ')}${trailing}`;
  return {
    text: before + insertion + after,
    caret: before.length + insertion.length,
  };
}

/** Remove one generated marker without collapsing surrounding words. */
export function removeImageMarker(text: string, marker: string): string {
  const index = text.indexOf(marker);
  if (index < 0) return text;
  const before = text.slice(0, index);
  let after = text.slice(index + marker.length);
  if (/\s$/u.test(before) && /^\s/u.test(after)) after = after.slice(1);
  return before + after;
}

/** Remove one image marker and compact the remaining markers back to attachment
 * order. This keeps `[图片 N]` aligned with the backend's 1-based attachment
 * numbering after deleting an image from the middle of the list. */
export function removeAndReindexImageMarkers(
  text: string,
  removedMarker: string,
  remainingMarkers: readonly string[],
  markerForIndex: (index: number) => string,
): { text: string; markers: string[] } {
  let nextText = removeImageMarker(text, removedMarker);
  const markers = remainingMarkers.map((_marker, index) => markerForIndex(index));
  remainingMarkers.forEach((oldMarker, index) => {
    const markerIndex = nextText.indexOf(oldMarker);
    if (markerIndex < 0 || oldMarker === markers[index]) return;
    nextText = nextText.slice(0, markerIndex) + markers[index] + nextText.slice(markerIndex + oldMarker.length);
  });
  return { text: nextText, markers };
}
