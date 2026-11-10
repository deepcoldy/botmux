import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { config } from '../src/config.js';
import { getBot, getBotClient } from '../src/bot-registry.js';
import { finalizeCotMessage, handleCotThinkingUpdate, sweepOrphanCotMessages } from '../src/im/lark/cot-message.js';
import { trackStartingCardPublication } from '../src/core/starting-card-publication.js';
import { updateTurnReplyCard, updateReplyCardNativeThinking } from '../src/core/turn-reply-card.js';

vi.mock('../src/bot-registry.js', () => ({ getBot: vi.fn(), getBotClient: vi.fn(), normalizeUsageDisplay: () => 'off' }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionUsageSnapshot: vi.fn() }));
vi.mock('../src/im/lark/card-handler.js', () => ({ resolveCardOperatorUnionId: vi.fn() }));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}), uploadFile: vi.fn(), replyMessage: vi.fn(), sendMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

describe('independent native CoT adversarial lifecycle', () => {
  let dir: string;
  let bot: any;
  let ds: any;
  let request: ReturnType<typeof vi.fn>;
  let intercept: ((req: any) => Promise<any> | undefined) | undefined;
  let seq: number;
  let entities: Map<string, { status: string; events: any[] }>;
  const markers = () => existsSync(join(dir, 'cot-orphans')) ? readdirSync(join(dir, 'cot-orphans')).filter(f => f.endsWith('.json')) : [];
  const flush = async () => { await vi.advanceTimersByTimeAsync(1); };
  const until = async (condition: () => boolean) => {
    // The card store uses real filesystem IO; fake timer/microtask drains do
    // not guarantee it has finished, especially under Bun.
    const deadline = performance.now() + 3000;
    while (!condition() && performance.now() < deadline) { await flush(); await nextImmediate(); }
    expect(condition()).toBe(true);
  };
  function deliver(req: any) {
    if (req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot') {
      const id = `cot${++seq}`;
      entities.set(id, { status: 'open', events: [] });
      return { code: 0, data: { cot_id: id, message_id: `om_${id}` } };
    }
    const id = req.data?.cot_id ?? req.url.split('/').at(-1);
    const entity = entities.get(id)!;
    if (req.method === 'PUT') {
      const events = req.data.events.map((e: any) => ({ type: e.event_type, content: JSON.parse(e.content) }));
      entity.events.push(...events);
      if (events.some((e: any) => e.type === 'RUN_FINISHED')) entity.status = 'done';
    } else entity.status = req.params.reason;
    return { code: 0, data: {} };
  }
  const update = (text: string, turnId = 'om_turn') => handleCotThinkingUpdate(ds, {
    type: 'thinking_update', turnId, entries: [{ kind: 'thinking', text }],
  }, 'unified');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('BOTMUX_SANDBOX', undefined);
    dir = mkdtempSync(join(tmpdir(), 'native-cot-adversarial-'));
    config.session.dataDir = dir;
    bot = { config: { cotEnabled: false, replyCardNativeCot: true, replyCardMode: 'unified', cliId: 'codex' } };
    vi.mocked(getBot).mockReturnValue(bot);
    entities = new Map(); seq = 0; intercept = undefined;
    request = vi.fn(async req => intercept?.(req) ?? deliver(req));
    vi.mocked(getBotClient).mockReturnValue({ request } as any);
    ds = { larkAppId: 'app_adversarial', chatId: 'oc_chat', currentTurnId: 'om_turn',
      session: { sessionId: 'sid_adversarial', rootMessageId: 'om_root', status: 'active', cliId: 'codex', backendType: 'tmux' } };
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  it('settles a slow create exactly once even when the operator disables native CoT before its ACK', async () => {
    let release!: () => void;
    intercept = req => {
      if (req.method !== 'POST') return;
      const result = deliver(req); intercept = undefined;
      return new Promise(resolve => { release = () => resolve(result); });
    };
    expect(update('accepted progress')).toBe(true); await flush();
    bot.config.replyCardNativeCot = false;
    expect(update('disabled progress')).toBe(false);
    expect(finalizeCotMessage(ds, 'om_turn', 'completed')).toBe(true);
    release(); await until(() => entities.get('cot1')?.status === 'done' && markers().length === 0);
    expect(seq).toBe(1); expect(entities.get('cot1')?.status).toBe('done');
    expect(entities.get('cot1')!.events.filter(e => e.type === 'RUN_FINISHED')).toHaveLength(1);
    expect(entities.get('cot1')!.events.some(e => e.content.delta === 'disabled progress')).toBe(false);
    expect(markers()).toEqual([]);
  });

  it('closes an entity after prologue failure even when the native switch was then disabled', async () => {
    intercept = req => req.method === 'PUT' ? Promise.reject(new Error('prologue unavailable')) : undefined;
    update('before failure'); await flush();
    expect(seq).toBe(1); expect(markers()).toHaveLength(1);
    bot.config.replyCardNativeCot = false;
    finalizeCotMessage(ds, 'om_turn', 'failed');
    await until(() => entities.get('cot1')?.status === 'error' && markers().length === 0);
    expect(entities.get('cot1')?.status).toBe('error'); expect(markers()).toEqual([]);
    finalizeCotMessage(ds, 'om_turn', 'failed'); await flush();
    expect(request.mock.calls.filter(([req]) => req.url.includes('/complete/'))).toHaveLength(1);
  });

  it('retains a partial-write marker until a later startup sweep succeeds, even with both switches off', async () => {
    update('before restart'); await flush();
    expect(markers()).toHaveLength(1);
    bot.config.replyCardNativeCot = false;
    intercept = req => req.url.includes('/complete/') ? Promise.reject(new Error('completion unavailable')) : undefined;
    await sweepOrphanCotMessages('app_adversarial');
    expect(entities.get('cot1')?.status).toBe('open'); expect(markers()).toHaveLength(1);
    intercept = undefined;
    await sweepOrphanCotMessages('app_adversarial');
    expect(entities.get('cot1')?.status).toBe('error'); expect(markers()).toEqual([]);
    ds = { ...ds, session: { ...ds.session } };
    expect(update('after restart')).toBe(false); await flush(); expect(seq).toBe(1);
  });

  it('keeps terminal and successor timelines separate when an old append is slow', async () => {
    let release!: () => void;
    intercept = req => {
      if (req.method !== 'PUT' || !req.data.events.some((e: any) => e.event_type === 'REASONING_MESSAGE_CONTENT')) return;
      intercept = undefined;
      return new Promise(resolve => { release = () => resolve(deliver(req)); });
    };
    update('old'); await flush();
    finalizeCotMessage(ds, 'om_turn', 'completed');
    ds.currentTurnId = 'om_next'; update('next', 'om_next'); await flush();
    release(); await flush();
    expect(seq).toBe(2);
    expect(entities.get('cot1')?.status).toBe('done');
    expect(entities.get('cot2')?.status).toBe('open');
    finalizeCotMessage(ds, 'om_turn', 'completed');
    finalizeCotMessage(ds, 'om_next', 'completed'); await flush();
    expect(entities.get('cot1')!.events.filter(e => e.type === 'RUN_FINISHED')).toHaveLength(1);
    expect(entities.get('cot2')!.events.filter(e => e.type === 'RUN_FINISHED')).toHaveLength(1);
    expect(markers()).toEqual([]);
  });

  it('does not resurrect a pending native bubble when cancellation wins the starting-card wait', async () => {
    let release!: () => void;
    trackStartingCardPublication(ds, new Promise<void>(resolve => { release = resolve; }));
    bot.config.cotEnabled = true;
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [{ kind: 'thinking', text: 'waiting' }] });
    await flush(); expect(seq).toBe(0);
    finalizeCotMessage(ds, 'om_turn', 'cancelled');
    release(); await flush();
    expect(seq).toBe(0); expect(request).not.toHaveBeenCalled(); expect(markers()).toEqual([]);
  });

  it('holds the first answer until a slow native create and prologue both finish', async () => {
    let releaseCreate: (() => void) | undefined;
    let releasePrologue: (() => void) | undefined;
    intercept = req => {
      if (req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot') {
        return new Promise(resolve => { releaseCreate = () => resolve(deliver(req)); });
      }
      if (req.method === 'PUT' && req.data.events.some((e: any) => e.event_type === 'RUN_STARTED')) {
        return new Promise(resolve => { releasePrologue = () => resolve(deliver(req)); });
      }
    };
    const answer = vi.fn(async () => 'om_answer');
    const start = updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, answer);
    await until(() => releaseCreate !== undefined);
    expect(answer).not.toHaveBeenCalled();
    releaseCreate!(); await until(() => releasePrologue !== undefined);
    expect(answer).not.toHaveBeenCalled();
    releasePrologue!(); await start;
    expect(answer).toHaveBeenCalledTimes(1); expect(seq).toBe(1);
    finalizeCotMessage(ds, 'om_turn', 'completed'); await flush();
  });

  it('settles a fast terminal that arrives before the asynchronous first-card barrier creates its bubble', async () => {
    const answer = vi.fn(async () => 'om_answer');
    const start = updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, answer);
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await start; await flush();
    expect([...entities.values()].every(entity => entity.status !== 'open')).toBe(true);
    expect(markers()).toEqual([]);
  });

  it('keeps admission placeholder and attempt-bound thinking on the same native entity above the answer', async () => {
    ds.managedTurnOrigin = { capability: 'fixture', turnId: 'om_turn', dispatchAttempt: 1 };
    const answer = vi.fn(async () => 'om_answer');
    // The actual turn_execution_started path omits dispatchAttempt here.
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, answer);
    expect(seq).toBe(1);
    updateReplyCardNativeThinking(ds, { turnId: 'om_turn', dispatchAttempt: 1, entries: [{ kind: 'thinking', text: 'first transcript update' }] });
    await flush();
    expect(seq).toBe(1);
    expect(entities.get('cot1')!.events.some(e => e.content.delta === 'first transcript update')).toBe(true);
    finalizeCotMessage(ds, 'om_turn', 'completed', 1); await flush();
  });
});
