import { describe, expect, it } from 'vitest';
import {
  BOT_DESCRIPTION_MAX_CHARS,
  normalizeBotDescriptions,
} from '../src/services/bot-description-schema.js';

describe('normalizeBotDescriptions', () => {
  it('trims and returns safe locale-keyed descriptions', () => {
    expect(normalizeBotDescriptions({ zh_cn: ' 中文 ', en_us: ' English ' })).toEqual({
      ok: true,
      descriptions: { zh_cn: '中文', en_us: 'English' },
    });
  });

  // Rows are wrapped in tuples on purpose. A BARE `[]` row spreads to ZERO arguments,
  // and a callback that declares a parameter then looks like it wants a `done`
  // callback — `bun test` waits for one and the case dies at the timeout (measured:
  // 180s, on a synchronous body that cannot hang). vitest passes the empty array
  // through as the single argument instead. `[[]]` is unambiguous under both.
  it.each([[null], [[]], ['text'], [{}], [{ zh: 'x' }], [{ __proto__: 'x' }]])(
    'rejects a malformed map: %j',
    value => expect(normalizeBotDescriptions(value)).toMatchObject({ ok: false }),
  );

  it('rejects empty and overlong localized values with the locale', () => {
    expect(normalizeBotDescriptions({ zh_cn: '   ' })).toEqual({
      ok: false, reason: 'description_required', lang: 'zh_cn',
    });
    expect(normalizeBotDescriptions({ en_us: 'x'.repeat(BOT_DESCRIPTION_MAX_CHARS + 1) })).toEqual({
      ok: false, reason: 'description_too_long', lang: 'en_us',
    });
  });

  it('counts Unicode code points so one emoji is one character', () => {
    expect(normalizeBotDescriptions({ en_us: '🙂'.repeat(BOT_DESCRIPTION_MAX_CHARS) }).ok).toBe(true);
  });
});
