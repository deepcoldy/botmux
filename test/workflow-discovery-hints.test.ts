import { describe, expect, it } from 'vitest';

import {
  BOTMUX_SHELL_HINTS,
  buildBotmuxShellHints,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';

describe('always-on Workflow discovery hint', () => {
  it('advertises bounded DAGs and reuse in zh/en shell hints', () => {
    const zh = buildBotmuxShellHints('zh').find((line) => line.startsWith('Workflow：'));
    const en = buildBotmuxShellHints('en').find((line) => line.startsWith('Workflow:'));
    expect(zh).toContain('/workflow');
    expect(zh).toContain('保存复用');
    expect(en).toContain('/workflow');
    expect(en).toContain('saved and reused');
    expect(zh!.length).toBeLessThan(100);
    expect(en!.length).toBeLessThan(140);
    expect(BOTMUX_SHELL_HINTS.some((line) => line.includes('/workflow'))).toBe(true);
  });

  it('also appears once in injectsSessionContext system routing', () => {
    const prompt = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(prompt.match(/Workflow：有界的多步目标/g)).toHaveLength(1);
    expect(prompt.indexOf('Workflow：')).toBeLessThan(prompt.indexOf('</botmux_routing>'));
  });
});

describe('anti-resend guidance (thinking-only nudge false-alarm)', () => {
  it('is present in zh/en shell hints', () => {
    expect(buildBotmuxShellHints('zh').some((l) => l.includes('无可见输出') || l.includes('不要重发'))).toBe(true);
    expect(buildBotmuxShellHints('en').some((l) => l.toLowerCase().includes('no visible output') && l.toLowerCase().includes('do not resend'))).toBe(true);
    expect(BOTMUX_SHELL_HINTS.some((l) => l.includes('不要重发') || l.toLowerCase().includes('do not resend'))).toBe(true);
  });

  it('is present in injectsSessionContext system routing (zh/en), inside the routing block', () => {
    const zh = buildBotmuxSystemPromptText({ locale: 'zh' });
    const en = buildBotmuxSystemPromptText({ locale: 'en' });
    expect(zh).toContain('不要因此重发');
    expect(en.toLowerCase()).toContain('do not resend');
    // Must live inside <botmux_routing>…</botmux_routing>, not leak after it.
    expect(zh.indexOf('不要因此重发')).toBeLessThan(zh.indexOf('</botmux_routing>'));
    expect(en.toLowerCase().indexOf('do not resend')).toBeLessThan(en.indexOf('</botmux_routing>'));
  });
});
