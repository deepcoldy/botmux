/**
 * Keeping the「本轮回顾」panel on the latest turn's last card in step with
 * what is known: the turn's facts when its card settles, the CLI's own recap
 * when it arrives, and the optional model recap after a quiet stretch.
 *
 * The card side is an in-memory CardKit card with the semantics observed on
 * live cards: an insert of an id the card already has is refused with
 * "Duplicate ID", and a read-back lists inserted collapsible panels.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  noteCliRecap,
  noteRecapCard,
  noteRecapTurnStarted,
  recapIdle,
  RECAP_MODEL_IDLE_MS,
  type RecapIo,
} from '../src/core/turn-recap-state.js';
import { serializeCardWrite } from '../src/core/card-element-writes.js';
import { buildNextStepElement, NEXT_STEP_ELEMENT_ID } from '../src/im/lark/next-step-card.js';
import { buildCardBodyElements, buildReplyCardFooterElements, createReplyCard } from '../src/im/lark/md-card.js';
import { TURN_RECAP_ELEMENT_ID } from '../src/im/lark/turn-recap-card.js';
import { claudeAwaySummaryText, type RecapFacts } from '../src/services/turn-recap.js';
import type { DaemonSession } from '../src/core/types.js';

const away = readFileSync(resolve('test/fixtures/turn-recap/claude-away-summary.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const SUMMARY = claudeAwaySummaryText(away[1])!;
const FACTS: RecapFacts = { files: ['src/utils/terminal-cells.ts'], commands: 1, lastCommand: 'git log --oneline -1 HEAD' };
const INPUT = { facts: FACTS, modelPrompt: 'Language: Simplified Chinese\n\nTurn record:\nTool Bash: git log' };

function session(): DaemonSession {
  return { session: { sessionId: 'sess-recap-0001' }, larkAppId: 'cli_app', chatId: 'oc_chat', currentTurnId: undefined } as unknown as DaemonSession;
}

interface Write { op: 'insert' | 'replace'; messageId: string; sequence: number; markdown: string; target?: string }

function harness(over: Partial<RecapIo> = {}) {
  const cards = new Map<string, any>();
  const writes: Write[] = [];
  const attempts = { insert: 0 };
  const warnings: string[] = [];
  const modelPrompts: string[] = [];
  const modelAnswers: Array<(text: string | undefined) => void> = [];
  const send = (messageId: string) => {
    cards.set(messageId, createReplyCard([
      ...buildCardBodyElements('最终答复'),
      ...buildReplyCardFooterElements({ presentation: { footerPreferences: { enabled: true } } } as any),
    ]));
    return messageId;
  };
  const panelOf = (messageId: string) => cards.get(messageId)?.body.elements.find((element: any) => element.element_id === TURN_RECAP_ELEMENT_ID);
  const io: RecapIo = {
    enabled: () => true,
    modelEnabled: () => false,
    showFacts: () => true,
    locale: () => 'zh',
    readCard: async (_ds, messageId) => JSON.stringify(cards.get(messageId)),
    cardId: async (_ds, messageId) => `card_${messageId}`,
    async insert(_ds, _cardId, messageId, placement, element, sequence) {
      attempts.insert += 1;
      const card = cards.get(messageId);
      if (card.body.elements.some((existing: any) => existing.element_id === TURN_RECAP_ELEMENT_ID)) {
        throw new Error('Failed to insert CardKit elements: ErrMsg: msg: [ElementID botmux_turn_recap: Code 1001: Duplicate ID], code: 300301;  (code: 300315)');
      }
      const target = placement.type === 'insert_before' ? placement.targetElementId : undefined;
      const index = target ? card.body.elements.findIndex((existing: any) => existing.element_id === target) : card.body.elements.length;
      if (index < 0) throw new Error(`Failed to insert CardKit elements: target ${target} not found`);
      card.body.elements.splice(index, 0, element);
      writes.push({ op: 'insert', messageId, sequence, markdown: (element as any).elements[0].content, ...(target ? { target } : {}) });
    },
    async replace(_ds, _cardId, messageId, element, sequence) {
      const card = cards.get(messageId);
      const index = card.body.elements.findIndex((existing: any) => existing.element_id === TURN_RECAP_ELEMENT_ID);
      if (index < 0) throw new Error('Failed to update CardKit element: element not found');
      card.body.elements[index] = element;
      writes.push({ op: 'replace', messageId, sequence, markdown: (element as any).elements[0].content });
    },
    modelRecap: async (_ds, prompt) => {
      modelPrompts.push(prompt);
      return new Promise(resolve => { modelAnswers.push(resolve); });
    },
    setTimer(run, ms) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    warn: message => { warnings.push(message); },
    ...over,
  };
  return {
    io, cards, writes, attempts, warnings, send, panelOf, modelPrompts,
    ids: (messageId: string): string[] => cards.get(messageId).body.elements.map((element: any) => element.element_id ?? element.tag),
    /** Answers the latest model call, or the `index`-th one. */
    answer: (text: string | undefined, index = modelAnswers.length - 1) => modelAnswers[index]!(text),
  };
}

const ticks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const settle = async (ds: DaemonSession) => {
  for (let i = 0; i < 5; i++) {
    await recapIdle(ds);
    await Promise.resolve();
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T03:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('legacy reply card', () => {
  it('puts the facts above the footer when the card settles, then adds the CLI recap in place', async () => {
    const ds = session();
    const run = harness();
    const messageId = run.send('om_card1');
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId }, INPUT, run.io);
    await settle(ds);
    expect(run.writes).toEqual([expect.objectContaining({ op: 'insert', target: 'botmux_reply_footer', markdown: expect.stringContaining('**做了什么**') })]);
    expect(run.writes[0]!.markdown).not.toContain(SUMMARY);

    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    expect(run.writes).toHaveLength(2);
    expect(run.writes[1]!.op).toBe('replace');
    expect(run.writes[1]!.markdown.startsWith(SUMMARY)).toBe(true);
    expect(run.writes[1]!.markdown).toContain('来自 CLI 自带的离开总结');
    expect(run.writes[1]!.markdown).toContain('**做了什么**');
    expect(run.writes[1]!.sequence).toBeGreaterThan(run.writes[0]!.sequence);

    // The same recap again (a re-read transcript), or the same card settling
    // again (a replayed terminal), changes nothing.
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId }, INPUT, run.io);
    await settle(ds);
    expect(run.writes).toHaveLength(2);
  });

  it('writes a CLI recap that arrived before the card settled with the first insert', async () => {
    const ds = session();
    const run = harness();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    expect(run.writes).toEqual([]);
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await settle(ds);
    expect(run.writes).toEqual([expect.objectContaining({ op: 'insert', markdown: expect.stringContaining(SUMMARY) })]);
  });

  it('leaves an older turn\'s card alone once a new turn started', async () => {
    const ds = session();
    const run = harness();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await settle(ds);
    noteRecapTurnStarted(ds, 'om_turn2');
    // Late facts for the old turn: its recap and a duplicate card settle.
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: 'om_card1' }, INPUT, run.io);
    await settle(ds);
    expect(run.writes).toHaveLength(1);
    expect(run.panelOf('om_card1').elements[0].content).not.toContain(SUMMARY);
  });

  it('updates in place when an earlier write landed but its answer was lost', async () => {
    const ds = session();
    const lost = harness();
    const insert = lost.io.insert;
    let first = true;
    lost.io.insert = async (...args) => {
      await insert(...args);
      if (first) { first = false; throw new Error('socket hang up'); }
    };
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: lost.send('om_card1') }, INPUT, lost.io);
    await settle(ds);
    noteCliRecap(ds, 'om_turn1', SUMMARY, lost.io);
    await settle(ds);
    expect(lost.writes.map(write => write.op)).toEqual(['insert', 'replace']);
    // The card was read again rather than inserted into a second time.
    expect(lost.attempts.insert).toBe(1);
    expect(lost.panelOf('om_card1').elements[0].content).toContain(SUMMARY);
  });

  it('inserts again when an earlier insert did not land', async () => {
    const ds = session();
    const run = harness();
    const insert = run.io.insert;
    let fail = true;
    run.io.insert = async (...args) => {
      if (fail) { fail = false; throw new Error('Failed to insert CardKit elements: rate limited'); }
      return insert(...args);
    };
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await settle(ds);
    expect(run.panelOf('om_card1')).toBeUndefined();
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    expect(run.writes.map(write => write.op)).toEqual(['insert']);
    expect(run.panelOf('om_card1').elements[0].content).toContain(SUMMARY);
  });

  it('falls back to an update when CardKit already has the panel the read-back does not show yet', async () => {
    const ds = session();
    const run = harness();
    const messageId = run.send('om_card1');
    const stale = JSON.stringify(run.cards.get(messageId));
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId }, INPUT, run.io);
    await settle(ds);
    run.io.readCard = async () => stale;
    let fail = true;
    const replace = run.io.replace;
    run.io.replace = async (...args) => {
      if (fail) { fail = false; throw new Error('socket hang up'); }
      return replace(...args);
    };
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    noteCliRecap(ds, 'om_turn1', `${SUMMARY} `.trim() + '（更新）', run.io);
    await settle(ds);
    expect(run.panelOf('om_card1').elements[0].content).toContain('（更新）');
    expect(run.cards.get(messageId).body.elements.filter((element: any) => element.element_id === TURN_RECAP_ELEMENT_ID)).toHaveLength(1);
  });

  it('keeps a turn\'s facts when a repeated terminal for it knows nothing', async () => {
    const ds = session();
    const run = harness();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await settle(ds);
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: 'om_card1' }, { facts: { files: [], commands: 0 } }, run.io);
    // Nor when a later report for the same turn knows less, but something.
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: 'om_card1' }, { facts: { files: [], commands: 1, lastCommand: 'ls' } }, run.io);
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    expect(run.panelOf('om_card1').elements[0].content).toContain(SUMMARY);
    expect(run.panelOf('om_card1').elements[0].content).toContain('`src/utils/terminal-cells.ts`');
    expect(run.panelOf('om_card1').elements[0].content).not.toContain('`ls`');
  });

  /** A read-back answered late: the card as it was when asked, not as it is when the answer comes. */
  const lateReadBack = (run: ReturnType<typeof harness>) => {
    let answer!: () => void;
    run.io.readCard = async (_ds, messageId) => {
      const json = JSON.stringify(run.cards.get(messageId));
      await new Promise<void>(resolve => { answer = resolve; });
      return json;
    };
    return () => answer();
  };
  const nextStepRow = () => buildNextStepElement({ text: '继续', payload: 'p', sig: 's' }, 'zh');

  it('stays above a「下一步」row that lands while the panel\'s read-back is out', async () => {
    const ds = session();
    const run = harness();
    const messageId = run.send('om_race_insert');
    const answerReadBack = lateReadBack(run);
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId }, INPUT, run.io);
    await ticks();
    // The「下一步」row is written meanwhile, above the footer.
    const row = serializeCardWrite(messageId, () => Date.now(), async () => {
      const card = run.cards.get(messageId);
      const footer = card.body.elements.findIndex((element: any) => element.element_id === 'botmux_reply_footer');
      card.body.elements.splice(footer, 0, nextStepRow());
    });
    await ticks();
    answerReadBack();
    await settle(ds);
    await row;
    const order = run.ids(messageId);
    expect(order.indexOf(TURN_RECAP_ELEMENT_ID)).toBe(order.indexOf(NEXT_STEP_ELEMENT_ID) - 1);
  });

  it('still goes on when the「下一步」row it would sit above is removed while its read-back is out', async () => {
    const ds = session();
    const run = harness();
    const messageId = run.send('om_race_remove');
    const card = run.cards.get(messageId);
    const footer = card.body.elements.findIndex((element: any) => element.element_id === 'botmux_reply_footer');
    card.body.elements.splice(footer, 0, nextStepRow());
    const answerReadBack = lateReadBack(run);
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId }, INPUT, run.io);
    await ticks();
    // The next turn takes the row off meanwhile.
    const removal = serializeCardWrite(messageId, () => Date.now(), async () => {
      card.body.elements = card.body.elements.filter((element: any) => element.element_id !== NEXT_STEP_ELEMENT_ID);
    });
    await ticks();
    answerReadBack();
    await settle(ds);
    await removal;
    expect(run.panelOf(messageId)).toBeDefined();
    expect(run.warnings).toEqual([]);
  });

  it('finishes a write cleanly when the next turn starts during it', async () => {
    const ds = session();
    const run = harness();
    const insert = run.io.insert;
    run.io.insert = async (...args) => {
      noteRecapTurnStarted(ds, 'om_turn2');
      return insert(...args);
    };
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await settle(ds);
    expect(run.panelOf('om_card1')).toBeDefined();
    expect(run.warnings).toEqual([]);
  });

  it('shows no files or commands in a chat that hides a turn\'s activity', async () => {
    const ds = session();
    const run = harness({ showFacts: () => false });
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await settle(ds);
    expect(run.writes).toEqual([]);
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    expect(run.panelOf('om_card1').elements[0].content).toContain(SUMMARY);
    expect(run.panelOf('om_card1').elements[0].content).not.toContain('做了什么');
  });

  it('writes nothing with the switch off', async () => {
    const ds = session();
    const run = harness({ enabled: () => false });
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    expect(run.writes).toEqual([]);
  });
});

describe('unified reply card', () => {
  it('publishes the panel through the card record and does not repeat an unchanged one', async () => {
    const ds = session();
    const run = harness();
    const published: string[] = [];
    const card = { kind: 'unified' as const, publish: async (markdown: string) => { published.push(markdown); } };
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', card, INPUT, run.io);
    await settle(ds);
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
    await settle(ds);
    expect(published).toHaveLength(2);
    expect(published[1]).toContain(SUMMARY);
    expect(run.writes).toEqual([]);
  });
});

describe('model recap', () => {
  const modelOn = () => harness({ modelEnabled: () => true });

  it('runs once the card stayed quiet for the idle stretch without a CLI recap', async () => {
    const ds = session();
    const run = modelOn();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await settle(ds);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS - 1_000);
    expect(run.modelPrompts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.modelPrompts).toEqual([INPUT.modelPrompt]);
    run.answer('已合入，CI 全绿；下一步发版。');
    await settle(ds);
    expect(run.panelOf('om_card1').elements[0].content).toMatch(/^已合入，CI 全绿；下一步发版。\n\n<font color='grey'>由小模型生成的回顾<\/font>/);
  });

  it('is not made when the CLI recapped the turn, a new turn started, or a switch is off', async () => {
    for (const interrupt of ['cli', 'turn', 'model-off', 'recap-off'] as const) {
      const ds = session();
      let modelSwitch = true;
      let recapSwitch = true;
      const run = harness({ modelEnabled: () => modelSwitch, enabled: () => recapSwitch });
      noteRecapTurnStarted(ds, 'om_turn1');
      noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
      await vi.advanceTimersByTimeAsync(60_000);
      if (interrupt === 'cli') noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
      if (interrupt === 'turn') noteRecapTurnStarted(ds, 'om_turn2');
      if (interrupt === 'model-off') modelSwitch = false;
      if (interrupt === 'recap-off') recapSwitch = false;
      await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS * 2);
      expect(run.modelPrompts, interrupt).toEqual([]);
    }
  });

  it('gives a new turn its own wait even when the previous turn\'s was still running', async () => {
    const ds = session();
    const run = modelOn();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(60_000);
    noteRecapTurnStarted(ds, 'om_turn2');
    const second = { ...INPUT, modelPrompt: 'Language: Simplified Chinese\n\nTurn record:\nAssistant: 第二轮' };
    noteRecapCard(ds, 'om_turn2', { kind: 'legacy', messageId: run.send('om_card2') }, second, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS);
    expect(run.modelPrompts).toEqual([second.modelPrompt]);
    run.answer('第二轮的回顾');
    await settle(ds);
    expect(run.panelOf('om_card2').elements[0].content).toContain('第二轮的回顾');
    expect(run.panelOf('om_card1').elements[0].content).not.toContain('回顾<');
  });

  it('keeps the newer turn\'s recap when an older turn\'s answer comes in after it', async () => {
    const ds = session();
    const run = modelOn();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS);
    noteRecapTurnStarted(ds, 'om_turn2');
    noteRecapCard(ds, 'om_turn2', { kind: 'legacy', messageId: run.send('om_card2') }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS);
    expect(run.modelPrompts).toHaveLength(2);
    run.answer('第二轮的回顾', 1);
    await settle(ds);
    run.answer('第一轮迟到的回顾', 0);
    await settle(ds);
    // The same card settling again (a replayed terminal) re-renders from what is known.
    noteRecapCard(ds, 'om_turn2', { kind: 'legacy', messageId: 'om_card2' }, INPUT, run.io);
    await settle(ds);
    expect(run.panelOf('om_card2').elements[0].content).toContain('第二轮的回顾');
    expect(run.panelOf('om_card2').elements[0].content).not.toContain('第一轮');
  });

  it('is not made for a turn that left nothing to recap', async () => {
    const ds = session();
    const run = modelOn();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, { facts: { files: [], commands: 0 } }, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS * 2);
    expect(run.modelPrompts).toEqual([]);
  });

  it('is made once per turn even when its card settles again during the call', async () => {
    const ds = session();
    const run = modelOn();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS);
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: 'om_card1' }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS * 2);
    expect(run.modelPrompts).toHaveLength(1);
  });

  it('is asked once per turn, even when the answer was lost and the card settles again', async () => {
    const ds = session();
    const run = modelOn();
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS);
    run.answer(undefined);
    await settle(ds);
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: 'om_card1' }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS * 2);
    expect(run.modelPrompts).toHaveLength(1);
  });

  it('is not made in a chat that hides a turn\'s activity: the model would read it', async () => {
    const ds = session();
    const run = harness({ modelEnabled: () => true, showFacts: () => false });
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS * 2);
    expect(run.modelPrompts).toEqual([]);
  });

  it('drops an answer that arrives after the model switch was turned off', async () => {
    const ds = session();
    let modelSwitch = true;
    const run = harness({ modelEnabled: () => modelSwitch });
    noteRecapTurnStarted(ds, 'om_turn1');
    noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
    await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS);
    expect(run.modelPrompts).toHaveLength(1);
    modelSwitch = false;
    run.answer('关掉之后才到的回顾');
    await settle(ds);
    expect(run.panelOf('om_card1').elements[0].content).not.toContain('关掉之后才到的回顾');
  });

  it('drops an answer that arrives after the next turn started or after the CLI recap', async () => {
    for (const late of ['turn', 'cli'] as const) {
      const ds = session();
      const run = modelOn();
      noteRecapTurnStarted(ds, 'om_turn1');
      noteRecapCard(ds, 'om_turn1', { kind: 'legacy', messageId: run.send('om_card1') }, INPUT, run.io);
      await vi.advanceTimersByTimeAsync(RECAP_MODEL_IDLE_MS);
      expect(run.modelPrompts).toHaveLength(1);
      if (late === 'turn') noteRecapTurnStarted(ds, 'om_turn2');
      else noteCliRecap(ds, 'om_turn1', SUMMARY, run.io);
      run.answer('迟到的回顾');
      await settle(ds);
      expect(run.panelOf('om_card1').elements[0].content, late).not.toContain('迟到的回顾');
    }
  });
});

describe('card element writes', () => {
  it('run one at a time per card with increasing sequences, even when the clock steps back', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = serializeCardWrite('om_seq', () => Date.now(), async sequence => {
      order.push(`first:${sequence}`);
      await new Promise<void>(resolve => { release = resolve; });
      return sequence;
    });
    const ticks = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    await ticks();
    expect(order).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-16T02:00:00Z'));
    const second = serializeCardWrite('om_seq', () => Date.now(), async sequence => { order.push(`second:${sequence}`); return sequence; });
    await ticks();
    expect(order).toHaveLength(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBeGreaterThan(a);
    expect(order).toEqual([`first:${a}`, `second:${b}`]);
  });
});
