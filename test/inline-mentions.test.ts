/**
 * Inline `@Name` → Lark `<at id=…>` rewriting (botmux send body).
 *
 * Regression: the old `@(name)\b` matcher's `\b` word boundary never matched
 * after a CJK character, so pure-Chinese display names (`@张三`) silently fell
 * through to the footer and never rendered inline. The boundary now mirrors the
 * `@BotName` auto-injection matcher (ASCII-only lookbehind + Unicode-letter
 * lookahead), so Chinese names inline at the exact written position while the
 * `@Owner2` / `user@Owner` guards still hold.
 *
 * Run: pnpm vitest run test/inline-mentions.test.ts
 */
import { describe, it, expect } from 'vitest';
import { applyInlineMentions } from '../src/im/lark/inline-mentions.js';

const zhang = { open_id: 'ou_zhangsan', name: '张三' };
const li = { open_id: 'ou_lisi', name: '李四' };
const owner = { open_id: 'ou_owner', name: 'Owner' };

describe('applyInlineMentions', () => {
  it('inlines a pure-Chinese name (the regression)', () => {
    const r = applyInlineMentions('结果A @张三 请看 MR', [zhang]);
    expect(r.text).toBe('结果A <at id=ou_zhangsan></at> 请看 MR');
    expect([...r.usedIds]).toEqual(['ou_zhangsan']);
  });

  it('inlines a Chinese name at end-of-string and before CJK punctuation', () => {
    expect(applyInlineMentions('@张三', [zhang]).text).toBe('<at id=ou_zhangsan></at>');
    expect(applyInlineMentions('@张三：完成', [zhang]).text).toBe('<at id=ou_zhangsan></at>：完成');
    expect(applyInlineMentions('@张三，已合并', [zhang]).text).toBe('<at id=ou_zhangsan></at>，已合并');
  });

  it('inlines multiple distinct names across lines, only where written', () => {
    const r = applyInlineMentions(
      'MR1 feat/x cc @张三\nMR2 无 MR，无需 @\nMR3 fix/y cc @Owner',
      [zhang, li, owner],
    );
    expect(r.text).toBe(
      'MR1 feat/x cc <at id=ou_zhangsan></at>\nMR2 无 MR，无需 @\nMR3 fix/y cc <at id=ou_owner></at>',
    );
    // 李四 was registered but never written → not inlined (caller footers it).
    expect(r.usedIds).toEqual(new Set(['ou_zhangsan', 'ou_owner']));
  });

  it('accepts a CJK-prefixed @ but rejects an ASCII-word-prefixed one (email-like)', () => {
    expect(applyInlineMentions('看看@张三', [zhang]).text).toBe('看看<at id=ou_zhangsan></at>');
    // `a@张三` looks like a handle/email local part → not a mention.
    const r = applyInlineMentions('a@张三', [zhang]);
    expect(r.text).toBe('a@张三');
    expect(r.usedIds.size).toBe(0);
  });

  it('does not half-match a longer name (Unicode-letter lookahead)', () => {
    // name "Owner" must not match inside "@Owner2".
    expect(applyInlineMentions('@Owner2 done', [owner]).text).toBe('@Owner2 done');
    // name "张三" must not match inside "@张三丰"; with both registered, the
    // longer one wins via backtracking (separator is a letter, lookahead fires).
    const both = applyInlineMentions('@张三丰 报告', [zhang, { open_id: 'ou_zsf', name: '张三丰' }]);
    expect(both.text).toBe('<at id=ou_zsf></at> 报告');
  });

  it('resolves prefix collision when the separator is NOT a letter/digit (length-desc)', () => {
    // Codex P2: lookahead alone can't fix `Claude` vs `Claude-Code` — after the
    // short `Claude` the next char `-` passes the lookahead. Length-desc ordering
    // makes the longer name win.
    const bots = [
      { open_id: 'ou_short', name: 'Claude' },
      { open_id: 'ou_cli', name: 'Claude-Code' },
    ];
    expect(applyInlineMentions('@Claude-Code hi', bots).text).toBe('<at id=ou_cli></at> hi');
    expect([...applyInlineMentions('@Claude-Code hi', bots).usedIds]).toEqual(['ou_cli']);
    // Reversed registration order must not change the outcome.
    const rev = [bots[1], bots[0]];
    expect(applyInlineMentions('@Claude-Code hi', rev).text).toBe('<at id=ou_cli></at> hi');
    // The bare short name still resolves to the short id when written alone.
    expect(applyInlineMentions('@Claude hi', bots).text).toBe('<at id=ou_short></at> hi');
    // Single-char prefix with a hyphen separator (Codex's `A` / `A-B` repro).
    const ab = [{ open_id: 'ou_a', name: 'A' }, { open_id: 'ou_ab', name: 'A-B' }];
    expect(applyInlineMentions('@A-B hi', ab).text).toBe('<at id=ou_ab></at> hi');
  });

  it('is case-insensitive against the registered name', () => {
    expect(applyInlineMentions('@owner ok', [owner]).text).toBe('<at id=ou_owner></at> ok');
  });

  it('escapes regex metacharacters in names', () => {
    const dotty = { open_id: 'ou_dot', name: 'a.b' };
    expect(applyInlineMentions('@a.b hi', [dotty]).text).toBe('<at id=ou_dot></at> hi');
    // the `.` is literal, so `@axb` must NOT match.
    expect(applyInlineMentions('@axb hi', [dotty]).text).toBe('@axb hi');
  });

  it('leaves text untouched when no named mentions are given', () => {
    const r = applyInlineMentions('@张三 hi', [{ open_id: 'ou_x', name: '' }]);
    expect(r.text).toBe('@张三 hi');
    expect(r.usedIds.size).toBe(0);
  });
});
