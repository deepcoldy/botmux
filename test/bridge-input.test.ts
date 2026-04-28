/**
 * Tests that bridge-mode input does NOT leak any botmux-specific instructions
 * to the model. The model in bridge mode is the user's original CLI (botmux
 * unaware) — it must not see <session_id>, <botmux_reminder>, or any "use
 * botmux send" hints.
 */
import { describe, it, expect } from 'vitest';
import { buildBridgeInputContent, buildFollowUpContent } from '../src/core/session-manager.js';
import type { LarkAttachment, LarkMention } from '../src/types.js';

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
    const mentions: LarkMention[] = [{ key: '@_1', name: 'Codex', openId: 'ou_xxx' }];
    const out = buildBridgeInputContent('please review', { attachments: att, mentions });
    expect(out).toContain('please review');
    expect(out).toContain('a.png');
    expect(out).toContain('/tmp/a.png');
    expect(out).toContain('@Codex');
  });

  it('contrast: buildFollowUpContent (non-bridge) DOES inject botmux_reminder', () => {
    const out = buildFollowUpContent('hi', 'sid-123', { isAdoptMode: false });
    // baseline: confirms the test for buildBridgeInputContent is meaningful
    expect(out).toContain('botmux_reminder');
  });
});
