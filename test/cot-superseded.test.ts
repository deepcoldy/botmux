import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

interface Request {
  method: string;
  url: string;
  data?: { events?: Array<{ event_type: string; content: string }> };
}
const request = vi.fn(async (req: Request) => req.method === 'POST'
  ? { code: 0, data: { cot_id: 'cot-test', message_id: 'om-test' } }
  : { code: 0, data: {} });
const botConfig = { cotEnabled: true };
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: botConfig }),
  getBotClient: () => ({ request }),
}));
import { handleCotThinkingSuperseded, handleCotThinkingUpdate } from '../src/im/lark/cot-message.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ds = () => ({
  larkAppId: 'app', chatId: 'oc-test', session: { sessionId: 's1', rootMessageId: 'om-root' },
} as DaemonSession);
const update = (turnId = 'om-old', dispatchAttempt = 1): Extract<WorkerToDaemon, { type: 'thinking_update' }> => ({
  type: 'thinking_update', sessionId: 's1', turnId, dispatchAttempt,
  entries: [{ kind: 'tool_call', id: 'call', name: 'read', args: '{"path":"a.ts"}' }],
});
const supersede = (turnId = 'om-old', dispatchAttempt = 1): Extract<WorkerToDaemon, { type: 'thinking_superseded' }> => ({
  type: 'thinking_superseded', sessionId: 's1', turnId, dispatchAttempt,
});
const events = () => request.mock.calls.flatMap(([req]) => req.data?.events ?? []);

beforeEach(() => { request.mockClear(); botConfig.cotEnabled = true; });

describe('CoT superseded display notification', () => {
  it('flushes the old result and finishes once without needing any successor update', async () => {
    const session = ds();
    const msg = update();
    session.lastThinkingUpdate = msg;
    handleCotThinkingUpdate(session, msg);
    // Includes the in-flight create race: final data + supersession arrive
    // before the first request resolves, as they can within one worker batch.
    handleCotThinkingUpdate(session, { ...msg, entries: [...msg.entries, { kind: 'tool_result', id: 'call', result: 'ok' }] });
    expect(handleCotThinkingSuperseded(session, supersede())).toBe(true);
    expect(session.lastThinkingUpdate).toBeUndefined();
    await flush();
    expect(handleCotThinkingSuperseded(session, supersede())).toBe(true);
    await flush();
    const wire = events().map(event => event.event_type);
    expect(wire.filter(type => type === 'RUN_FINISHED')).toHaveLength(1);
    expect(wire.indexOf('TOOL_CALL_RESULT')).toBeLessThan(wire.indexOf('RUN_FINISHED'));
    expect(request.mock.calls.filter(([req]) => req.method === 'POST')).toHaveLength(1);
  });

  it('does not create a bubble for a turn that never had activity', async () => {
    expect(handleCotThinkingSuperseded(ds(), supersede())).toBe(false);
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a foreign session and a stale dispatch attempt, retaining the current cache', async () => {
    const session = ds();
    session.lastThinkingUpdate = update('om-old', 2);
    handleCotThinkingUpdate(session, session.lastThinkingUpdate as ReturnType<typeof update>);
    await flush();
    expect(handleCotThinkingSuperseded(session, supersede())).toBe(false);
    expect(handleCotThinkingSuperseded(session, { ...supersede('om-old', 2), sessionId: 'wrong' })).toBe(false);
    expect(session.lastThinkingUpdate?.dispatchAttempt).toBe(2);
    expect(events().some(event => event.event_type === 'RUN_FINISHED')).toBe(false);
    handleCotThinkingSuperseded(session, supersede('om-old', 2));
    await flush();
  });

  it('leaves a newer turn and its cache alive when an old notification arrives late', async () => {
    const session = ds();
    handleCotThinkingUpdate(session, update());
    await flush();
    handleCotThinkingUpdate(session, update('om-new'));
    session.lastThinkingUpdate = update('om-new');
    await flush();
    request.mockClear();
    handleCotThinkingSuperseded(session, supersede());
    await flush();
    expect(session.lastThinkingUpdate?.turnId).toBe('om-new');
    expect(request).not.toHaveBeenCalled();
    handleCotThinkingSuperseded(session, supersede('om-new'));
    await flush();
  });

  it('still closes an existing bubble after the user disables CoT', async () => {
    const session = ds();
    handleCotThinkingUpdate(session, update());
    await flush();
    botConfig.cotEnabled = false;
    handleCotThinkingSuperseded(session, supersede());
    await flush();
    expect(events().filter(event => event.event_type === 'RUN_FINISHED')).toHaveLength(1);
  });
});
