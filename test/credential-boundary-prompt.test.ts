/**
 * The credential-boundary prompt block.
 *
 * This release ships trigger-user auth WITHOUT kernel-level isolation, so this
 * block is the only thing standing between an agent and another person's token
 * file. That makes two properties worth pinning:
 *
 *   1. It reaches BOTH prompt paths. Claude-family adapters build their own
 *      system prompt; codex/gemini get an inline one. A block present in only
 *      one is a silent hole in whichever CLI the operator happens to run.
 *   2. It says what not to do AND what to do instead. "Don't read those files"
 *      alone leaves an agent debugging an auth failure with no alternative —
 *      which is exactly the situation that makes it go looking.
 *
 * Run:  npx vitest run --project unit test/credential-boundary-prompt.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  buildCredentialBoundaryBlock,
  buildBotmuxSystemPromptText,
} from '../src/adapters/cli/shared-hints.js';

describe('buildCredentialBoundaryBlock', () => {
  it('names the exact files an agent must not read', () => {
    const zh = buildCredentialBoundaryBlock('zh');
    // A vague "don't touch credentials" is unactionable; the path is what makes
    // the rule checkable by the agent itself.
    expect(zh).toContain('user-token-');
    expect(zh).toContain('~/.botmux/data/');
  });

  it('tells the agent what to do instead of hunting for credentials', () => {
    const zh = buildCredentialBoundaryBlock('zh');
    expect(zh).toContain('/login');
  });

  it('covers forwarding, not just reading', () => {
    // Reading is one leak path; pasting a token the agent legitimately holds
    // into a message or a commit is another, and far easier to do by accident.
    const en = buildCredentialBoundaryBlock('en');
    expect(en.toLowerCase()).toContain('commit');
    expect(en.toLowerCase()).toContain('log');
  });

  it('is wrapped in one tagged block so it reads as policy, not prose', () => {
    const zh = buildCredentialBoundaryBlock('zh');
    expect(zh.startsWith('<botmux_credentials>')).toBe(true);
    expect(zh.trimEnd().endsWith('</botmux_credentials>')).toBe(true);
  });

  it('renders in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(buildCredentialBoundaryBlock(locale)).toContain('user-token-');
    }
  });
});

describe('buildBotmuxSystemPromptText — claude-family path', () => {
  it('adds the block when trigger-user auth is on', () => {
    const text = buildBotmuxSystemPromptText({ locale: 'zh', triggerUserAuth: true });
    expect(text).toContain('<botmux_credentials>');
    expect(text).toContain('user-token-');
  });

  // A bot that never enabled the feature must not pay for prompt text about a
  // boundary it does not have.
  it('adds nothing when the feature is off', () => {
    const off = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(off).not.toContain('<botmux_credentials>');
    expect(off).not.toContain('user-token-');
  });

  it('keeps the block for a no-transport session', () => {
    // No Feishu channel does not mean no credentials: the CLI still runs as a
    // person and the token store still holds everyone else's files.
    const text = buildBotmuxSystemPromptText({
      locale: 'zh', triggerUserAuth: true, noTransport: true,
    });
    expect(text).toContain('<botmux_credentials>');
  });

  it('emits the block exactly once', () => {
    const text = buildBotmuxSystemPromptText({
      locale: 'zh', botName: 'b', botOpenId: 'ou_x', triggerUserAuth: true,
    });
    expect(text.match(/<botmux_credentials>/g)).toHaveLength(1);
  });
});
