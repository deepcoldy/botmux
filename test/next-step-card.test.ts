/**
 * The「下一步」row: its wire JSON (golden), where it lands on a legacy reply
 * card, how a unified card renders it, and that other bots reading the card
 * never see it as reply text.
 *
 * Golden regeneration (only for an intended card change):
 *   UPDATE_CARD_GOLDEN=1 npx vitest run --project unit test/next-step-card.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildNextStepElement,
  nextStepPlacement,
  NEXT_STEP_CLICK_NOTICE,
  NEXT_STEP_ELEMENT_ID,
  NEXT_STEP_LABEL_MAX_CHARS,
} from '../src/im/lark/next-step-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { buildReplyCardFooterElements, buildCardBodyElements, createReplyCard } from '../src/im/lark/md-card.js';
import { stampBotmuxCallbackMarkers } from '../src/im/lark/callback-button-marker.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { buildTurnTerminalFooterPatch } from '../src/im/lark/card-builder.js';
import { CARD_CLICK_TURN_ACTION } from '../src/services/card-click-turn.js';
import type { TurnReplyCardRecord } from '../src/services/turn-reply-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';

const GOLDEN_PATH = resolve('test/fixtures/next-step-card-golden.json');
const UPDATE = process.env.UPDATE_CARD_GOLDEN === '1';
const NEXT = { text: 'CI 绿了就合', payload: '[1,"cli_app","CI 绿了就合"]', sig: 'sig_x' };

describe('next-step row wire format', () => {
  const samples: Record<string, unknown> = {
    zh: buildNextStepElement(NEXT, 'zh'),
    en: buildNextStepElement(NEXT, 'en'),
  };

  it('matches the golden JSON', () => {
    const serialized = JSON.stringify(samples, null, 2) + '\n';
    if (UPDATE || !existsSync(GOLDEN_PATH)) writeFileSync(GOLDEN_PATH, serialized);
    expect(serialized).toBe(readFileSync(GOLDEN_PATH, 'utf8'));
  });

  it('is a signed card-click turn whose notice only picks the acknowledgement', () => {
    const button = (samples.zh as any).columns[1].elements[0];
    expect(button.behaviors).toEqual([{ type: 'callback', value: {
      action: CARD_CLICK_TURN_ACTION, payload: NEXT.payload, sig: NEXT.sig, notice: NEXT_STEP_CLICK_NOTICE,
    } }]);
  });

  it('shortens a long label, keeps the full text in the token and shows it on hover', () => {
    const long = 'x'.repeat(NEXT_STEP_LABEL_MAX_CHARS + 20);
    const button = (buildNextStepElement({ ...NEXT, text: long }, 'zh') as any).columns[1].elements[0];
    const label: string = button.text.content;
    expect([...label]).toHaveLength(NEXT_STEP_LABEL_MAX_CHARS);
    expect(label.endsWith('…')).toBe(true);
    expect(button.behaviors[0].value.payload).toBe(NEXT.payload);
    expect(button.hover_tips.content).toContain(long);
  });
});

function legacyReplyCard(footerOpts: Record<string, unknown> = {}): any {
  return createReplyCard([
    ...buildCardBodyElements('最终答复'),
    ...buildReplyCardFooterElements({ presentation: { footerPreferences: { enabled: true } }, ...footerOpts } as any),
  ]);
}

describe('next-step placement on a sent legacy card', () => {
  it('goes right above the footer row, below the divider', () => {
    const card = legacyReplyCard();
    const footerRow = card.body.elements.find((element: any) => element.element_id === 'botmux_reply_footer'
      || element.element_id === 'botmux_reply_actions');
    expect(footerRow).toBeDefined();
    expect(nextStepPlacement(JSON.stringify(card))).toEqual({
      kind: 'insert', placement: { type: 'insert_before', targetElementId: footerRow.element_id },
    });
    const index = card.body.elements.indexOf(footerRow);
    expect(card.body.elements[index - 1]).toEqual({ tag: 'hr' });
  });

  it('appends to a schema 2.0 card without a footer and skips other cards', () => {
    expect(nextStepPlacement(JSON.stringify(createReplyCard([{ tag: 'markdown', content: 'x' }]))))
      .toEqual({ kind: 'insert', placement: { type: 'append' } });
    expect(nextStepPlacement(JSON.stringify({ config: {}, elements: [] }))).toBeUndefined();
    expect(nextStepPlacement('not json')).toBeUndefined();
  });

  it('reports a row that is already there', () => {
    const card = legacyReplyCard();
    card.body.elements.splice(1, 0, buildNextStepElement(NEXT));
    expect(nextStepPlacement(JSON.stringify(card))).toEqual({ kind: 'present' });
  });
});

describe('footer receipt replay', () => {
  it('reports a footer that already carries this receipt instead of patching it again', () => {
    const card = legacyReplyCard();
    const first = buildTurnTerminalFooterPatch(JSON.stringify(card), 'completed', 'zh')!;
    expect(first.alreadyApplied).toBe(false);
    const footer = JSON.parse(JSON.stringify(card));
    const walk = (node: any): void => {
      if (node?.element_id === 'botmux_reply_footer') node.content = first.content;
      for (const child of [...(node?.elements ?? []), ...(node?.columns ?? [])]) walk(child);
    };
    for (const element of footer.body.elements) walk(element);
    expect(buildTurnTerminalFooterPatch(JSON.stringify(footer), 'completed', 'zh')).toEqual({ content: first.content, alreadyApplied: true });
  });
});

function unifiedRecord(over: Partial<TurnReplyCardRecord> = {}): TurnReplyCardRecord {
  const finalCard = JSON.stringify(legacyReplyCard());
  return {
    version: 1, mode: 'unified', larkAppId: 'cli_app', sessionId: 'sess', turnId: 'om_turn', chatId: 'oc_chat',
    rootId: 'om_root', phase: 'completed', createdAtMs: 0, durationMs: 1000, progress: [], tools: [],
    finalCard, finalText: '最终答复', ...over,
  };
}

const presentation = { locale: 'zh' as const, showProcess: true, showToolResults: false, canStop: true };

describe('unified reply card', () => {
  it('renders the row of a completed turn above its footer row, after the activity panel', () => {
    const card = JSON.parse(buildTurnReplyCard(unifiedRecord({
      nextStep: NEXT,
      tools: [{ id: 't1', name: 'Bash', subject: 'ls', completed: true }],
      activity: [{ kind: 'tool', id: 't1' }],
    }), presentation));
    const ids = card.body.elements.map((element: any) => element.element_id ?? element.tag);
    const row = ids.indexOf(NEXT_STEP_ELEMENT_ID);
    expect(row).toBeGreaterThan(ids.indexOf('botmux_turn_process'));
    expect(ids.slice(row + 1).some((id: string) => id === 'botmux_reply_footer' || id === 'botmux_reply_actions')).toBe(true);
  });

  it('leaves the row out rather than overflow a card near the size limit', () => {
    const record = (chars: number, nextStep = NEXT) => unifiedRecord({
      nextStep,
      finalCard: JSON.stringify(createReplyCard([
        { tag: 'markdown', content: '答'.repeat(chars) },
        ...buildReplyCardFooterElements({ presentation: { footerPreferences: { enabled: true } } } as any),
      ])),
    });
    const size = (card: string) => turnReplyCardRequestBytes(card, 'oc_chat');
    const withoutRow = (chars: number) => size(buildTurnReplyCard({ ...record(chars), nextStep: undefined }, presentation));
    expect(buildTurnReplyCard(record(2_000), presentation)).toContain(NEXT_STEP_ELEMENT_ID);
    // Largest answer that still fits without the row, measured rather than guessed.
    let low = 0;
    let high = 20_000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (withoutRow(mid) <= TURN_REPLY_CARD_MAX_BYTES) low = mid; else high = mid - 1;
    }
    const tight = buildTurnReplyCard(record(low), presentation);
    expect(tight).not.toContain(NEXT_STEP_ELEMENT_ID);
    expect(size(tight)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    // ...and the answer is still the card's own body, not an attachment notice.
    expect(tight).toContain('答'.repeat(50));
  });

  it('renders nothing extra without a suggestion or before the turn completed', () => {
    for (const record of [unifiedRecord(), unifiedRecord({ nextStep: NEXT, phase: 'working', finalCard: undefined }),
      unifiedRecord({ nextStep: NEXT, phase: 'failed' })]) {
      expect(buildTurnReplyCard(record, presentation)).not.toContain(NEXT_STEP_ELEMENT_ID);
    }
  });
});

describe('cards read by another bot', () => {
  it('do not carry the next-step row as reply text', () => {
    const card = legacyReplyCard();
    card.body.elements.splice(1, 0, buildNextStepElement(NEXT));
    const content = stampBotmuxCallbackMarkers(JSON.stringify(card));
    const text = extractCardContent(content);
    expect(text).toContain('最终答复');
    expect(text).not.toContain('下一步');
    expect(text).not.toContain(NEXT.text);
  });
});
