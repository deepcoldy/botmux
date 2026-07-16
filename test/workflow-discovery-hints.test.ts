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
