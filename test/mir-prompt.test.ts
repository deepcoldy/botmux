/**
 * mir-runner prompt flattening (#2716): the follow-up-only
 * <botmux_formatting> block is not an XML channel mircli can see — the
 * normalizer unwraps the envelope itself — so its guidance must be passed
 * through as a plain "Response formatting:" prose line, and envelope-less
 * input must never leak the raw block (tags or body) to the model.
 */
import { describe, expect, it } from 'vitest';
import { normalizeMircliPrompt } from '../src/mir-prompt.js';

const FMT = '<botmux_formatting>短进度优先纯文本；强调仅包短词或无中文标点的短语，标点和后文放在 `**` 外。</botmux_formatting>';

describe('normalizeMircliPrompt — follow-up formatting guidance', () => {
  it('passes the formatting block through as a prose line before the user request', () => {
    const out = normalizeMircliPrompt(`${FMT}\n\n<botmux_reminder>x</botmux_reminder>\n\n<user_message>\n继续\n</user_message>`);
    expect(out).toContain('Response formatting: 短进度优先纯文本');
    expect(out).toContain('User request:\n继续');
    // Internal wrappers never reach mircli.
    expect(out).not.toContain('<botmux_formatting>');
    expect(out).not.toContain('<botmux_reminder>');
  });

  it('omits the line entirely when no formatting block is present', () => {
    const out = normalizeMircliPrompt('<user_message>\n继续\n</user_message>');
    expect(out).toBe('User request:\n继续');
    expect(out).not.toContain('Response formatting');
  });

  it('envelope-less input keeps the user prose and never leaks the raw formatting block', () => {
    const out = normalizeMircliPrompt(`继续\n\n${FMT}`);
    expect(out).toBe('继续');
  });
});
