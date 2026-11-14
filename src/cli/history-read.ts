import type { LarkMessage } from '../types.js';
import {
  parseApiMessage, extractResources, createImgNumberer, cardContentHasUpgradeFallback,
  type MessageResource,
} from '../im/lark/message-parser.js';
import type { ExpandMergeForwardFn, ResolveMergedCardFn } from './quoted-render.js';

export const HISTORY_READ_USAGE = 'botmux history [--limit N] [--scope session|thread|chat|ambient] [--view full|index] [--query text] [--type text,interactive] [--since ISO] [--until ISO] [--with-card-json] [--session-id id]';
export const QUOTED_READ_USAGE = 'botmux quoted <message_id> [<id> ...] [--raw] [--no-download] [--session-id id] (at most 20 ids)';

export interface HistoryReadOptions {
  view: 'full' | 'index';
  query?: string;
  types: string[];
  since?: number;
  until?: number;
}

export function parseHistoryReadOptions(args: string[]): HistoryReadOptions {
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
    return next;
  };
  const view = value('--view') ?? 'full';
  if (view !== 'full' && view !== 'index') throw new Error('--view must be full or index');
  if (view === 'index' && args.includes('--with-card-json')) throw new Error('--with-card-json requires --view full');
  const query = value('--query')?.trim();
  if (query === '') throw new Error('--query must not be empty');
  const types = (value('--type') ?? '').split(',').map(type => type.trim()).filter(Boolean);
  if (args.includes('--type') && (!types.length || types.some(type => !/^[a-z_]+$/.test(type)))) {
    throw new Error('--type requires comma-separated message types');
  }
  const timestamp = (flag: string): number | undefined => {
    const text = value(flag);
    if (text === undefined) return undefined;
    const parsed = Date.parse(text);
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) || !Number.isFinite(parsed)) throw new Error(`${flag} requires an ISO date or timestamp`);
    return parsed;
  };
  const since = timestamp('--since');
  const until = timestamp('--until');
  if (since !== undefined && until !== undefined && since >= until) throw new Error('--since must be earlier than --until');
  return { view, ...(query ? { query } : {}), types, ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) };
}

export async function mapHistoryReads<T, U>(items: readonly T[], work: (item: T) => Promise<U>, concurrency = 4): Promise<U[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid message read concurrency');
  const out = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  }));
  return out;
}

type HistoryMessage = LarkMessage & { resources?: MessageResource[]; cardJson?: unknown; queryMatch?: 'deferred' };

/** Filters apply inside the fetched --limit window, never imply a whole-chat search. */
export async function readHistoryMessages(
  appId: string,
  raw: any[],
  options: HistoryReadOptions,
  withCardJson: boolean,
  deps: { expandMergeForward: ExpandMergeForwardFn; resolveMergedCard: ResolveMergedCardFn },
) {
  const candidates = raw.filter(message => {
    const time = Number(message.create_time);
    if (options.since !== undefined && (!Number.isFinite(time) || time < options.since)) return false;
    if (options.until !== undefined && (!Number.isFinite(time) || time >= options.until)) return false;
    return !options.types.length || options.types.some(type => (type === 'merge_forward_expanded' ? 'merge_forward' : type) === message.msg_type);
  });
  const detailFailures: string[] = [];
  const detailsDeferred: string[] = [];
  const messages = (await mapHistoryReads(candidates, async rawMessage => {
    const numberer = createImgNumberer();
    let resources = extractResources(rawMessage.msg_type ?? 'text', rawMessage.body?.content ?? '', numberer);
    const parsed = parseApiMessage(rawMessage, numberer);
    let cardJson: unknown;
    let deferred = options.view === 'index' && ['interactive', 'merge_forward'].includes(parsed.msgType);
    if (options.view === 'full') {
      if (parsed.msgType === 'interactive' && (withCardJson || options.query !== undefined || cardContentHasUpgradeFallback(parsed.content))) {
        const merged = await deps.resolveMergedCard(appId, parsed.messageId, createImgNumberer()).catch(() => null);
        if (merged) {
          parsed.content = merged.text;
          resources = merged.resources;
          if (withCardJson && merged.structuredContent !== undefined) {
            try { cardJson = JSON.parse(merged.structuredContent); }
            catch { cardJson = merged.structuredContent; }
          }
        } else {
          deferred = true;
          detailFailures.push(parsed.messageId);
        }
      }
      if (parsed.msgType === 'merge_forward') {
        try {
          const expanded = await deps.expandMergeForward(appId, parsed.messageId, parsed, numberer);
          resources = [...resources, ...expanded.extraResources];
          if (cardContentHasUpgradeFallback(parsed.content)) {
            deferred = true;
            detailFailures.push(parsed.messageId);
          }
        } catch {
          deferred = true;
          detailFailures.push(parsed.messageId);
        }
      }
    }
    const matches = !options.query || [parsed.content, parsed.senderId, parsed.senderName ?? ''].join('\n').toLowerCase().includes(options.query.toLowerCase());
    if (!matches && !deferred) return undefined;
    if (deferred) detailsDeferred.push(parsed.messageId);
    const queryMatch = !matches && deferred ? { queryMatch: 'deferred' as const } : {};
    if (options.view === 'index') {
      const chars = Array.from(parsed.content.replace(/\s+/g, ' ').trim());
      return {
        messageId: parsed.messageId, rootId: parsed.rootId, senderId: parsed.senderId,
        senderType: parsed.senderType, ...(parsed.senderName ? { senderName: parsed.senderName } : {}),
        msgType: parsed.msgType, createTime: parsed.createTime,
        preview: chars.slice(0, 240).join(''), previewTruncated: chars.length > 240,
        resourceCount: resources.length, resourceTypes: [...new Set(resources.map(resource => resource.type))],
        detailsDeferred: deferred, ...queryMatch,
      };
    }
    return { ...parsed, ...(resources.length ? { resources } : {}), ...(cardJson !== undefined ? { cardJson } : {}), ...queryMatch } as HistoryMessage;
  })).filter(message => message !== undefined);
  return {
    messages,
    retrieval: {
      view: options.view, listedCount: raw.length, metadataMatchedCount: candidates.length,
      returnedCount: messages.length, detailsDeferred, detailFailures,
      filters: { ...(options.query ? { query: options.query } : {}), types: options.types,
        ...(options.since !== undefined ? { since: new Date(options.since).toISOString() } : {}),
        ...(options.until !== undefined ? { until: new Date(options.until).toISOString() } : {}) },
      filterScope: 'fetched-window' as const,
    },
  };
}

export function parseQuotedReadOptions(args: string[]) {
  const messageIds: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--session-id') {
      if (!args[++index] || args[index].startsWith('--')) throw new Error('--session-id requires a value');
    } else if (['--raw', '--no-download', '--remote-runner-session-tool'].includes(arg)) continue;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else {
      if (!/^om_[A-Za-z0-9_-]+$/.test(arg)) throw new Error(`Invalid message id: ${arg}`);
      messageIds.push(arg);
    }
  }
  const uniqueMessageIds = [...new Set(messageIds)];
  if (!uniqueMessageIds.length) throw new Error('quoted requires at least one message id');
  if (uniqueMessageIds.length > 20) throw new Error('quoted accepts at most 20 message ids');
  return { messageIds: uniqueMessageIds, batch: uniqueMessageIds.length > 1, download: !args.includes('--no-download') };
}
