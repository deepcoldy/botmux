/**
 * The「本轮回顾」panel on a reply card: its wire JSON (golden), where it goes
 * on a sent legacy card, how a unified card renders it, and that other bots
 * reading the card never see it as reply text.
 *
 * Golden regeneration (only for an intended card change):
 *   UPDATE_CARD_GOLDEN=1 npx vitest run --project unit test/turn-recap-card.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRecapElement,
  isDuplicateElementIdError,
  recapPlacement,
  TURN_RECAP_ELEMENT_ID,
} from '../src/im/lark/turn-recap-card.js';
import { buildNextStepElement, NEXT_STEP_ELEMENT_ID } from '../src/im/lark/next-step-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { buildCardBodyElements, buildReplyCardFooterElements, createReplyCard } from '../src/im/lark/md-card.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import type { TurnReplyCardRecord } from '../src/services/turn-reply-card.js';

const GOLDEN_PATH = resolve('test/fixtures/turn-recap-card-golden.json');
const UPDATE = process.env.UPDATE_CARD_GOLDEN === '1';
const MARKDOWN = '已合入，CI 全绿。\n\n**做了什么**\n- 跑了 1 条命令，最后一条：`bun run build`';
const NEXT = { text: 'CI 绿了就合', payload: '[1,"cli_app","CI 绿了就合"]', sig: 'sig_x' };

function legacyReplyCard(): any {
  return createReplyCard([
    ...buildCardBodyElements('最终答复'),
    ...buildReplyCardFooterElements({ presentation: { footerPreferences: { enabled: true } } } as any),
  ]);
}

const ids = (card: any): string[] => card.body.elements.map((element: any) => element.element_id ?? element.tag);

describe('recap panel wire format', () => {
  it('matches the golden JSON', () => {
    const serialized = JSON.stringify({ zh: buildRecapElement(MARKDOWN, 'zh'), en: buildRecapElement(MARKDOWN, 'en') }, null, 2) + '\n';
    if (UPDATE || !existsSync(GOLDEN_PATH)) writeFileSync(GOLDEN_PATH, serialized);
    expect(serialized).toBe(readFileSync(GOLDEN_PATH, 'utf8'));
  });

  it('is collapsed by default', () => {
    expect(buildRecapElement(MARKDOWN, 'zh')).toMatchObject({ tag: 'collapsible_panel', expanded: false });
  });
});

describe('recap placement on a sent legacy card', () => {
  it('goes above the footer row, or above the「下一步」row when the card has one', () => {
    const card = legacyReplyCard();
    const footer = ids(card).find(id => id === 'botmux_reply_footer' || id === 'botmux_reply_actions')!;
    expect(recapPlacement(JSON.stringify(card)))
      .toEqual({ kind: 'insert', placement: { type: 'insert_before', targetElementId: footer } });
    card.body.elements.splice(ids(card).indexOf(footer), 0, buildNextStepElement(NEXT, 'zh'));
    expect(recapPlacement(JSON.stringify(card)))
      .toEqual({ kind: 'insert', placement: { type: 'insert_before', targetElementId: NEXT_STEP_ELEMENT_ID } });
  });

  it('updates a panel the card already carries', () => {
    // A live read-back (user_card_content) lists the inserted panel with its id.
    const card = legacyReplyCard();
    card.body.elements.splice(1, 0, buildRecapElement(MARKDOWN, 'zh'));
    expect(recapPlacement(JSON.stringify(card))).toEqual({ kind: 'present' });
  });

  it('appends to a schema 2.0 card without a footer and skips other cards', () => {
    expect(recapPlacement(JSON.stringify(createReplyCard([{ tag: 'markdown', content: 'x' }]))))
      .toEqual({ kind: 'insert', placement: { type: 'append' } });
    expect(recapPlacement(JSON.stringify({ elements: [] }))).toBeUndefined();
    expect(recapPlacement('not json')).toBeUndefined();
  });

  it('recognizes CardKit refusing an id the card already has', () => {
    // As thrown for a second insert of the panel on a live card.
    const live = new Error('Failed to insert CardKit elements: ErrMsg: msg: [ElementID botmux_turn_recap: Code 1001: Duplicate ID], code: 300301;  (code: 300315)');
    expect(isDuplicateElementIdError(live)).toBe(true);
    expect(isDuplicateElementIdError(new Error('Failed to insert CardKit elements: rate limited'))).toBe(false);
  });
});

function unifiedRecord(over: Partial<TurnReplyCardRecord> = {}): TurnReplyCardRecord {
  return {
    version: 1, mode: 'unified', larkAppId: 'cli_app', sessionId: 'sess', turnId: 'om_turn', chatId: 'oc_chat',
    rootId: 'om_root', phase: 'completed', createdAtMs: 0, durationMs: 1000, progress: [], tools: [],
    finalCard: JSON.stringify(legacyReplyCard()), finalText: '最终答复', ...over,
  };
}

const presentation = { locale: 'zh' as const, showProcess: true, showToolResults: false, canStop: true };

describe('unified reply card', () => {
  it('renders the panel of a completed turn above the「下一步」row and the footer', () => {
    const card = JSON.parse(buildTurnReplyCard(unifiedRecord({
      recap: { markdown: MARKDOWN },
      nextStep: NEXT,
      tools: [{ id: 't1', name: 'Bash', subject: 'ls', completed: true }],
      activity: [{ kind: 'tool', id: 't1' }],
    }), presentation));
    const order = ids(card);
    const panel = order.indexOf(TURN_RECAP_ELEMENT_ID);
    expect(panel).toBeGreaterThan(order.indexOf('botmux_turn_process'));
    expect(order[panel + 1]).toBe(NEXT_STEP_ELEMENT_ID);
    expect(card.body.elements[panel]).toEqual(buildRecapElement(MARKDOWN, 'zh'));
    const footer = card.body.elements.findIndex((element: any) => element.element_id === 'botmux_reply_footer'
      || element.element_id === 'botmux_reply_actions');
    expect(footer).toBeGreaterThan(panel);
  });

  it('renders no panel before the turn completed or for a failed turn', () => {
    for (const record of [
      unifiedRecord(),
      unifiedRecord({ recap: { markdown: MARKDOWN }, phase: 'working', finalCard: undefined }),
      unifiedRecord({ recap: { markdown: MARKDOWN }, phase: 'failed' }),
    ]) expect(buildTurnReplyCard(record, presentation)).not.toContain(TURN_RECAP_ELEMENT_ID);
  });

  it('leaves the panel out before the「下一步」row or the answer when the card is near the size limit', () => {
    const record = (chars: number) => unifiedRecord({
      recap: { markdown: '回顾'.repeat(400) },
      nextStep: NEXT,
      finalCard: JSON.stringify(createReplyCard([
        { tag: 'markdown', content: '答'.repeat(chars) },
        ...buildReplyCardFooterElements({ presentation: { footerPreferences: { enabled: true } } } as any),
      ])),
    });
    const size = (card: string) => turnReplyCardRequestBytes(card, 'oc_chat');
    // The builder leaves optional rows out by itself; this asks whether the row still made it.
    const rowFitsWithoutPanel = (chars: number) =>
      buildTurnReplyCard({ ...record(chars), recap: undefined }, presentation).includes(NEXT_STEP_ELEMENT_ID);
    expect(buildTurnReplyCard(record(2_000), presentation)).toContain(TURN_RECAP_ELEMENT_ID);
    // Largest answer that still fits with the row but without the panel, measured.
    let low = 0;
    let high = 20_000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (rowFitsWithoutPanel(mid)) low = mid; else high = mid - 1;
    }
    const tight = buildTurnReplyCard(record(low), presentation);
    expect(tight).not.toContain(TURN_RECAP_ELEMENT_ID);
    expect(tight).toContain(NEXT_STEP_ELEMENT_ID);
    expect(size(tight)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    expect(tight).toContain('答'.repeat(50));
  });
});

describe('cards read by another bot', () => {
  it('do not carry the recap as reply text', () => {
    const card = legacyReplyCard();
    card.body.elements.splice(1, 0, buildRecapElement('只给离开的人看的回顾', 'zh'));
    const text = extractCardContent(JSON.stringify(card));
    expect(text).toContain('最终答复');
    expect(text).not.toContain('只给离开的人看的回顾');
    expect(text).not.toContain('本轮回顾');
  });
});
