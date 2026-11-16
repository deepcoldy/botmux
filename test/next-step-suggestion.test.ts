import { describe, expect, it, vi } from 'vitest';
import { nextCardSequence } from '../src/core/card-element-writes.js';
import {
  nextStepIdle,
  noteNextStepCard,
  noteNextStepSuggestion,
  noteNextStepTurnStarted,
  type NextStepIo,
} from '../src/core/next-step-suggestion.js';
import { NEXT_STEP_ELEMENT_ID } from '../src/im/lark/next-step-card.js';
import { PromptSuggestionPublisher } from '../src/utils/prompt-suggestion-publisher.js';
import type { DaemonSession } from '../src/core/types.js';

function session(id = 'sess-next-step', currentTurnId?: string): DaemonSession {
  return { session: { sessionId: id }, larkAppId: 'cli_app', chatId: 'oc_chat', currentTurnId } as unknown as DaemonSession;
}

/** A sent legacy reply card: body, hr, chrome row with the footer inside. */
const LEGACY_CARD = JSON.stringify({ schema: '2.0', body: { elements: [
  { tag: 'markdown', content: 'answer' },
  { tag: 'hr' },
  { tag: 'column_set', element_id: 'botmux_reply_actions', columns: [{ tag: 'column', elements: [
    { tag: 'markdown', element_id: 'botmux_reply_footer', content: 'signature' },
  ] }] },
] } });

type Write =
  | { op: 'insert'; messageId: string; placement: unknown; text: string; sequence: number }
  | { op: 'replace'; messageId: string; text: string; sequence: number }
  | { op: 'remove'; messageId: string; sequence: number };

function buttonText(element: Record<string, any>): string {
  return element.columns[1].elements[0].text.content;
}

/** The sent card as Lark returns it, with the row when a write landed it. */
function cardWithRow(): string {
  const card = JSON.parse(LEGACY_CARD);
  card.body.elements.splice(2, 0, { tag: 'column_set', element_id: NEXT_STEP_ELEMENT_ID, columns: [] });
  return JSON.stringify(card);
}

function fakeIo(overrides: Partial<NextStepIo> = {}) {
  const writes: Write[] = [];
  const rows = new Set<string>();
  let clock = Date.UTC(2026, 10, 15, 1, 0, 0);
  const io: NextStepIo = {
    enabled: () => true,
    locale: () => 'zh',
    issue: (_ds, prompt) => ({ payload: `payload:${prompt}`, sig: 'sig' }),
    readCard: async (_ds, messageId) => rows.has(messageId) ? cardWithRow() : LEGACY_CARD,
    cardId: async messageId => `card_${messageId}`,
    insert: async (_ds, _cardId, messageId, placement, element, sequence) => {
      expect(element.element_id).toBe(NEXT_STEP_ELEMENT_ID);
      rows.add(messageId);
      writes.push({ op: 'insert', messageId, placement, text: buttonText(element), sequence });
    },
    replace: async (_ds, _cardId, messageId, element, sequence) => {
      writes.push({ op: 'replace', messageId, text: buttonText(element), sequence });
    },
    remove: async (_ds, _cardId, messageId, sequence) => { rows.delete(messageId); writes.push({ op: 'remove', messageId, sequence }); },
    now: () => clock,
    warn: vi.fn(),
    ...overrides,
  };
  return { io, writes, tick: (ms: number) => { clock += ms; } };
}

describe('next-step row placement', () => {
  it('waits for the turn card and then inserts above its footer row', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepSuggestion(ds, 'turn-1', 'CI 绿了就合', io);
    await nextStepIdle(ds);
    expect(writes).toEqual([]);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_answer' }, io);
    await nextStepIdle(ds);
    expect(writes).toMatchObject([{ op: 'insert', messageId: 'om_answer', text: 'CI 绿了就合',
      placement: { type: 'insert_before', targetElementId: 'botmux_reply_actions' } }]);
  });

  it('places a suggestion that arrives after the card, and updates it in place', async () => {
    const ds = session();
    const { io, writes, tick } = fakeIo();
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_answer' }, io);
    noteNextStepSuggestion(ds, 'turn-1', '查 CI 结果', io);
    await nextStepIdle(ds);
    tick(10);
    noteNextStepSuggestion(ds, 'turn-1', '查 CI 结果', io);
    noteNextStepSuggestion(ds, 'turn-1', '可以合了', io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, 'text' in write ? write.text : ''])).toEqual([
      ['insert', '查 CI 结果'], ['replace', '可以合了'],
    ]);
  });

  it('removes the row when the next turn starts and ignores the older turn afterwards', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    noteNextStepSuggestion(ds, 'turn-1', '确认发版', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    // Late facts about turn-1 (a slow suggestion, a replayed terminal).
    noteNextStepSuggestion(ds, 'turn-1', '确认发版 v3.59.9', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, write.messageId])).toEqual([['insert', 'om_one'], ['remove', 'om_one']]);
  });

  it('removes a row whose insert was still in flight when the next turn started', async () => {
    const ds = session();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { io, writes } = fakeIo();
    const insert = io.insert;
    let started = false;
    io.insert = async (...args) => { started = true; await gate; return insert(...args); };
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    noteNextStepSuggestion(ds, 'turn-1', '继续盯 MR 到合入', io);
    await vi.waitFor(() => expect(started).toBe(true));
    noteNextStepTurnStarted(ds, 'turn-2', io);
    release();
    await nextStepIdle(ds);
    expect(writes.map(write => write.op)).toEqual(['insert', 'remove']);
  });

  it('removes a row inserted by the only write in flight when the next turn started', async () => {
    const ds = session();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { io, writes } = fakeIo();
    const insert = io.insert;
    io.insert = async (...args) => { await gate; return insert(...args); };
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepSuggestion(ds, 'turn-1', '继续盯 MR 到合入', io);
    await nextStepIdle(ds);
    // The card settles last: its single write is the only one queued.
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    noteNextStepTurnStarted(ds, 'turn-2', io);
    release();
    await nextStepIdle(ds);
    expect(writes.map(write => write.op)).toEqual(['insert', 'remove']);
  });

  it('never puts an older turn back once the next one started', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    // turn-1's card and suggestion arrive late, in this order.
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    noteNextStepSuggestion(ds, 'turn-1', '确认发版', io);
    await nextStepIdle(ds);
    expect(writes).toEqual([]);
  });

  it('removes a row whose insert outcome was unknown (a timeout after it landed)', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    const insert = io.insert;
    io.insert = async (...args) => { await insert(...args); throw new Error('socket timeout'); };
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    await nextStepIdle(ds);
    noteNextStepSuggestion(ds, 'turn-1', '查 CI 结果', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, write.messageId])).toEqual([['insert', 'om_one'], ['remove', 'om_one']]);
  });

  it('retries a failed removal without holding up the next card', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    const remove = io.remove;
    let failures = 1;
    io.remove = async (...args) => { if (failures-- > 0) throw new Error('provider 5xx'); return remove(...args); };
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    noteNextStepSuggestion(ds, 'turn-1', 'a', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    noteNextStepCard(ds, 'turn-2', { kind: 'legacy', messageId: 'om_two' }, io);
    noteNextStepSuggestion(ds, 'turn-2', 'b', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-3', io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, write.messageId])).toEqual([
      ['insert', 'om_one'], ['insert', 'om_two'], ['remove', 'om_one'], ['remove', 'om_two'],
    ]);
  });

  it('clears a unified row whose publication failed after the record was written', async () => {
    const ds = session();
    const { io } = fakeIo();
    const published: Array<string | undefined> = [];
    let fail = true;
    const card = { kind: 'unified' as const, publish: async (next: { text: string } | undefined) => {
      published.push(next?.text);
      if (fail) { fail = false; throw new Error('PATCH failed after the record was persisted'); }
    } };
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', card, io);
    await nextStepIdle(ds);
    noteNextStepSuggestion(ds, 'turn-1', '确认发版', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    await nextStepIdle(ds);
    expect(published).toEqual(['确认发版', undefined]);
  });

  it('after a restart, lets the session lineage decide which turn is current', async () => {
    const ds = session('sess-restarted', 'turn-2');
    const { io, writes } = fakeIo();
    // A replayed older terminal arrives first: it must not claim the session.
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    noteNextStepSuggestion(ds, 'turn-1', '旧推荐', io);
    noteNextStepCard(ds, 'turn-2', { kind: 'legacy', messageId: 'om_two' }, io);
    noteNextStepSuggestion(ds, 'turn-2', '新推荐', io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, write.messageId, 'text' in write ? write.text : ''])).toEqual([
      ['insert', 'om_two', '新推荐'],
    ]);
  });

  it('moves to the next turn card instead of updating the old one', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    noteNextStepSuggestion(ds, 'turn-1', '查 CI 结果', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    noteNextStepCard(ds, 'turn-2', { kind: 'legacy', messageId: 'om_two' }, io);
    noteNextStepSuggestion(ds, 'turn-2', '可以合了', io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, write.messageId])).toEqual([
      ['insert', 'om_one'], ['remove', 'om_one'], ['insert', 'om_two'],
    ]);
  });

  it('applies facts that arrive together as their latest state', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    noteNextStepSuggestion(ds, 'turn-1', '查 CI 结果', io);
    noteNextStepSuggestion(ds, 'turn-1', '可以合了', io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, 'text' in write ? write.text : ''])).toEqual([['insert', '可以合了']]);
  });

  it('makes no card writes while the bot switch is off', async () => {
    const ds = session();
    const { io, writes } = fakeIo({ enabled: () => false });
    const readCard = vi.spyOn(io, 'readCard');
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_answer' }, io);
    noteNextStepSuggestion(ds, 'turn-1', 'CI 绿了就合', io);
    await nextStepIdle(ds);
    expect(writes).toEqual([]);
    expect(readCard).not.toHaveBeenCalled();
  });

  it('leaves a card it cannot read or edit alone', async () => {
    const ds = session();
    const { io, writes } = fakeIo({ readCard: async () => undefined });
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_gone' }, io);
    noteNextStepSuggestion(ds, 'turn-1', 'CI 绿了就合', io);
    await nextStepIdle(ds);
    expect(writes).toEqual([]);
  });

  it('retries an unacknowledged write by what the card shows', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    const insert = io.insert;
    let timeouts = 1;
    io.insert = async (...args) => { await insert(...args); if (timeouts-- > 0) throw new Error('socket timeout'); };
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_one' }, io);
    await nextStepIdle(ds);
    noteNextStepSuggestion(ds, 'turn-1', 'a', io);
    await nextStepIdle(ds);
    noteNextStepSuggestion(ds, 'turn-1', 'b', io);
    await nextStepIdle(ds);
    // The timed-out insert had landed: the next write replaces, never a second row.
    expect(writes.map(write => [write.op, 'text' in write ? write.text : ''])).toEqual([['insert', 'a'], ['replace', 'b']]);
  });

  it('replaces instead of inserting twice when the card already carries a row', async () => {
    const ds = session();
    const withRow = JSON.parse(LEGACY_CARD);
    withRow.body.elements.splice(2, 0, { tag: 'column_set', element_id: NEXT_STEP_ELEMENT_ID, columns: [] });
    const { io, writes } = fakeIo({ readCard: async () => JSON.stringify(withRow) });
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_answer' }, io);
    noteNextStepSuggestion(ds, 'turn-1', 'CI 绿了就合', io);
    await nextStepIdle(ds);
    expect(writes.map(write => write.op)).toEqual(['replace']);
  });

  it('writes each card with a sequence above the footer receipt and strictly increasing', async () => {
    const ds = session();
    const { io, writes } = fakeIo();
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_seq' }, io);
    noteNextStepSuggestion(ds, 'turn-1', 'a', io);
    await nextStepIdle(ds);
    noteNextStepSuggestion(ds, 'turn-1', 'b', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    await nextStepIdle(ds);
    const sequences = writes.map(write => write.sequence);
    expect(sequences).toHaveLength(3);
    expect(sequences[0]).toBeGreaterThan(1);
    expect(sequences[1]).toBeGreaterThan(sequences[0]);
    expect(sequences[2]).toBeGreaterThan(sequences[1]);
  });

  it('keeps sequences increasing across restarts (clock based)', () => {
    const before = nextCardSequence('om_restart', Date.UTC(2026, 10, 15, 1, 0, 0));
    expect(nextCardSequence('om_other_process', Date.UTC(2026, 10, 15, 1, 0, 5))).toBeGreaterThan(before);
  });

  it('publishes and clears through the unified record', async () => {
    const ds = session();
    const { io } = fakeIo();
    const published: Array<string | undefined> = [];
    const card = { kind: 'unified' as const, publish: async (next: { text: string } | undefined) => { published.push(next?.text); } };
    noteNextStepTurnStarted(ds, 'turn-1', io);
    noteNextStepCard(ds, 'turn-1', card, io);
    noteNextStepSuggestion(ds, 'turn-1', '看下 bun-test 跑完没', io);
    await nextStepIdle(ds);
    noteNextStepTurnStarted(ds, 'turn-2', io);
    await nextStepIdle(ds);
    expect(published).toEqual(['看下 bun-test 跑完没', undefined]);
  });

  it('keeps going after a failed write', async () => {
    const ds = session();
    const warn = vi.fn();
    let fail = true;
    const { io, writes } = fakeIo({ warn });
    const insert = io.insert;
    io.insert = async (...args) => { if (fail) { fail = false; throw new Error('provider 5xx'); } return insert(...args); };
    noteNextStepCard(ds, 'turn-1', { kind: 'legacy', messageId: 'om_retry' }, io);
    await nextStepIdle(ds);
    noteNextStepSuggestion(ds, 'turn-1', 'a', io);
    await nextStepIdle(ds);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider 5xx'));
    noteNextStepSuggestion(ds, 'turn-1', 'b', io);
    await nextStepIdle(ds);
    expect(writes.map(write => [write.op, 'text' in write ? write.text : ''])).toEqual([['insert', 'b']]);
  });
});

describe('PromptSuggestionPublisher', () => {
  const t1 = { turnId: 't1', dispatchAttempt: 2 };
  it('sends only an idle, turn-owned suggestion, once per turn and text', () => {
    const publisher = new PromptSuggestionPublisher();
    publisher.observe('CI 绿了就合', t1);
    expect(publisher.take('working', t1)).toBeUndefined();
    expect(publisher.take('idle', {})).toBeUndefined();
    expect(publisher.take('idle', t1)).toEqual({ text: 'CI 绿了就合', turnId: 't1', dispatchAttempt: 2 });
    expect(publisher.take('idle', t1)).toBeUndefined();
    // A draft hides it for a while; the same suggestion coming back is not news.
    publisher.observe(undefined, t1);
    expect(publisher.take('idle', t1)).toBeUndefined();
    publisher.observe('CI 绿了就合', t1);
    expect(publisher.take('idle', t1)).toBeUndefined();
    publisher.observe('可以合了', t1);
    expect(publisher.take('idle', t1)?.text).toBe('可以合了');
    // The same text seen again under the next turn is that turn's suggestion.
    publisher.observe('可以合了', { turnId: 't2' });
    expect(publisher.take('idle', { turnId: 't2' })).toEqual({ text: '可以合了', turnId: 't2' });
  });

  it('never publishes a frame captured under the previous turn as the new turn\'s', () => {
    const publisher = new PromptSuggestionPublisher();
    publisher.observe('确认发版', t1);
    // The next turn's input is written; no frame has been captured since.
    expect(publisher.take('idle', { turnId: 't2' })).toBeUndefined();
  });
});
