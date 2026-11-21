/**
 * The "CLI is stuck on a blocking page" card: content built from the safe-key
 * catalog, the click gate, the frozen turn initiator and the result line.
 *
 * Run:  bunx vitest run test/stuck-page-card.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildInputNotSubmittedCard,
  buildStuckKeyResultCard,
  buildStuckPageCard,
} from '../src/im/lark/card-builder.js';
import { isAllowedStuckKeySequence, STUCK_PAGE_CATALOG } from '../src/core/stuck-page-catalog.js';
import {
  decideStuckKeyClick,
  stuckCardFallbackText,
  stuckCardInitiatorOpenId,
  stuckCardPostErrorMeansUnsent,
  stuckKeyResultText,
} from '../src/core/stuck-warning-card.js';
import { messages as zh } from '../src/i18n/zh.js';
import { messages as en } from '../src/i18n/en.js';
import { t } from '../src/i18n/index.js';
import type { StuckPageType } from '../src/utils/stuck-detector.js';

const PAGE_TYPES = Object.keys(STUCK_PAGE_CATALOG) as StuckPageType[];

function walk(node: unknown, visit: (n: Record<string, any>) => void): void {
  if (Array.isArray(node)) { node.forEach(n => walk(n, visit)); return; }
  if (node && typeof node === 'object') {
    visit(node as Record<string, any>);
    Object.values(node).forEach(v => walk(v, visit));
  }
}

function buttonsOf(card: unknown): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  walk(card, n => { if (n.tag === 'button') out.push(n); });
  return out;
}

function markdownTexts(card: unknown): string[] {
  const out: string[] = [];
  walk(card, n => {
    if (n.tag === 'markdown' && typeof n.content === 'string') out.push(n.content);
    if (n.tag === 'lark_md' && typeof n.content === 'string') out.push(n.content);
  });
  return out;
}

function card(pageType: string | undefined, extra: Partial<Parameters<typeof buildStuckPageCard>[0]> = {}) {
  return JSON.parse(buildStuckPageCard({
    rootId: 'om_root', sessionId: 'sid', nonce: 5, pageType, cliName: 'Codex', hasInitiator: true, locale: 'zh', ...extra,
  }));
}

describe('buildStuckPageCard', () => {
  it('the lock card offers only native retry, never exit, kill or free-form input', () => {
    expect(STUCK_PAGE_CATALOG['session lock'].options).toEqual([
      expect.objectContaining({ key: 'r', audience: 'initiator' }),
    ]);
    expect(buttonsOf(card('session lock'))).toHaveLength(1);
    expect(isAllowedStuckKeySequence('session lock', ['r'])).toBe(true);
    for (const keys of [['Enter'], ['Escape'], ['q'], ['C-c'], ['r', 'Enter']]) {
      expect(isAllowedStuckKeySequence('session lock', keys)).toBe(false);
    }
  });

  it.each(PAGE_TYPES)('%s: one button per catalog option, carrying only index + nonce', (pageType) => {
    const options = STUCK_PAGE_CATALOG[pageType].options;
    const buttons = buttonsOf(card(pageType));
    expect(buttons).toHaveLength(options.length);
    buttons.forEach((button, index) => {
      expect(button.value).toEqual({
        action: 'stuck_key', root_id: 'om_root', session_id: 'sid', selected_index: String(index), nonce: '5',
      });
      const label = t(options[index].labelKey, undefined, 'zh');
      const adminSuffix = t('card.stuck.admin_suffix', undefined, 'zh');
      expect(button.text.content).toBe(options[index].audience === 'admin' ? label + adminSuffix : label);
    });
  });

  it('never carries a text input or form', () => {
    for (const pageType of [...PAGE_TYPES, undefined]) {
      walk(card(pageType), n => {
        expect(n.tag).not.toBe('input');
        expect(n.tag).not.toBe('form');
      });
    }
  });

  it('an unrecognised page shows the screen text but no buttons', () => {
    const built = card('not a catalog page', { screenTail: 'Some menu' });
    expect(buttonsOf(built)).toEqual([]);
    expect(markdownTexts(built).some(text => text.includes('Some menu'))).toBe(true);
  });

  it('screen text stays inside its code block even when it contains fences', () => {
    const tail = 'line 1\n````\n**bold** <at id=all></at>';
    const blocks = markdownTexts(card('hook review level 1', { screenTail: tail }))
      .filter(text => text.includes('line 1'));
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    const fence = block.match(/^`+/)![0];
    expect(block).toBe(`${fence}\n${tail}\n${fence}`);
    expect(fence.length).toBeGreaterThan(4);
  });

  it('shows the notice line and the stall time only when given', () => {
    const withBoth = markdownTexts(card('hook review level 1', { noticeText: 'NOTICE-X', stalledSecs: 42 })).join('\n');
    expect(withBoth).toContain('NOTICE-X');
    expect(withBoth).toContain('42');
    const without = markdownTexts(card('hook review level 1')).join('\n');
    expect(without).not.toContain('NOTICE-X');
    expect(without).not.toContain('42');
  });

  it('the who-may-press hint depends on whether an initiator was identified', () => {
    const a = markdownTexts(card('hook review level 1', { hasInitiator: true }));
    const b = markdownTexts(card('hook review level 1', { hasInitiator: false }));
    expect(a).not.toEqual(b);
  });

  it('with the global switch off the hint says operators only, even when an initiator is known', () => {
    const off = markdownTexts(card('hook review level 1', { hasInitiator: true, initiatorKeysEnabled: false })).join('\n');
    expect(off).toContain(t('card.stuck.hint.operators_only', undefined, 'zh'));
    expect(off).not.toContain(t('card.stuck.hint.initiator', undefined, 'zh'));
    const on = markdownTexts(card('hook review level 1', { hasInitiator: true })).join('\n');
    expect(on).toContain(t('card.stuck.hint.initiator', undefined, 'zh'));
  });
});

describe('result and notice cards', () => {
  it('result card includes the post-key screen when present', () => {
    const withTail = JSON.parse(buildStuckKeyResultCard('sent', 'NEW SCREEN', false, 'zh'));
    expect(markdownTexts(withTail).some(text => text.includes('NEW SCREEN'))).toBe(true);
    const withoutTail = JSON.parse(buildStuckKeyResultCard('sent', undefined, false, 'zh'));
    expect(markdownTexts(withoutTail).some(text => text.startsWith('```'))).toBe(false);
  });

  it('input_not_submitted card carries the message and the terminal tail', () => {
    const built = JSON.parse(buildInputNotSubmittedCard('MSG-1', 'TAIL-1', 'zh'));
    const texts = markdownTexts(built);
    expect(texts.some(text => text.includes('MSG-1'))).toBe(true);
    expect(texts.some(text => text.startsWith('```') && text.includes('TAIL-1'))).toBe(true);
    expect(buttonsOf(built)).toEqual([]);
  });
});

describe('stuckKeyResultText', () => {
  it('distinguishes left page / still blocked / unobserved, and names the key', () => {
    const left = stuckKeyResultText({ key: 'Escape' }, 'zh');
    const still = stuckKeyResultText({ key: 'Escape', afterPageType: 'hook review level 2' }, 'zh');
    const unobserved = stuckKeyResultText({ key: 'Escape', afterObserved: false, afterPageType: 'hook review level 2' }, 'zh');
    expect(new Set([left, still, unobserved]).size).toBe(3);
    for (const text of [left, still, unobserved]) expect(text).toContain('Esc');
    expect(still).toContain(t(STUCK_PAGE_CATALOG['hook review level 2'].descriptionKey, undefined, 'zh'));
  });

  it('an ACK without key (older worker) keeps the generic done text', () => {
    expect(stuckKeyResultText({}, 'zh')).toBe(t('card.action.tui_done', undefined, 'zh'));
  });
});

describe('stuckCardInitiatorOpenId', () => {
  const human = { requestUserOpenId: 'ou_alice', requestLarkAppId: 'app', senderType: 'user' as const };
  const registry = { senderOpenId: 'ou_bob', participants: [{ openId: 'ou_bob', isBot: false }] };

  it('uses the same-turn daemon caller', () => {
    expect(stuckCardInitiatorOpenId({ turnId: 'T', larkAppId: 'app', activeTurn: { turnId: 'T', caller: human }, replyTarget: registry }))
      .toBe('ou_alice');
  });

  it('ignores the caller of another turn and falls back to a human-proving registry entry', () => {
    expect(stuckCardInitiatorOpenId({ turnId: 'T', larkAppId: 'app', activeTurn: { turnId: 'U', caller: human }, replyTarget: registry }))
      .toBe('ou_bob');
  });

  it('a registry entry that does not list the sender as a non-bot participant proves nobody', () => {
    expect(stuckCardInitiatorOpenId({ turnId: 'T', larkAppId: 'app', replyTarget: { senderOpenId: 'ou_bob', participants: [{ openId: 'ou_bob', isBot: true }] } }))
      .toBeUndefined();
    expect(stuckCardInitiatorOpenId({ turnId: 'T', larkAppId: 'app', replyTarget: { senderOpenId: 'ou_bob' } }))
      .toBeUndefined();
  });

  it('a bot / foreign-app caller is never replaced by registry data', () => {
    for (const caller of [
      { ...human, senderType: 'bot' as const },
      { ...human, requestLarkAppId: 'other_app' },
      { ...human, requestUserOpenId: 'on_union_not_open_id' },
    ]) {
      expect(stuckCardInitiatorOpenId({ turnId: 'T', larkAppId: 'app', activeTurn: { turnId: 'T', caller }, replyTarget: registry }))
        .toBeUndefined();
    }
  });

  it('no turn id → no initiator', () => {
    expect(stuckCardInitiatorOpenId({ turnId: undefined, larkAppId: 'app', activeTurn: { turnId: 'T', caller: human }, replyTarget: registry }))
      .toBeUndefined();
  });
});

describe('decideStuckKeyClick', () => {
  const base = {
    cardMessageId: 'om_card', activeCardId: 'om_card', valueNonce: '3', activeNonce: 3,
    pageType: 'hook review level 1', rawIndex: '2', operatorOpenId: 'ou_alice', initiatorOpenId: 'ou_alice',
    initiatorKeysEnabled: true,
  };

  it('stale clicks are dropped before any permission lookup', () => {
    for (const patch of [
      { cardMessageId: 'om_other' },
      { activeCardId: undefined },
      { valueNonce: '2' },
      { valueNonce: 3 },
      { activeNonce: undefined },
      { rawIndex: '9' },
      { pageType: 'cli migration menu', rawIndex: '1' },
    ]) {
      const isAdmin = vi.fn(() => true);
      const canTalk = vi.fn(() => true);
      const decision = decideStuckKeyClick({ ...base, ...patch, operatorIsAdmin: isAdmin, operatorCanTalk: canTalk });
      expect(decision.kind).toBe('drop');
      expect(isAdmin).not.toHaveBeenCalled();
      expect(canTalk).not.toHaveBeenCalled();
    }
  });

  it('maps a permitted click to the catalog option', () => {
    const decision = decideStuckKeyClick({ ...base, operatorIsAdmin: () => false, operatorCanTalk: () => true });
    expect(decision).toEqual({ kind: 'press', option: STUCK_PAGE_CATALOG['hook review level 1'].options[2] });
  });

  it('denies the initiator on an admin key and a stranger on any key, with different toasts', () => {
    const adminKey = decideStuckKeyClick({ ...base, rawIndex: '0', operatorIsAdmin: () => false, operatorCanTalk: () => true });
    const stranger = decideStuckKeyClick({ ...base, operatorOpenId: 'ou_bob', operatorIsAdmin: () => false, operatorCanTalk: () => true });
    expect(adminKey).toEqual({ kind: 'deny', toastKey: 'card.stuck.denied_admin_only' });
    expect(stranger).toEqual({ kind: 'deny', toastKey: 'card.stuck.denied' });
  });

  it('with the global switch off the initiator is refused on their own key, an operator still presses', () => {
    const canTalk = vi.fn(() => true);
    const initiator = decideStuckKeyClick({ ...base, initiatorKeysEnabled: false, operatorIsAdmin: () => false, operatorCanTalk: canTalk });
    expect(initiator).toEqual({ kind: 'deny', toastKey: 'card.stuck.denied_admin_only' });
    expect(canTalk).not.toHaveBeenCalled();
    const operator = decideStuckKeyClick({ ...base, operatorOpenId: 'ou_admin', initiatorKeysEnabled: false, operatorIsAdmin: () => true, operatorCanTalk: () => false });
    expect(operator).toEqual({ kind: 'press', option: STUCK_PAGE_CATALOG['hook review level 1'].options[2] });
  });
});

describe('stuck card text fallback', () => {
  it('a held message gets the hold notice naming the CLI and the page, without screen text', () => {
    const text = stuckCardFallbackText({ reason: 'input_held', matchedPattern: 'cli migration menu' }, 'TRAE', 'zh')!;
    const page = t('card.stuck.page.migration_menu', undefined, 'zh').replace(/。$/, '');
    expect(text).toBe(t('card.stuck.fallback.input_held', { cliName: 'TRAE', page }, 'zh'));
  });

  it('a stalled turn gets the one-line stuck notice; an unconfirmed submit keeps its own notice', () => {
    const page = t('card.stuck.page.hook_review_level1', undefined, 'en').replace(/\.$/, '');
    expect(stuckCardFallbackText({ matchedPattern: 'hook review level 1' }, 'Codex', 'en'))
      .toBe(t('card.stuck.fallback.turn_stalled', { cliName: 'Codex', page }, 'en'));
    expect(stuckCardFallbackText({ reason: 'turn_stalled', matchedPattern: 'hook review level 1' }, 'Codex', 'en'))
      .toBe(t('card.stuck.fallback.turn_stalled', { cliName: 'Codex', page }, 'en'));
    expect(stuckCardFallbackText({ reason: 'submit_unconfirmed', matchedPattern: 'hook review level 1', noticeText: 'not submitted' }, 'Codex', 'en'))
      .toBe('not submitted');
    expect(stuckCardFallbackText({ reason: 'submit_unconfirmed', matchedPattern: 'hook review level 1' }, 'Codex', 'en'))
      .toBeUndefined();
  });

  it('a POST that failed after the card was sent does not count as unsent', () => {
    expect(stuckCardPostErrorMeansUnsent(new Error('principal-lane outbound lost turn ownership'))).toBe(false);
    expect(stuckCardPostErrorMeansUnsent(new Error('Request failed (code: 230028)'))).toBe(true);
    expect(stuckCardPostErrorMeansUnsent(new Error('principal-lane turn identity is stale or incomplete'))).toBe(true);
  });
});

describe('card.stuck.* copy', () => {
  it('exists in both locales, including every catalog label and description', () => {
    const zhKeys = Object.keys(zh).filter(key => key.startsWith('card.stuck.')).sort();
    const enKeys = Object.keys(en).filter(key => key.startsWith('card.stuck.')).sort();
    expect(enKeys).toEqual(zhKeys);
    const catalogKeys = PAGE_TYPES.flatMap(pageType => [
      STUCK_PAGE_CATALOG[pageType].descriptionKey,
      ...STUCK_PAGE_CATALOG[pageType].options.map(option => option.labelKey),
    ]);
    for (const key of catalogKeys) expect(zhKeys).toContain(key);
  });
});
