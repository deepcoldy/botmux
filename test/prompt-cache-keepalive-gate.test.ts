/**
 * Keep-alive write gate: the injected line is submitted with Enter, so it may
 * only land in Claude's real composer — never on a permission dialog or an
 * AskUserQuestion picker, which also read as "idle".
 *
 * Run: bun run vitest run test/prompt-cache-keepalive-gate.test.ts
 */
import { describe, expect, it } from 'vitest';
import { promptCacheKeepaliveRefusal, type PromptCacheKeepaliveWriteProbe } from '../src/core/prompt-cache-keepalive-gate.js';

const READY = /❯/;
const RULE = '─'.repeat(80);

const COMPOSER = [
  '⏺ 记住了，暗号是 MANGO-7341。',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const PERMISSION_DIALOG = [
  '⏺ BOTMUX_NOTHING_TO_SEND',
  '',
  RULE,
  ' Bash command',
  '',
  '   rm -rf build',
  '   Clean the build directory',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands in this project",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

const ASK_USER_QUESTION = [
  RULE,
  ' ☐ Deploy',
  '',
  'Which environment should I deploy to?',
  '',
  '❯ 1. staging',
  '     Safe to break',
  '  2. production',
  '     Real traffic',
  '  3. Type something.',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const ok: PromptCacheKeepaliveWriteProbe = {
  hasBackend: true,
  restarting: false,
  promptReady: true,
  tuiPromptOpen: false,
  bareShell: false,
  inputPending: false,
  screen: COMPOSER,
  readyPattern: READY,
};

describe('promptCacheKeepaliveRefusal', () => {
  it('allows the write only with the cursor in the framed composer', () => {
    expect(promptCacheKeepaliveRefusal(ok)).toBeUndefined();
  });

  it('refuses a permission dialog even though it matches the ready pattern', () => {
    expect(READY.test(PERMISSION_DIALOG)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: PERMISSION_DIALOG })).toBe('action_prompt_open');
  });

  it('refuses an AskUserQuestion picker (prompt not inside an input box)', () => {
    expect(READY.test(ASK_USER_QUESTION)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: ASK_USER_QUESTION })).toBe('prompt_not_framed');
  });

  it('refuses a composer holding an unsent draft, allows an empty one', () => {
    const withLine = (line: string) => COMPOSER.replace('❯ ', line);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('❯ 帮我把这个函数重') })).toBe('composer_not_empty');
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('  ❯ half typed') })).toBe('composer_not_empty');
    // The live empty composer: prompt followed by a non-breaking space.
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('❯\u00a0') })).toBeUndefined();
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('❯') })).toBeUndefined();
  });

  it('fails closed without an authoritative screen', () => {
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: undefined })).toBe('no_screen_evidence');
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: '' })).toBe('no_screen_evidence');
    expect(promptCacheKeepaliveRefusal({ ...ok, readyPattern: undefined })).toBe('no_screen_evidence');
    // A snapshot taken without preserveFormatting has the box rules blanked out.
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: COMPOSER.replaceAll('─', ' ') })).toBe('prompt_not_framed');
  });

  it.each([
    [{ hasBackend: false }, 'no_backend'],
    [{ restarting: true }, 'restarting'],
    [{ promptReady: false }, 'prompt_not_ready'],
    [{ tuiPromptOpen: true }, 'tui_prompt_open'],
    [{ bareShell: true }, 'bare_shell'],
    [{ inputPending: true }, 'input_pending'],
  ] as const)('refuses %j', (override, reason) => {
    expect(promptCacheKeepaliveRefusal({ ...ok, ...override })).toBe(reason);
  });
});
