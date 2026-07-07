/**
 * <available_bots> inline↔collapse threshold + the Mir parser that must read
 * BOTH shapes.
 *
 * session-manager emits the full <bot/> roster for ≤ AVAILABLE_BOTS_INLINE_MAX
 * peers and a names-only collapsed body line above it; mir-prompt must surface
 * the collapsed body (the names live in the tag body, not <bot/> children —
 * they were dropped before this was fixed). Also guards the collapsed
 * separator against the process default locale.
 *
 * Run: pnpm vitest run test/available-bots-collapse.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { normalizeMircliPrompt, summarizeAvailableBots } from '../src/mir-prompt.js';
import { getDefaultLocale, setDefaultLocale, type Locale } from '../src/i18n/index.js';

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
  name: `Bot${i + 1}`, displayName: `Bot${i + 1}`, openId: `ou_${'z'.repeat(30)}${i}`,
}));

// Build a first-topic envelope for the `mir` CLI with `peers` unmentioned bots.
// locale === null → omit the arg entirely so it falls back to the process default.
const envelope = (peers: number, locale: Locale | null = 'zh') =>
  buildNewTopicPrompt(
    'do the thing', 'sess', 'mir', undefined, undefined, undefined,
    mk(peers), undefined, { name: 'Me', openId: 'ou_me' },
    locale ?? undefined, undefined, {},
  );

const block = (p: string) => (p.match(/<available_bots[\s\S]*?<\/available_bots>/) || [''])[0];

describe('buildNewTopicPrompt <available_bots> rendering', () => {
  afterEach(() => setDefaultLocale('zh'));

  it('≤3 peers: inline roster with open_ids, no count attr', () => {
    const b = block(envelope(3));
    expect(b).toContain('<bot ');
    expect(b).toContain('ou_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz0');
    expect(b).not.toContain('count=');
  });

  it('>3 peers: collapse to a names-only pointer with count, open_ids deferred', () => {
    const b = block(envelope(4));
    expect(b).toContain('count="4"');
    expect(b).not.toContain('<bot ');
    expect(b).not.toContain('ou_');           // open_ids deferred to botmux bots list
    for (const n of ['Bot1', 'Bot2', 'Bot3', 'Bot4']) expect(b).toContain(n);
  });

  it('collapsed separator follows the process default locale when the arg is omitted', () => {
    setDefaultLocale('en');
    expect(getDefaultLocale()).toBe('en');
    const b = block(envelope(4, null));       // locale arg omitted → default 'en'
    expect(b).toContain('There are 4');        // English sentence
    expect(b).toContain('Bot1, Bot2');         // English comma separator…
    expect(b).not.toContain('、');             // …not the Chinese enumeration comma
  });

  it('0 peers: no block', () => {
    expect(block(envelope(0))).toBe('');
  });
});

describe('mir-prompt surfaces both available_bots shapes', () => {
  it('inline (≤3): each peer open_id reaches Mira', () => {
    const out = normalizeMircliPrompt(envelope(2));
    expect(out).toContain('ou_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz0');
    expect(out).toContain('Bot1');
    expect(out).toContain('communicate or collaborate');
  });

  it('collapsed (>3): names in the tag body still reach Mira (not just the hint)', () => {
    const out = normalizeMircliPrompt(envelope(5));
    for (const n of ['Bot1', 'Bot2', 'Bot3', 'Bot4', 'Bot5']) expect(out).toContain(n);
    expect(out).toContain('communicate or collaborate');
  });

  it('returns undefined when no <available_bots> block is present', () => {
    expect(summarizeAvailableBots('<user_message>hi</user_message>')).toBeUndefined();
  });
});
