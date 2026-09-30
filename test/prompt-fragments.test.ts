import { describe, expect, it } from 'vitest';
import {
  PROMPT_FRAGMENTS,
  PROMPT_STAGES,
  BLOCK_META,
  fragmentStages,
  validateFragmentOverride,
  type PromptFragmentSpec,
} from '../src/skills/prompt-fragments.js';
import { shippedText } from '../src/i18n/index.js';
import { SUPPORTED_LOCALES } from '../src/i18n/types.js';

/**
 * Catalog integrity for the customization center. The catalog is the
 * human-facing map over the i18n keys that actually reach the model, so these
 * tests fail on:
 *  - a key that does not exist in both shipped dictionaries (silent key-fallback
 *    would show the raw key as "factory text")
 *  - a {placeholder} declared but missing from either locale's factory text
 *    (edits could never satisfy validation / runtime interpolation would drop a
 *    real value)
 *  - an unknown block/stage, duplicate keys, or a conditional without a gate
 */
describe('prompt fragment catalog', () => {
  it('has no duplicate keys', () => {
    const keys = PROMPT_FRAGMENTS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stages cover the three documented injection points in order', () => {
    expect(PROMPT_STAGES.map((s) => s.id)).toEqual(['new', 'followup', 'send']);
  });

  it('every fragment references a known block and valid stages', () => {
    for (const f of PROMPT_FRAGMENTS) {
      expect(BLOCK_META[f.block], `block ${f.block} of ${f.key}`).toBeTruthy();
      expect(['new', 'followup', 'send']).toContain(f.stage);
      for (const s of f.stages ?? []) {
        expect(['new', 'followup', 'send']).toContain(s);
        expect(s).not.toBe(f.stage); // primary stage is implied, no redundant listing
      }
      if (f.kind === 'conditional') {
        expect(f.gate, `conditional ${f.key} needs a gate`).toBeTruthy();
      }
    }
  });

  it('every key ships real (non-fallback) copy in BOTH locales', () => {
    for (const f of PROMPT_FRAGMENTS) {
      for (const loc of SUPPORTED_LOCALES) {
        const text = shippedText(f.key, loc);
        expect(text, `${f.key} [${loc}] resolves`).not.toBe(f.key);
        expect(text.trim().length, `${f.key} [${loc}] non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('every declared placeholder exists in both locales’ factory text', () => {
    for (const f of PROMPT_FRAGMENTS) {
      if (f.kind !== 'placeholder') continue;
      for (const token of f.placeholders ?? []) {
        for (const loc of SUPPORTED_LOCALES) {
          expect(
            shippedText(f.key, loc),
            `${f.key} [${loc}] must contain {${token}}`,
          ).toContain(`{${token}}`);
        }
      }
    }
  });

  it('rejects an override that drops a required placeholder', () => {
    const line = PROMPT_FRAGMENTS.find((f) => f.key === 'ai.available_bots.collapsed_line')!;
    expect(line.kind).toBe('placeholder');
    expect(validateFragmentOverride(line.key, '群里有 {count} 个 bot。')).toMatch(/names/);
    expect(validateFragmentOverride(line.key, '群里有 {count} 个：{names}')).toBeUndefined();
  });

  it('fragmentStages lists primary + extra stages without duplicates', () => {
    const attach = PROMPT_FRAGMENTS.find((f) => f.key === 'ai.attach.hint')!;
    expect(fragmentStages(attach).sort()).toEqual(['followup', 'new']);
    const intro = PROMPT_FRAGMENTS.find((f) => f.key === 'ai.routing.intro')!;
    expect(fragmentStages(intro)).toEqual(['new']);
  });

  it('covers the formerly-hardcoded migrated copy (whiteboard / summary / chat-context)', () => {
    // Regression guard for the i18n migration that made these customizable.
    const migratedKeys = [
      'ai.chat_context.policy',
      'ai.summary_memory.intro',
      'ai.whiteboard.block_read',
      'ai.whiteboard.hint_send_shell',
      'ai.send.after_success_unified',
    ];
    for (const key of migratedKeys) {
      expect(PROMPT_FRAGMENTS.some((f: PromptFragmentSpec) => f.key === key), key).toBe(true);
    }
  });
});
