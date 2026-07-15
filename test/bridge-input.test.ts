/**
 * Tests that bridge-mode input does NOT leak any botmux-specific instructions
 * to the model. The model in bridge mode is the user's original CLI (botmux
 * unaware) — it must not see <session_id>, <botmux_reminder>, or any "use
 * botmux send" hints.
 */
import { describe, it, expect } from 'vitest';
import { buildBridgeInputContent, buildFollowUpContent } from '../src/core/session-manager.js';
import type { LarkAttachment, LarkMention } from '../src/types.js';

function mention(key: string, name: string, openId: string): LarkMention {
  return { key, token: key, name, openId, identity: { id: openId } };
}

describe('buildBridgeInputContent', () => {
  it('returns just the user content when no attachments / mentions', () => {
    expect(buildBridgeInputContent('hello world')).toBe('hello world');
  });

  it('does not inject botmux_reminder', () => {
    const out = buildBridgeInputContent('hello');
    expect(out).not.toContain('botmux_reminder');
    expect(out).not.toContain('botmux send');
  });

  it('does not inject <session_id>', () => {
    const out = buildBridgeInputContent('hello');
    expect(out).not.toContain('<session_id>');
  });

  it('appends attachments and mentions as plain prose', () => {
    const att: LarkAttachment[] = [{ type: 'image', name: 'a.png', path: '/tmp/a.png' }];
    const mentions: LarkMention[] = [mention('@_1', 'Codex', 'ou_xxx')];
    const out = buildBridgeInputContent('please review', { attachments: att, mentions });
    expect(out).toContain('please review');
    expect(out).toContain('a.png');
    expect(out).toContain('/tmp/a.png');
    expect(out).toContain('@Codex');
  });

  it('strips leading self mention and omits it from mention prose', () => {
    const mentions: LarkMention[] = [mention('@_1', 'Codex', 'ou_self')];
    const out = buildBridgeInputContent('@Codex hello', {
      mentions,
      selfMention: { name: 'Codex', openId: 'ou_self' },
    });

    expect(out).toBe('hello');
  });

  it('keeps non-self mentions while filtering self mentions', () => {
    const mentions: LarkMention[] = [
      mention('@_1', 'Codex', 'ou_self'),
      mention('@_2', 'Claude', 'ou_other'),
    ];
    const out = buildBridgeInputContent('@Codex ask Claude', {
      mentions,
      selfMention: { name: 'Codex', openId: 'ou_self' },
    });

    expect(out).toContain('ask Claude');
    expect(out).not.toContain('@Codex');
    expect(out).toContain('@Claude');
  });

  it('does not strip non-mention prefixes that merely start with the bot name', () => {
    const out = buildBridgeInputContent('@CodexFoo hello', {
      selfMention: { name: 'Codex', openId: 'ou_self' },
    });

    expect(out).toBe('@CodexFoo hello');
  });

  it('strips multiple consecutive leading self mentions', () => {
    const out = buildBridgeInputContent('@Codex @Codex hello', {
      selfMention: { name: 'Codex', openId: 'ou_self' },
    });
    expect(out).toBe('hello');
  });

  it('preserves a self mention that is not at the leading position', () => {
    const out = buildBridgeInputContent('please ask @Codex about this', {
      selfMention: { name: 'Codex', openId: 'ou_self' },
    });
    expect(out).toBe('please ask @Codex about this');
  });

  it('treats newline after the bot name as a valid token boundary', () => {
    const out = buildBridgeInputContent('@Codex\nhello', {
      selfMention: { name: 'Codex', openId: 'ou_self' },
    });
    expect(out).toBe('hello');
  });

  it('strips alias name resolved via mention list when selfMention has only openId', () => {
    // Cold-start scenario: bot's display name (probeBotOpenId) hasn't returned
    // yet, but the inbound mention carries the openId — stripping should still
    // pick up the alias from the mentions list.
    const mentions: LarkMention[] = [
      mention('@_1', 'Codex 分身', 'ou_self'),
    ];
    const out = buildBridgeInputContent('@Codex 分身 hello', {
      mentions,
      selfMention: { openId: 'ou_self' },
    });
    expect(out).toBe('hello');
  });

  it('does not classify a different bot as self when only display name matches', () => {
    // Two bots happen to share a display name but have distinct openIds.
    // openId is authoritative — the other bot's mention must survive in
    // the [@提及] block.
    const mentions: LarkMention[] = [
      mention('@_1', 'Claude', 'ou_other'),
    ];
    const out = buildBridgeInputContent('hi team', {
      mentions,
      selfMention: { name: 'Claude', openId: 'ou_self' },
    });
    expect(out).toContain('[@提及]');
    expect(out).toContain('@Claude');
  });

  it('falls back to name matching when a mention identity is not an open_id', () => {
    const out = buildBridgeInputContent('@Claude hello', {
      mentions: [{
        key: '@_1', token: '@_1', name: 'Claude', openId: undefined,
        identity: { id: 'user-1', idType: 'user_id' },
      }],
      selfMention: { name: 'Claude', openId: 'ou_self' },
    });
    expect(out).toBe('hello');
  });

  it('does not crash when selfMention is omitted (regression: legacy callers)', () => {
    const mentions: LarkMention[] = [mention('@_1', 'Codex', 'ou_xxx')];
    const out = buildBridgeInputContent('@Codex hello', { mentions });
    // Without selfMention we keep legacy behavior — leading @Codex stays,
    // mention block stays.
    expect(out).toContain('@Codex hello');
    expect(out).toContain('[@提及]');
  });

  it('contrast: buildFollowUpContent (non-bridge) DOES inject botmux_reminder', () => {
    const out = buildFollowUpContent('hi', 'sid-123', { isAdoptMode: false });
    // baseline: confirms the test for buildBridgeInputContent is meaningful
    expect(out).toContain('botmux_reminder');
  });
});
