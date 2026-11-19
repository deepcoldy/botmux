// 读关联群里各个会话的事实，合成群状态。本 bot 的会话直接读内存，其他 bot 的会话问所属 daemon；
// 问不到就记「读不到」，不拿落盘的旧行猜。
import type { SessionTaskFacts } from '../session-task-status.js';
import { aggregateChatTaskState, type ChatSessionProbe, type ChatTaskState } from './chat-task.js';

export interface ChatSessionRef {
  sessionId: string;
  larkAppId?: string;
  status: string;
  closedAt?: number;
}

export interface ChatTaskReaderDeps {
  ownAppId(): string;
  /** 本机所有 bot 在这个群里的会话（含已关闭）。 */
  chatSessions(chatIds: readonly string[]): Map<string, ChatSessionRef[]>;
  /** 本 bot 自己的会话行；不在本进程时 undefined。 */
  ownRow(sessionId: string): SessionTaskFacts | undefined;
  /** 其他 bot 的会话行；daemon 不在线、接口失败、超时时 undefined。 */
  peerRow(larkAppId: string, sessionId: string): Promise<SessionTaskFacts | undefined>;
  now?(): number;
}

/**
 * 其他 bot 的会话清单只留本机现在配置着的 bot：已经移除的 bot 留下的会话库里还有「开着」的会话，
 * 却永远没有 daemon 回答，会把整个群一直判成「读不到」。读不到配置（undefined）时不过滤。
 */
export function peerSessions<T extends { larkAppId?: string }>(
  sessions: Iterable<T>,
  ownAppId: string,
  configuredAppIds: ReadonlySet<string> | undefined,
): T[] {
  const out: T[] = [];
  for (const s of sessions) {
    if (!s.larkAppId || s.larkAppId === ownAppId) continue;
    if (configuredAppIds && !configuredAppIds.has(s.larkAppId)) continue;
    out.push(s);
  }
  return out;
}

/** 同一个会话短时间内重复展示（列表刷新、列表→详情）不重复跨进程读。 */
export const PEER_ROW_CACHE_MS = 5_000;
const PEER_CONCURRENCY = 6;

export class ChatTaskReader {
  private readonly peerCache = new Map<string, { at: number; row: SessionTaskFacts | undefined }>();

  constructor(private readonly deps: ChatTaskReaderDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private async peer(appId: string, sessionId: string, fresh: boolean): Promise<SessionTaskFacts | undefined> {
    const key = `${appId}:${sessionId}`;
    const hit = this.peerCache.get(key);
    if (!fresh && hit && this.now() - hit.at < PEER_ROW_CACHE_MS) return hit.row;
    let row: SessionTaskFacts | undefined;
    try { row = await this.deps.peerRow(appId, sessionId); } catch { row = undefined; }
    this.peerCache.set(key, { at: this.now(), row });
    while (this.peerCache.size > 256) this.peerCache.delete(this.peerCache.keys().next().value!);
    return row;
  }

  /** `fresh`：提醒前的核对不用缓存。 */
  async read(chatIds: readonly string[], opts: { fresh?: boolean } = {}): Promise<Map<string, ChatTaskState>> {
    const unique = [...new Set(chatIds)];
    const out = new Map<string, ChatTaskState>();
    if (unique.length === 0) return out;
    let sessions: Map<string, ChatSessionRef[]>;
    try {
      sessions = this.deps.chatSessions(unique);
    } catch {
      for (const id of unique) out.set(id, { chatId: id, kind: 'unreadable' });
      return out;
    }
    const own = this.deps.ownAppId();
    const tasks: Array<() => Promise<void>> = [];
    const probes = new Map<string, ChatSessionProbe[]>();
    for (const chatId of unique) {
      const list: ChatSessionProbe[] = [];
      probes.set(chatId, list);
      for (const ref of sessions.get(chatId) ?? []) {
        if (ref.status === 'closed') {
          list.push({ sessionId: ref.sessionId, closed: true, ...(ref.closedAt ? { closedAt: ref.closedAt } : {}) });
          continue;
        }
        if (!ref.larkAppId || ref.larkAppId === own) {
          const facts = this.deps.ownRow(ref.sessionId);
          list.push(facts ? { sessionId: ref.sessionId, facts } : { sessionId: ref.sessionId, unreadable: true });
          continue;
        }
        const appId = ref.larkAppId;
        tasks.push(async () => {
          const facts = await this.peer(appId, ref.sessionId, !!opts.fresh);
          list.push(facts ? { sessionId: ref.sessionId, facts } : { sessionId: ref.sessionId, unreadable: true });
        });
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PEER_CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) await tasks[next++]!();
    }));
    for (const [chatId, list] of probes) out.set(chatId, aggregateChatTaskState(chatId, list));
    return out;
  }
}
