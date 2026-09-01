import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clampUnicodeCodePoints,
  replyStyleConfigFromDraft,
  replyStyleDraftFromConfig,
  replyStyleDraftHasBlankCustomTag,
} from '../src/dashboard/web/reply-style-form.js';
import {
  REPLY_LAYOUT_TAG_MAX_CODEPOINTS,
  REPLY_RECIPE_PROMPT_MAX_CODEPOINTS,
} from '../src/im/lark/reply-card-style.js';

const replyStylePage = readFileSync(
  new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url),
  'utf8',
);

function replyStyleInputHandler(dataInput: string, endMarker: string): string {
  const start = replyStylePage.indexOf(dataInput);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = replyStylePage.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return replyStylePage.slice(start, end);
}

describe('Dashboard reply-style form model', () => {
  it('clamps by Unicode code points instead of UTF-16 code units', () => {
    expect(clampUnicodeCodePoints('🧪'.repeat(32), 32)).toBe('🧪'.repeat(32));
    expect(clampUnicodeCodePoints(`${'🧪'.repeat(32)}超`, 32)).toBe('🧪'.repeat(32));
    expect(clampUnicodeCodePoints('甲乙丙', 2)).toBe('甲乙');
    expect(clampUnicodeCodePoints('anything', 0)).toBe('');
  });

  it('captures synthetic-event values before functional draft updaters run', () => {
    // React clears currentTarget after the handler returns. Reading it from a
    // deferred functional updater crashes the page, so both text handlers must
    // turn the event into a plain string before calling setDraft.
    const handlers = [
      replyStyleInputHandler('data-input="replyStyle.recipePrompt"', '/>'),
      replyStyleInputHandler('data-input={`replyStyle.layoutTags.${layout}`}', '</label>'),
    ];

    for (const handler of handlers) {
      const eventRead = handler.indexOf('event.currentTarget.value');
      const stateUpdate = handler.indexOf('setDraft(current =>');
      expect(eventRead).toBeGreaterThanOrEqual(0);
      expect(stateUpdate).toBeGreaterThanOrEqual(0);
      expect(eventRead).toBeLessThan(stateUpdate);
      expect(handler.slice(stateUpdate)).not.toContain('event.currentTarget');
    }
  });

  it('renders an omitted block as built-in defaults and keeps the saved override sparse', () => {
    const draft = replyStyleDraftFromConfig(undefined);
    expect(draft).toMatchObject({
      recipes: true,
      layout: true,
      theme: 'default',
      recipePrompt: '',
    });
    expect(Object.values(draft.layoutColors)).toEqual(['', '', '', '', '']);
    expect(Object.values(draft.layoutTagModes)).toEqual([
      'inherit', 'inherit', 'inherit', 'inherit', 'inherit',
    ]);
    expect(replyStyleConfigFromDraft(draft)).toBeUndefined();
  });

  it('round-trips color overrides and all three tag states without materializing inherited keys', () => {
    const draft = replyStyleDraftFromConfig({
      recipes: false,
      theme: 'vivid',
      recipePrompt: '\n  按风险先说需要确认什么。\n',
      layoutColors: { result: 'turquoise', handoff: 'indigo' },
      layoutTags: { result: '', risk: '请拍板' },
    });

    expect(draft.layoutTagModes).toMatchObject({
      result: 'hidden',
      progress: 'inherit',
      risk: 'custom',
    });
    expect(replyStyleConfigFromDraft(draft)).toEqual({
      recipes: false,
      theme: 'vivid',
      recipePrompt: '按风险先说需要确认什么。',
      layoutColors: { result: 'turquoise', handoff: 'indigo' },
      layoutTags: { result: '', risk: '请拍板' },
    });
  });

  it('fails soft on malformed persisted values and flags an empty custom tag before save', () => {
    const draft = replyStyleDraftFromConfig({
      recipes: 'no',
      layout: false,
      theme: 'neon',
      recipePrompt: 42,
      layoutColors: { result: 'laser', risk: 'orange', unknown: 'blue' },
      layoutTags: { result: 1, blocked: '', handoff: '  交给你  ' },
    });
    expect(draft).toMatchObject({ recipes: true, layout: false, theme: 'default' });
    expect(draft.layoutColors.risk).toBe('orange');
    expect(draft.layoutColors.result).toBe('');
    expect(draft.layoutTagModes.blocked).toBe('hidden');
    expect(draft.layoutTagModes.handoff).toBe('custom');
    expect(draft.layoutTags.handoff).toBe('交给你');

    draft.layoutTagModes.progress = 'custom';
    draft.layoutTags.progress = '   ';
    expect(replyStyleDraftHasBlankCustomTag(draft)).toBe(true);
  });

  it('keeps exact text limits and drops only over-limit form fields', () => {
    const draft = replyStyleDraftFromConfig(undefined);
    draft.recipes = false;
    draft.recipePrompt = '配'.repeat(REPLY_RECIPE_PROMPT_MAX_CODEPOINTS);
    draft.layoutTagModes.risk = 'custom';
    draft.layoutTags.risk = '签'.repeat(REPLY_LAYOUT_TAG_MAX_CODEPOINTS);
    expect(replyStyleConfigFromDraft(draft)).toEqual({
      recipes: false,
      recipePrompt: draft.recipePrompt,
      layoutTags: { risk: draft.layoutTags.risk },
    });

    draft.recipePrompt += '超';
    draft.layoutTags.risk += '长';
    expect(replyStyleConfigFromDraft(draft)).toEqual({
      recipes: false,
      recipePrompt: draft.recipePrompt,
      layoutTags: { risk: draft.layoutTags.risk },
    });
  });
});
