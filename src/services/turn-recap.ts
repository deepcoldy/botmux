/**
 * Content of the「本轮回顾」panel on a turn's last reply card: the CLI's own
 * recap, and nothing else. Claude Code writes an away summary into its
 * transcript (`type:"system", subtype:"away_summary"`) when the session sat
 * idle for a few minutes after a turn while its terminal was unfocused —
 * botmux neither asks for one nor turns anything on to get one. A turn the
 * CLI did not recap, and every CLI that writes no such record, gets no panel.
 */

/** Claude Code appends this to its first few away summaries: "(disable recaps
 * in /config)" up to 2.1.325, "(turn off recaps in /config)" since 2.1.326. */
const AWAY_SUMMARY_HINT_RE = /\s*\((?:disable|turn off) recaps in \/config\)\s*$/i;

/** The text of a Claude Code away-summary transcript record, else undefined. */
export function claudeAwaySummaryText(event: unknown): string | undefined {
  const record = event as { type?: unknown; subtype?: unknown; content?: unknown; isSidechain?: unknown } | null;
  if (!record || record.type !== 'system' || record.subtype !== 'away_summary' || record.isSidechain === true) return undefined;
  if (typeof record.content !== 'string') return undefined;
  const text = record.content.replace(AWAY_SUMMARY_HINT_RE, '').trim();
  return text || undefined;
}

export interface CliRecap {
  text: string;
  turnId: string;
  dispatchAttempt?: number;
}

/**
 * Picks the CLI's own recap out of newly drained transcript records, for the
 * turn the CLI was last given input for. Claude Code writes its away summary
 * minutes into an idle session, so one written before that turn's input
 * reached the CLI recaps an earlier turn and is dropped; each record is
 * reported at most once.
 */
export class CliRecapObserver {
  private readonly seen = new Set<string>();
  private turn?: { turnId: string; dispatchAttempt?: number; sinceMs: number };

  observe(
    events: readonly unknown[],
    current: { turnId?: string; dispatchAttempt?: number },
    nowMs: number,
  ): CliRecap | undefined {
    if (current.turnId !== this.turn?.turnId || current.dispatchAttempt !== this.turn?.dispatchAttempt) {
      // First seen now, so never earlier than the input that started it.
      this.turn = current.turnId
        ? { turnId: current.turnId, ...(current.dispatchAttempt !== undefined ? { dispatchAttempt: current.dispatchAttempt } : {}), sinceMs: nowMs }
        : undefined;
    }
    let found: CliRecap | undefined;
    for (const event of events) {
      const text = claudeAwaySummaryText(event);
      if (!text) continue;
      const { uuid, timestamp } = event as { uuid?: unknown; timestamp?: unknown };
      if (typeof uuid === 'string') {
        if (this.seen.has(uuid)) continue;
        this.seen.add(uuid);
        if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
      }
      if (!this.turn) continue;
      // Claude Code abandons a summary still being written once new input
      // starts a turn (2.1.325), so one written after that input is this turn's.
      const writtenAt = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
      if (!Number.isFinite(writtenAt) || writtenAt < this.turn.sinceMs) continue;
      found = {
        text,
        turnId: this.turn.turnId,
        ...(this.turn.dispatchAttempt !== undefined ? { dispatchAttempt: this.turn.dispatchAttempt } : {}),
      };
    }
    return found;
  }
}

function prose(text: string): string {
  // CLI prose rendered as card markdown: never a live mention, image or
  // tag. Mention markup is removed outright (not only escaped), opening and
  // closing tags alike, so no form of it survives into the card.
  // `&` goes first (as in escapeLarkMd): an entity-encoded tag in the text
  // stays text instead of becoming markup when the card decodes entities.
  return text.trim()
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/<\/?at\b[^>]*>/gi, '[mention]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Markdown for the panel body: the CLI's recap alone, or undefined when
 * there is no recap text. */
export function renderRecapMarkdown(recap: string | undefined): string | undefined {
  if (!recap?.trim()) return undefined;
  return prose(recap);
}
