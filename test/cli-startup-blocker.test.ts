/**
 * Screens on which a freshly spawned CLI waits for a human before opening its
 * composer. Fixtures are real `tmux capture-pane -p` captures (trailing blanks
 * trimmed): the Grok trust dialog is the exact screen of the 2026-10-24 stall
 * (Grok Build 1.0.67 in /root/ec-apply-access), reproduced with an isolated
 * GROK_HOME; the Gemini screens come from 0.65.0 under an isolated HOME.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCliStartupBlocker, startupBlockerKey } from '../src/core/cli-startup-blocker.js';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures/startup-blockers', name), 'utf-8');

describe('detectCliStartupBlocker', () => {
  it('recognizes the Grok folder-trust dialog and the folder it asks about', () => {
    expect(detectCliStartupBlocker(fixture('grok-1.0.67-folder-trust.txt'))).toEqual({
      kind: 'folder_trust',
      rule: 'grok-folder-trust',
      folder: '/root/ec-apply-access',
    });
  });

  it('recognizes the Grok browser sign-in screen', () => {
    expect(detectCliStartupBlocker(fixture('grok-1.0.70-login.txt'))).toEqual({
      kind: 'login',
      rule: 'grok-browser-sign-in',
    });
  });

  it('recognizes the Gemini CLI folder-trust dialog the worker does not auto-accept', () => {
    expect(detectCliStartupBlocker(fixture('gemini-0.65.0-folder-trust.txt'))).toEqual({
      kind: 'folder_trust',
      rule: 'gemini-folder-trust',
    });
  });

  it('recognizes the Gemini CLI authentication picker', () => {
    expect(detectCliStartupBlocker(fixture('gemini-0.65.0-auth.txt'))).toEqual({
      kind: 'login',
      rule: 'gemini-auth-method',
    });
  });

  it('does not fire on a ready Grok composer', () => {
    expect(detectCliStartupBlocker(fixture('grok-1.0.70-composer.txt'))).toBeNull();
  });

  it('does not fire on prose that merely quotes the question', () => {
    const conversation = [
      '  ╭──────────────────────────────────────────╮',
      '  │ 启动时弹出「Do you trust the contents of this directory? /root/ec-apply-access」确认框，',
      '  │ 不选就不进对话。选项是 Yes, proceed / No, quit。',
      '  ╰──────────────────────────────────────────╯',
      '  │ ❯ ',
    ].join('\n');
    expect(detectCliStartupBlocker(conversation)).toBeNull();
    expect(detectCliStartupBlocker('')).toBeNull();
  });

  it('keys notify-once bookkeeping by kind and folder', () => {
    const blocker = detectCliStartupBlocker(fixture('grok-1.0.67-folder-trust.txt'))!;
    expect(startupBlockerKey(blocker)).toBe('folder_trust:/root/ec-apply-access');
    expect(startupBlockerKey({ kind: 'login', rule: 'x' })).toBe('login:');
  });
});
