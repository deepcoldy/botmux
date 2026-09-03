/**
 * Tests that bridge-mode input does NOT leak any botmux-specific instructions
 * to the model. The model in bridge mode is the user's original CLI (botmux
 * unaware) — it must not see <session_id>, <botmux_reminder>, or any "use
 * botmux send" hints.
 */
import { describe, it, expect, vi } from 'vitest';

// Whiteboard is opt-in (global config, default OFF), so the <whiteboard> block
// would never render here and the no-transport whiteboard-gate cases below would
// pass VACUOUSLY. Force it on — and note those cases assert the baseline (real
// Feishu session) DOES carry the send directive, so a broken gate actually fails.
vi.mock('../src/services/whiteboard-store.js', () => ({
  whiteboardEnabled: vi.fn(() => true),
  getWhiteboard: vi.fn((id: string) => ({
    id,
    title: 'Whiteboard: repo',
    scope: 'project',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  })),
  ensureDefaultWhiteboard: vi.fn(),
  whiteboardBoardPath: vi.fn((id: string) => `/tmp/test-sessions/whiteboards/${id}/board.md`),
}));

import { buildBridgeInputContent, buildFollowUpContent, buildNewTopicPrompt } from '../src/core/session-manager.js';
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

  it('strips leading self mention and omits it from mention prose', () => {
    const mentions: LarkMention[] = [{ key: '@_1', name: 'Codex', openId: 'ou_self' }];
    const out = buildBridgeInputContent('@Codex hello', {
      mentions,
      selfMention: { name: 'Codex', openId: 'ou_self' },
    });

    expect(out).toBe('hello');
  });

  it('keeps non-self mentions while filtering self mentions', () => {
    const mentions: LarkMention[] = [
      { key: '@_1', name: 'Codex', openId: 'ou_self' },
      { key: '@_2', name: 'Claude', openId: 'ou_other' },
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
      { key: '@_1', name: 'Codex 分身', openId: 'ou_self' },
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
      { key: '@_1', name: 'Claude', openId: 'ou_other' },
    ];
    const out = buildBridgeInputContent('hi team', {
      mentions,
      selfMention: { name: 'Claude', openId: 'ou_self' },
    });
    expect(out).toContain('[@提及]');
    expect(out).toContain('@Claude');
  });

  it('does not crash when selfMention is omitted (regression: legacy callers)', () => {
    const mentions: LarkMention[] = [{ key: '@_1', name: 'Codex', openId: 'ou_xxx' }];
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

  // ── no-transport follow-up reminder (质量①, 3rd injection site): an HTTP
  //    virtual session (http_async_*/http_wait_*) — the follow-up path #71's
  //    turnIdempotencyKey opens — must NOT get the send/@/silence reminder, which
  //    carries the BOTMUX_NOTHING_TO_SEND sentence that conflicts with the
  //    per-turn <botmux_http_response_mode>. The chatId test alone proves
  //    no-transport (no bot lookup needed), so this works without a registry mock.
  it('swaps the follow-up reminder to the no-transport variant for an HTTP virtual session', () => {
    const out = buildFollowUpContent('hi', 'sid-http', {
      isAdoptMode: false,
      cliId: 'codex',
      chatId: 'http_async_abc123',
    });
    // Reminder block is still present…
    expect(out).toContain('<botmux_reminder>');
    // …but carries NO sentinel semantics (the conflict we removed) and no
    // "reply via botmux send" directive. It only *prohibits* send (为程序任务防止
    // 误发飞书), which is a negative instruction — assert the sentinel + the
    // positive "respond via send" phrasing are gone, not the bare token.
    expect(out).not.toContain('BOTMUX_NOTHING_TO_SEND');
    expect(out).not.toContain('回应一次'); // zh "respond at least once via send"
    expect(out).toContain('不要调用 botmux send'); // explicit prohibition retained
    // It points the model at the per-turn http_response_mode block instead.
    expect(out).toContain('botmux_http_response_mode');
  });

  it('keeps the standard reminder (with sentinel) for a real Feishu follow-up', () => {
    const out = buildFollowUpContent('hi', 'sid-real', {
      isAdoptMode: false,
      cliId: 'codex',
      chatId: 'oc_realchat',
    });
    expect(out).toContain('<botmux_reminder>');
    expect(out).toContain('BOTMUX_NOTHING_TO_SEND');
  });

  // ── no-transport identity gate (质量①, codex #1098 review): the non-injects
  //    first-turn <identity> block carries short_routing (the --mention collab
  //    requirement). For an HTTP virtual session it must keep name/open_id but
  //    drop routing_rules — botIdentity reaches HTTP turns even for a normal bot.
  it('drops the identity routing_rules for an HTTP virtual first turn, keeps name/open_id', () => {
    const out = buildNewTopicPrompt(
      'hi', 'sid-http', 'codex', undefined, undefined, undefined, undefined, undefined,
      { name: 'MyBot', openId: 'ou_abc' }, 'en', undefined,
      { larkAppId: 'app1', chatId: 'http_async_x' },
    );
    expect(out).toContain('<identity>');
    expect(out).toContain('<name>MyBot</name>');
    expect(out).toContain('<open_id>ou_abc</open_id>');
    expect(out).not.toContain('<routing_rules>');
    expect(out).not.toContain('botmux send'); // no --mention directive leaks
  });

  it('keeps the identity routing_rules for a real Feishu first turn', () => {
    const out = buildNewTopicPrompt(
      'hi', 'sid-real', 'codex', undefined, undefined, undefined, undefined, undefined,
      { name: 'MyBot', openId: 'ou_abc' }, 'en', undefined,
      { larkAppId: 'app1', chatId: 'oc_realchat' },
    );
    expect(out).toContain('<routing_rules>');
    expect(out).toContain('botmux send --mention');
  });
  // ── no-transport whiteboard gate (#1098 follow-up): the <whiteboard> block's
  //    last line carried「用户可见结论仍必须 `botmux send`」unconditionally, which is
  //    the SAME conflicting directive this PR removes from routing/reminder —
  //    `botmux send` is hard-refused in these sessions (assertTurnTransportOrExit
  //    → exit 2) while <botmux_http_response_mode> says not to send. The block is
  //    injected on BOTH the first turn and follow-ups, so both must be gated. The
  //    privacy / no-local-file rules are transport-independent and must SURVIVE.
  it('drops the whiteboard send directive for a no-transport session, keeps the privacy rules', () => {
    const followUp = buildFollowUpContent('hi', 'sid-wb', {
      isAdoptMode: false,
      cliId: 'codex',
      chatId: 'http_async_wb',
      whiteboardId: 'wb-1',
    });
    const firstTurn = buildNewTopicPrompt(
      'hi', 'sid-wb2', 'codex', undefined, undefined, undefined, undefined, undefined,
      undefined, 'zh', undefined,
      { larkAppId: 'app-wb', chatId: 'http_async_wb', whiteboardId: 'wb-1' },
    );
    for (const out of [followUp, firstTurn]) {
      // The whiteboard block itself is still delivered (it is real, usable context)…
      expect(out).toContain('<whiteboard id="wb-1">');
      expect(out).toContain('botmux whiteboard read');
      // …but its trailing line no longer ORDERS a send. Assert on the block itself:
      // the no-transport reminder legitimately contains「不要调用 botmux send」(a
      // prohibition), so a prompt-wide `not.toContain('botmux send')` would match
      // that and fail for the wrong reason.
      const wb = /<whiteboard id="wb-1">([\s\S]*?)<\/whiteboard>/.exec(out)?.[1] ?? '';
      expect(wb).not.toContain('botmux send');
      // Transport-independent rules survive inside the block.
      expect(wb).toContain('不要写密钥/隐私');
      expect(wb).toContain('不要直接读写本地文件');
    }
  });

  it('keeps the whiteboard send directive for a real Feishu session (baseline has discriminating power)', () => {
    const out = buildFollowUpContent('hi', 'sid-wb3', {
      isAdoptMode: false,
      cliId: 'codex',
      chatId: 'oc_realchat',
      whiteboardId: 'wb-1',
    });
    expect(out).toContain('<whiteboard id="wb-1">');
    // Guards the negative: without the gate this line is present INSIDE the block,
    // so the assertion above can actually fail if the gate is reverted. Scoped to
    // the block for the same reason (a prompt-wide match would hit the reminder).
    const wb = /<whiteboard id="wb-1">([\s\S]*?)<\/whiteboard>/.exec(out)?.[1] ?? '';
    expect(wb).toContain('botmux send');
  });
});
