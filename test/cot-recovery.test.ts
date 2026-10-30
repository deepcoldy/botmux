import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const request = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { cotEnabled: true, cliId: 'antigravity' } })),
  getBotClient: vi.fn(() => ({ request })),
}));
import { getBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import {
  abortCotMessage, canResumeCotMessage, cotRecoveryMatches, finalizeCotMessage,
  handleCotThinkingUpdate, resumeCotMessage, settleCotMessageForShutdown, sweepOrphanCotMessages,
} from '../src/im/lark/cot-message.js';

let dataDir: string;
let sequence = 0;
let entities: Map<string, { status: string; events: Array<{ type: string; content: any }> }>;
let intercept: ((req: any) => Promise<any> | undefined) | undefined;
const makeDs = (over: any = {}): any => ({
  larkAppId: 'app1', chatId: 'oc_chat', ...over,
  session: { sessionId: 'session1', rootMessageId: 'om_root', status: 'active',
    cliId: 'antigravity', cliSessionId: 'native1', backendType: 'tmux', ...(over.session ?? {}) },
});
const update = (ds: any, text: string, turnId = 'om_turn', dispatchAttempt?: number): boolean =>
  handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId, dispatchAttempt, entries: [{ kind: 'thinking', text }] });
const flush = async () => { await vi.advanceTimersByTimeAsync(1); };
const completes = () => request.mock.calls.filter(([req]) => req.url.includes('/complete/'));
const markers = () => {
  const dir = join(dataDir, 'cot-orphans');
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
};
const marker = () => JSON.parse(readFileSync(join(dataDir, 'cot-orphans', 'cot1.json'), 'utf8'));

function deliver(req: any): any {
  if (req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot') {
    const id = `cot${++sequence}`;
    entities.set(id, { status: 'open', events: [] });
    return { code: 0, data: { cot_id: id, message_id: `om_${id}` } };
  }
  const id = req.data?.cot_id ?? req.url.split('/').at(-1);
  const entity = entities.get(id);
  if (!entity) throw new Error('unknown entity');
  if (entity.status !== 'open') throw new Error('COT already in terminal state');
  if (req.method === 'PUT') {
    const events = req.data.events.map((e: any) => ({ type: e.event_type, content: JSON.parse(e.content) }));
    entity.events.push(...events);
    if (events.some((e: any) => e.type === 'RUN_FINISHED')) entity.status = 'done';
  } else entity.status = req.params.reason;
  return { code: 0, data: {} };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDir = mkdtempSync(join(tmpdir(), 'cot-recovery-'));
  config.session.dataDir = dataDir;
  entities = new Map(); sequence = 0; intercept = undefined;
  vi.mocked(getBot).mockReturnValue({ config: { cotEnabled: true, cliId: 'antigravity' } } as any);
  request.mockReset().mockImplementation(async req => intercept?.(req) ?? deliver(req));
});
afterEach(() => { vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }); });

describe('surviving agy thinking stream', () => {
  it.each(['graceful', 'crash'] as const)('resumes the same entity after %s daemon replacement', async mode => {
    const old = makeDs(); update(old, 'before'); await flush();
    const oldIds = entities.get('cot1')!.events.filter(e => e.type === 'REASONING_MESSAGE_START').map(e => e.content.messageId);
    if (mode === 'graceful') await settleCotMessageForShutdown(old);
    const next = makeDs();
    await sweepOrphanCotMessages('app1', binding => cotRecoveryMatches(next, binding));
    expect(entities.get('cot1')!.status).toBe('open'); expect(completes()).toHaveLength(0);
    expect(resumeCotMessage(next)).toBe(true);
    update(next, 'after'); await flush();
    expect(sequence).toBe(1);
    const ids = entities.get('cot1')!.events.filter(e => e.type === 'REASONING_MESSAGE_START').map(e => e.content.messageId);
    expect(ids).toHaveLength(oldIds.length + 1); expect(new Set(ids).size).toBe(ids.length);
    expect(finalizeCotMessage(next, 'om_turn', 'completed')).toBe(true); await flush();
    expect(entities.get('cot1')!.status).toBe('done'); expect(markers()).toEqual([]);
    finalizeCotMessage(next, 'om_turn', 'completed'); await flush(); expect(markers()).toEqual([]);
  });

  it('keeps a worker replacement open and closes it only on the matching terminal', async () => {
    const ds = makeDs(); update(ds, 'before', 'om_turn', 2); await flush();
    abortCotMessage(ds); await flush();
    expect(entities.get('cot1')!.status).toBe('open'); expect(marker().resumable).toBe(true);
    expect(resumeCotMessage(ds)).toBe(true); update(ds, 'after', 'om_turn', 2); await flush();
    expect(finalizeCotMessage(ds, 'om_turn', 'failed', 1)).toBe(false);
    expect(finalizeCotMessage(ds, 'om_turn', 'failed')).toBe(false);
    await flush(); expect(entities.get('cot1')!.status).toBe('open');
    finalizeCotMessage(ds, 'om_turn', 'completed', 2); await flush();
    expect(sequence).toBe(1); expect(entities.get('cot1')!.status).toBe('done');
  });

  it('lets a genuine success win over disconnect while an append is in flight', async () => {
    const ds = makeDs(); update(ds, 'before'); await flush();
    let release!: () => void;
    intercept = req => {
      if (req.method !== 'PUT') return;
      const result = deliver(req); intercept = undefined;
      return new Promise(resolve => { release = () => resolve(result); });
    };
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [
      { kind: 'thinking', text: 'before' }, { kind: 'thinking', text: 'after' },
    ] });
    await flush(); abortCotMessage(ds); finalizeCotMessage(ds, 'om_turn', 'completed');
    release(); await flush();
    expect(entities.get('cot1')!.status).toBe('done'); expect(completes().some(([r]) => r.params.reason === 'error')).toBe(false);
  });

  it('reserves node identities before a partially acknowledged batch', async () => {
    const ds = makeDs(); update(ds, 'before'); await flush();
    let batches = 0;
    intercept = req => {
      if (req.method === 'PUT' && ++batches === 2) return Promise.reject(new Error('lost append ACK'));
    };
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries:
      Array.from({ length: 26 }, (_, i) => ({ kind: 'thinking' as const, text: `step ${i}` })) });
    await flush(); abortCotMessage(ds); intercept = undefined;
    expect(entities.get('cot1')!.status).toBe('open');
    const next = makeDs(); expect(resumeCotMessage(next)).toBe(true);
    update(next, 'new reader segment'); await flush();
    const ids = entities.get('cot1')!.events.filter(e => e.type === 'REASONING_MESSAGE_START').map(e => e.content.messageId);
    expect(new Set(ids).size).toBe(ids.length); expect(sequence).toBe(1);
    finalizeCotMessage(next, 'om_turn', 'completed'); await flush(); expect(entities.get('cot1')!.status).toBe('done');
  });

  it('retains an unresolved create and adopts the IDs when its old response arrives', async () => {
    let release!: () => void;
    intercept = req => {
      if (req.method !== 'POST') return;
      const result = deliver(req); intercept = undefined;
      return new Promise(resolve => { release = () => resolve(result); });
    };
    const old = makeDs(); update(old, 'before'); await flush();
    await settleCotMessageForShutdown(old);
    const next = makeDs(); update(next, 'during handoff'); await flush();
    expect(sequence).toBe(1); expect(markers().some(f => f.startsWith('create-'))).toBe(true);
    release(); await flush();
    update(next, 'after handoff'); await flush();
    expect(sequence).toBe(1); expect(markers()).toEqual(['cot1.json']);
    expect(entities.get('cot1')!.events.some(e => e.type === 'REASONING_MESSAGE_CONTENT' && e.content.delta === 'after handoff')).toBe(true);
    finalizeCotMessage(next, 'om_turn', 'completed'); await flush(); expect(entities.get('cot1')!.status).toBe('done');
  });

  it('never retries a create whose successful remote outcome is unknown', async () => {
    intercept = req => {
      if (req.method !== 'POST') return;
      deliver(req); intercept = undefined;
      return Promise.reject(new Error('create response lost'));
    };
    const old = makeDs(); update(old, 'before'); await flush();
    const next = makeDs(); await sweepOrphanCotMessages('app1');
    update(next, 'after'); await flush(); update(next, 'after again'); await flush();
    expect(sequence).toBe(1); expect(completes()).toHaveLength(0);
    expect(markers()).toHaveLength(1); expect(markers()[0]).toMatch(/^create-/);
  });

  it.each(['larkAppId', 'chatId', 'sessionId', 'cliSessionId', 'target', 'turn', 'attempt'] as const)('does not adopt across a changed %s binding', async field => {
    const ds = makeDs(); update(ds, 'before', 'om_turn', 2); await flush(); await settleCotMessageForShutdown(ds);
    const over: any = field === 'larkAppId' ? { larkAppId: 'app2' } : field === 'chatId' ? { chatId: 'oc_other' }
      : { session: field === 'target' ? { persistentBackendTarget: { backendType: 'tmux', sessionName: 'other' } }
        : field === 'sessionId' || field === 'cliSessionId' ? { [field]: 'other' } : {} };
    const binding = { turnId: field === 'turn' ? 'om_other' : 'om_turn', dispatchAttempt: field === 'attempt' ? 1 : 2 };
    expect(resumeCotMessage(makeDs(over), binding)).toBe(false);
    expect(entities.get('cot1')!.status).toBe('open'); expect(sequence).toBe(1);
  });

  it('ignores a retired turn and attempt without closing the new stream', async () => {
    const ds = makeDs(); update(ds, 'old', 'om_old', 1); await flush();
    update(ds, 'new', 'om_new', 2); await flush();
    update(ds, 'late old', 'om_old', 1); await flush();
    expect(sequence).toBe(2); expect(entities.get('cot2')!.status).toBe('open');
    expect(finalizeCotMessage(ds, 'om_new', 'failed', 1)).toBe(false);
    const replacement = makeDs();
    update(replacement, 'late old after restart', 'om_old', 1); await flush();
    expect(sequence).toBe(2); expect(entities.get('cot2')!.status).toBe('open');
  });

  it.each(['app', 'chat', 'native'] as const)('rejects updates after the live %s identity changes', async field => {
    const ds = makeDs(); update(ds, 'before'); await flush(); request.mockClear();
    if (field === 'app') ds.larkAppId = 'other';
    else if (field === 'chat') ds.chatId = 'other';
    else ds.session.cliSessionId = 'other';
    expect(update(ds, 'after')).toBe(false);
    expect(finalizeCotMessage(ds, 'om_turn', 'completed')).toBe(false);
    abortCotMessage(ds); await settleCotMessageForShutdown(ds); await flush();
    expect(request).not.toHaveBeenCalled(); expect(entities.get('cot1')!.status).toBe('open');
    expect(marker().nativeSessionId).toBe('native1');
  });

  it.each(['failed', 'cancelled', 'ambiguous'] as const)('still completes a real %s terminal as error after restore', async status => {
    const ds = makeDs(); update(ds, 'before'); await flush(); await settleCotMessageForShutdown(ds);
    const next = makeDs(); finalizeCotMessage(next, 'om_turn', status); await flush();
    expect(entities.get('cot1')!.status).toBe('error'); expect(markers()).toEqual([]);
  });

  it('retains terminal intent on API failure and retries the original success after restart', async () => {
    const ds = makeDs(); update(ds, 'before'); await flush();
    intercept = () => Promise.reject(new Error('offline'));
    finalizeCotMessage(ds, 'om_turn', 'completed'); await flush();
    expect(entities.get('cot1')!.status).toBe('open'); expect(marker().finishStatus).toBe('done');
    intercept = undefined; await sweepOrphanCotMessages('app1');
    expect(entities.get('cot1')!.status).toBe('done'); expect(markers()).toEqual([]);
  });

  it.each(['response-json', 'business-code'] as const)('keeps a valid marker when sweep fails with %s', async failure => {
    const ds = makeDs(); update(ds, 'before'); await flush();
    intercept = () => failure === 'response-json'
      ? Promise.reject(new SyntaxError('invalid JSON response')) : Promise.resolve({ code: 123, data: {} });
    await sweepOrphanCotMessages('app1');
    expect(markers()).toEqual(['cot1.json']); expect(entities.get('cot1')!.status).toBe('open');
    intercept = undefined; await sweepOrphanCotMessages('app1');
    expect(markers()).toEqual([]); expect(entities.get('cot1')!.status).toBe('error');
  });

  it('uses the real success even if progress delivery had already failed', async () => {
    const ds = makeDs(); update(ds, 'before'); await flush();
    intercept = () => Promise.reject(new Error('offline'));
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [
      { kind: 'thinking', text: 'before' }, { kind: 'thinking', text: 'more' },
    ] }); await flush(); intercept = undefined;
    finalizeCotMessage(ds, 'om_turn', 'completed'); await flush();
    expect(entities.get('cot1')!.status).toBe('done'); expect(markers()).toEqual([]);
  });

  it.each([{ cliId: 'codex' }, { backendType: 'pty' }, { sandbox: 'oncall' }, { sandbox: 'scratch' },
    { suspendedColdResume: true }, { cliSessionId: undefined }, { adoptedFrom: { tmuxTarget: 'external:0.0' } }])('retains legacy shutdown semantics for %o', async session => {
    const ds = makeDs({ session }); expect(canResumeCotMessage(ds)).toBe(false);
    update(ds, 'before'); await flush(); await settleCotMessageForShutdown(ds);
    expect(entities.get('cot1')!.status).toBe('error');
  });
});
