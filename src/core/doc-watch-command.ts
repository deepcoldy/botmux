import type { CommentTriggerMode } from '../services/doc-subs-store.js';

export type DocWatchCommand =
  | { kind: 'usage' }
  | { kind: 'list' }
  | { kind: 'off'; docRef?: string }
  | {
      kind: 'watch';
      docRef: string;
      workingDir?: string;
      requestedMode?: CommentTriggerMode;
    }
  | { kind: 'invalid'; reason: 'missing_argument' | 'conflicting_modes' };

function parseWatchSpec(raw: string): DocWatchCommand {
  const dirMatch = /(?:^|\s)--dir\s+(\S+)/i.exec(raw);
  const workingDir = dirMatch?.[1];
  const hasAll = /(?:^|\s)--all(?:\s|$)/i.test(raw);
  const hasMentionsOnly = /(?:^|\s)--mentions-only(?:\s|$)/i.test(raw);
  if (hasAll && hasMentionsOnly) {
    return { kind: 'invalid', reason: 'conflicting_modes' };
  }

  const docRef = raw
    .replace(/(?:^|\s)--dir\s+\S+/gi, ' ')
    .replace(/(?:^|\s)--mentions-only(?=\s|$)/gi, ' ')
    .replace(/(?:^|\s)--all(?=\s|$)/gi, ' ')
    .trim();
  if (!docRef) return { kind: 'invalid', reason: 'missing_argument' };

  return {
    kind: 'watch',
    docRef,
    workingDir,
    requestedMode: hasAll ? 'all' : hasMentionsOnly ? 'mention-only' : undefined,
  };
}

/** Parse the `/watch-comment` command family. */
export function parseDocWatchCommand(content: string): DocWatchCommand {
  const arg = content.replace(/^\/watch-comment(?:\s+|$)/i, '').trim();
  if (!arg) return { kind: 'usage' };

  if (/^(list|列表)$/i.test(arg)) return { kind: 'list' };

  const off = /^(off|stop|unwatch|退订)(?:\s+([\s\S]+))?$/i.exec(arg);
  if (off) {
    const docRef = (off[2] ?? '').trim();
    return { kind: 'off', ...(docRef && docRef.toLowerCase() !== 'all' ? { docRef } : {}) };
  }

  return parseWatchSpec(arg);
}

/** Only the actual watch action needs a live/prewarmed AI session. */
export function docWatchCommandNeedsSession(content: string): boolean {
  return parseDocWatchCommand(content).kind === 'watch';
}
