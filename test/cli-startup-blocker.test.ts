/**
 * Screens on which a freshly spawned CLI waits for a human before opening its
 * composer. Fixtures are real `tmux capture-pane -p` captures (trailing blanks
 * trimmed): the Grok trust dialog is the exact screen of the 2026-10-24 stall
 * (Grok Build 1.0.67 in /root/ec-apply-access), reproduced with an isolated
 * GROK_HOME; the Gemini screens come from 0.65.0 under an isolated HOME.
 * `*.tmux-e.ansi` are `capture-pane -e -p` captures of the same dialogs — the
 * form the default tmux backend actually hands the worker.
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

  it('recognizes the same dialogs as the default tmux backend captures them (capture-pane -e)', () => {
    // Production reads TmuxPipeBackend.captureViewport(): SGR codes open the
    // lines and sit right before the option text.
    expect(detectCliStartupBlocker(fixture('grok-1.0.70-folder-trust.tmux-e.ansi'))).toEqual({
      kind: 'folder_trust',
      rule: 'grok-folder-trust',
      folder: '/root/ec-apply-access',
    });
    expect(detectCliStartupBlocker(fixture('gemini-0.65.0-folder-trust.tmux-e.ansi'))).toEqual({
      kind: 'folder_trust',
      rule: 'gemini-folder-trust',
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

  it('does not fire on a transcript that quotes every known dialog mid-sentence', () => {
    // E.g. a resumed session whose history discusses these very dialogs.
    const transcript = [
      '  ⏺ 盘点结果：Grok 问 "Do you trust the contents of this directory?"，选项是 Yes, proceed 和 No, quit；',
      '    Gemini 问 "Do you trust the files in this folder?"，选项 Trust folder (x) / Don\'t trust；',
      '    Claude 是 "Quick safety check: Is this a project you created or one you trust?" 加 Yes, I trust this folder；',
      '    agy 是 Trust this folder? 加 Yes, I trust this folder；Cursor 会显示 Workspace Trust Required 和 Trust this workspace；',
      '    Codex 用 Trust and continue / Yes, continue；Pi 是 Trust project folder? / Do not trust；',
      '    登录屏有 Approve in your browser to finish signing in. Waiting for approval…、Select login method: 和',
      '    Claude account with subscription、Sign in with ChatGPT / Provide your own API key、Welcome to TRAE CLI /',
      '    Sign in with a Personal Access Token、Press any key to log in...、How would you like to authenticate for this',
      '    project? 下面 Use Gemini API Key；升级框有 Kimi Code Update Available / Install update now / Continue with',
      '    current version、Update available! / Skip until next version、MTR 的 A new release v0.4.12 is available.',
      '    Would you like to update now?；还有 Bypass Permissions mode 下的 Yes, I accept。',
      '  ╭──────────────────────────────────────────╮',
      '  │ ❯                                        │',
      '  ╰──────────────────────────────────────────╯',
    ].join('\n');
    expect(detectCliStartupBlocker(transcript)).toBeNull();
  });

  it('keys notify-once bookkeeping by kind and folder', () => {
    const blocker = detectCliStartupBlocker(fixture('grok-1.0.67-folder-trust.txt'))!;
    expect(startupBlockerKey(blocker)).toBe('folder_trust:/root/ec-apply-access');
    expect(startupBlockerKey({ kind: 'login', rule: 'x' })).toBe('login:');
  });
});
