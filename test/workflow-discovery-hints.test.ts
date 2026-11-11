import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOTMUX_SHELL_HINTS,
  buildBotmuxShellHints,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';
import { config } from '../src/config.js';
import { t } from '../src/i18n/index.js';

/** Force the experimental anti-resend toggle (config.noVisibleOutputHint) for a
 *  test, restoring the real live getter afterwards. Mirrors how the guidance is
 *  gated in production — default OFF, opt-in via dashboard Settings. */
function setNoVisibleOutputHint(value: boolean): void {
  Object.defineProperty(config, 'noVisibleOutputHint', { get: () => value, configurable: true });
}
const restoreNoVisibleOutputHint = Object.getOwnPropertyDescriptor(config, 'noVisibleOutputHint');
afterEach(() => {
  if (restoreNoVisibleOutputHint) Object.defineProperty(config, 'noVisibleOutputHint', restoreNoVisibleOutputHint);
});

describe('Workflow discovery hint (enabled hosts)', () => {
  beforeEach(() => { process.env.BOTMUX_WORKFLOW_ENABLED = 'true'; });
  afterEach(() => { delete process.env.BOTMUX_WORKFLOW_ENABLED; });

  it('stays a short single line in zh/en shell hints and points at /workflow + the on-demand skill', () => {
    const zh = buildBotmuxShellHints('zh').find((line) => line.startsWith('Workflow：'));
    const en = buildBotmuxShellHints('en').find((line) => line.startsWith('Workflow:'));
    expect(zh).toContain('/workflow');
    expect(zh).toContain('botmux skill show botmux-workflow');
    expect(en).toContain('/workflow');
    expect(en).toContain('botmux skill show botmux-workflow');
    // It is the only resident workflow text left in every session: keep it short.
    expect(zh!.length).toBeLessThan(100);
    expect(en!.length).toBeLessThan(140);
    expect(BOTMUX_SHELL_HINTS.some((line) => line.includes('/workflow'))).toBe(true);
  });

  it('also appears once in injectsSessionContext system routing', () => {
    const prompt = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(prompt.match(/Workflow：/g)).toHaveLength(1);
    expect(prompt.indexOf('Workflow：')).toBeLessThan(prompt.indexOf('</botmux_routing>'));
  });
});

describe.each(['zh', 'en'] as const)('anti-resend guidance (%s), gated on config.noVisibleOutputHint', (locale) => {
  // Verify gating and placement against the locale catalog, not an obsolete
  // wording snapshot: copy edits must not break the configuration contract.
  const shellHint = () => t('ai.shell.no_visible_output_ok', undefined, locale);
  const routingHint = () => t('ai.routing.no_visible_output_ok', undefined, locale);

  it('omits the optional guidance when the toggle is OFF', () => {
    setNoVisibleOutputHint(false);
    expect(buildBotmuxShellHints(locale)).not.toContain(shellHint());
    expect(buildBotmuxSystemPromptText({ locale })).not.toContain(routingHint());
  });

  it('includes the current shell guidance only in the dynamic hints when ON', () => {
    setNoVisibleOutputHint(true);
    expect(buildBotmuxShellHints(locale).filter(line => line === shellHint())).toHaveLength(1);
    // The deprecated static array must never read runtime config at module load.
    expect(BOTMUX_SHELL_HINTS).not.toContain(shellHint());
  });

  it('includes the current routing guidance once, inside the routing block, when ON', () => {
    setNoVisibleOutputHint(true);
    const prompt = buildBotmuxSystemPromptText({ locale });
    const hint = routingHint();
    expect(prompt.split(hint)).toHaveLength(2);
    expect(prompt.indexOf(hint)).toBeGreaterThan(prompt.indexOf('<botmux_routing>'));
    expect(prompt.indexOf(hint) + hint.length).toBeLessThan(prompt.indexOf('</botmux_routing>'));
  });
});
