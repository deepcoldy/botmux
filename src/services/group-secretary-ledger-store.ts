/**
 * 群秘书「任务台账」：每个话题一行（谁在做、现在什么状态、最近一次巡查摘要、要不要上报）。
 *
 * 话题巡查回合结束前用 `botmux secretary report` 写一行；主群总管回合从这里读全局，
 * 不再把各话题的原始对话塞进同一个长会话。台账是上下文连续性的唯一来源：巡查会话用完即关、
 * 总管会话被压缩或重启，信息都还在这里。
 *
 * CLI（巡查会话里）与 daemon 是不同进程，落盘共享：
 * `${dataDir}/group-secretary-ledger-${appId}.json`，tmp + rename 原子写，每次读都读盘（量很小）。
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export const LEDGER_STATUSES = ['working', 'blocked', 'stalled', 'waiting_human', 'done', 'idle'] as const;
export type LedgerStatus = typeof LEDGER_STATUSES[number];

export interface LedgerHistoryItem {
  at: number;
  status: LedgerStatus;
  summary: string;
}

export interface LedgerEscalation {
  text: string;
  at: number;
  /** 已交给总管回合的时间；未交付时缺省。 */
  deliveredAt?: number;
}

export interface LedgerEntry {
  chatId: string;
  threadRoot: string;
  status: LedgerStatus;
  summary: string;
  updatedAt: number;
  /** 在这个话题干活的 bot（巡查时看到的）。 */
  botName?: string;
  /** 由 daemon 兜底写入（巡查没写台账）时为 true。 */
  auto?: boolean;
  /** 最近几次的状态与摘要（新的在后），给下一次巡查做连续上下文。 */
  history: LedgerHistoryItem[];
  escalation?: LedgerEscalation;
}

export const MAX_LEDGER_HISTORY = 5;
export const MAX_LEDGER_SUMMARY_CHARS = 400;
export const MAX_LEDGER_ENTRIES_PER_APP = 200;
/** 多久没更新的话题从台账里清掉。 */
export const LEDGER_TTL_MS = 3 * 24 * 3_600_000;

function filePath(larkAppId: string, dataDir = config.session.dataDir): string {
  return join(dataDir, `group-secretary-ledger-${larkAppId}.json`);
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function isStatus(v: unknown): v is LedgerStatus {
  return typeof v === 'string' && (LEDGER_STATUSES as readonly string[]).includes(v);
}

function sanitize(raw: any): LedgerEntry | undefined {
  if (typeof raw?.chatId !== 'string' || !raw.chatId.startsWith('oc_')) return undefined;
  if (typeof raw?.threadRoot !== 'string' || !raw.threadRoot.startsWith('om_')) return undefined;
  if (!isStatus(raw.status) || !Number.isFinite(raw.updatedAt)) return undefined;
  const history: LedgerHistoryItem[] = Array.isArray(raw.history)
    ? raw.history
      .filter((h: any) => isStatus(h?.status) && Number.isFinite(h?.at) && typeof h?.summary === 'string')
      .map((h: any) => ({ at: h.at, status: h.status, summary: clip(h.summary, MAX_LEDGER_SUMMARY_CHARS) }))
      .slice(-MAX_LEDGER_HISTORY)
    : [];
  const esc = raw.escalation;
  return {
    chatId: raw.chatId,
    threadRoot: raw.threadRoot,
    status: raw.status,
    summary: typeof raw.summary === 'string' ? clip(raw.summary, MAX_LEDGER_SUMMARY_CHARS) : '',
    updatedAt: raw.updatedAt,
    ...(typeof raw.botName === 'string' && raw.botName ? { botName: raw.botName } : {}),
    ...(raw.auto === true ? { auto: true } : {}),
    history,
    ...(esc && typeof esc.text === 'string' && esc.text && Number.isFinite(esc.at)
      ? { escalation: { text: clip(esc.text, MAX_LEDGER_SUMMARY_CHARS), at: esc.at, ...(Number.isFinite(esc.deliveredAt) ? { deliveredAt: esc.deliveredAt } : {}) } }
      : {}),
  };
}

function load(larkAppId: string, dataDir?: string, now = Date.now()): LedgerEntry[] {
  const path = filePath(larkAppId, dataDir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const list = Array.isArray(raw?.entries) ? raw.entries : [];
    return list.map(sanitize).filter((e: LedgerEntry | undefined): e is LedgerEntry => !!e && now - e.updatedAt < LEDGER_TTL_MS);
  } catch {
    return [];
  }
}

function save(larkAppId: string, entries: LedgerEntry[], dataDir?: string): void {
  const path = filePath(larkAppId, dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const kept = [...entries].sort((a, b) => a.updatedAt - b.updatedAt).slice(-MAX_LEDGER_ENTRIES_PER_APP);
  atomicWriteFileSync(path, JSON.stringify({ version: 1, entries: kept }, null, 2));
}

export function listLedger(larkAppId: string, chatId: string, dataDir?: string, now = Date.now()): LedgerEntry[] {
  return load(larkAppId, dataDir, now)
    .filter(e => e.chatId === chatId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getLedgerEntry(larkAppId: string, chatId: string, threadRoot: string, dataDir?: string, now = Date.now()): LedgerEntry | undefined {
  return load(larkAppId, dataDir, now).find(e => e.chatId === chatId && e.threadRoot === threadRoot);
}

/**
 * 写一行台账。同一话题再次写入 = 更新状态与摘要，旧值进 history。
 * escalate 有内容时挂一条新的待上报（覆盖未交付的旧上报）；没有时保留旧的待上报不动。
 */
export function recordLedger(larkAppId: string, input: {
  chatId: string;
  threadRoot: string;
  status: LedgerStatus;
  summary: string;
  botName?: string;
  escalate?: string;
  auto?: boolean;
  at?: number;
}, dataDir?: string): LedgerEntry {
  if (!isStatus(input.status)) throw new Error(`--status 只接受 ${LEDGER_STATUSES.join(' | ')}`);
  const at = input.at ?? Date.now();
  const all = load(larkAppId, dataDir, at);
  const prev = all.find(e => e.chatId === input.chatId && e.threadRoot === input.threadRoot);
  const summary = clip(input.summary, MAX_LEDGER_SUMMARY_CHARS);
  const history = [...(prev?.history ?? []), { at, status: input.status, summary }].slice(-MAX_LEDGER_HISTORY);
  const escalateText = input.escalate?.trim();
  const entry: LedgerEntry = {
    chatId: input.chatId,
    threadRoot: input.threadRoot,
    status: input.status,
    summary,
    updatedAt: at,
    ...(input.botName ?? prev?.botName ? { botName: (input.botName ?? prev?.botName)! } : {}),
    ...(input.auto ? { auto: true } : {}),
    history,
    ...(escalateText
      ? { escalation: { text: clip(escalateText, MAX_LEDGER_SUMMARY_CHARS), at } }
      : prev?.escalation ? { escalation: prev.escalation } : {}),
  };
  save(larkAppId, [...all.filter(e => e !== prev), entry], dataDir);
  return entry;
}

/** 本群还没交给总管的上报（旧→新）。 */
export function pendingEscalations(larkAppId: string, chatId: string, dataDir?: string, now = Date.now()): LedgerEntry[] {
  return listLedger(larkAppId, chatId, dataDir, now)
    .filter(e => e.escalation && e.escalation.deliveredAt === undefined)
    .sort((a, b) => a.escalation!.at - b.escalation!.at);
}

/** 总管回合投递成功后标记这些上报已交付（只认同一次上报：at 一致）。 */
export function markEscalationsDelivered(
  larkAppId: string,
  chatId: string,
  items: Array<{ threadRoot: string; at: number }>,
  deliveredAt = Date.now(),
  dataDir?: string,
): number {
  if (items.length === 0) return 0;
  const all = load(larkAppId, dataDir, deliveredAt);
  let n = 0;
  const next = all.map(e => {
    if (e.chatId !== chatId || !e.escalation || e.escalation.deliveredAt !== undefined) return e;
    if (!items.some(i => i.threadRoot === e.threadRoot && i.at === e.escalation!.at)) return e;
    n++;
    return { ...e, escalation: { ...e.escalation, deliveredAt } };
  });
  if (n > 0) save(larkAppId, next, dataDir);
  return n;
}
