import { describe, expect, it } from 'vitest';
import { cssRuleBody } from './helpers/css-rule.js';

describe('cssRuleBody', () => {
  it('returns only the requested flat rule body', () => {
    const css = '.target { color: red; }\n.other { color: blue; }';
    expect(cssRuleBody(css, '.target')).toBe(' color: red; ');
  });

  it('fails closed when the requested rule contains a nested block', () => {
    const css = '.target { color: red; & > span { color: blue; } }';
    expect(() => cssRuleBody(css, '.target')).toThrow('nested CSS rule is unsupported');
  });

  it('fails closed for missing and unterminated rules', () => {
    expect(() => cssRuleBody('.other { color: blue; }', '.target')).toThrow('selector not found');
    expect(() => cssRuleBody('.target { color: red;', '.target')).toThrow('unterminated CSS rule');
  });
});
