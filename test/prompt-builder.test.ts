/**
 * Unit tests for prompt building functions: buildNewTopicPrompt, buildFollowUpContent.
 *
 * Covers:
 *   1. buildNewTopicPrompt always includes Session ID (used in normal mode)
 *   2. buildFollowUpContent includes Session ID in normal mode
 *   3. buildFollowUpContent omits Session ID in adopt mode
 *   4. buildFollowUpContent handles attachments and mentions correctly
 *
 * Run:  pnpm vitest run test/prompt-builder.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}));

vi.mock('node:fs', async () => {
  const memfs = await import('memfs');
  return memfs.fs;
});

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/im/lark/client.js', () => ({
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  killStalePids: vi.fn(),
  getCurrentCliVersion: vi.fn(() => '1.0.0'),
}));

// ─── Imports ──────────────────────────────────────────────────────────────

import { buildNewTopicPrompt, buildFollowUpContent, buildReforkPrompt, renderSenderTag, renderCursorSenderNote, renderBufferedSenderBlock } from '../src/core/session-manager.js';
import type { DaemonSession } from '../src/core/types.js';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('buildNewTopicPrompt', () => {
  const SESSION_ID = 'test-session-id-123';

  // Note: claude-code has injectsSessionContext=true so session ID is conveyed
  // out-of-band (system prompt + ancestor-pid auto-detection) rather than
  // embedded in the user prompt. We test session-id embedding via a CLI
  // without that flag (codex).

  it('should embed <session_id> for CLIs without injectsSessionContext', () => {
    const prompt = buildNewTopicPrompt('hello', SESSION_ID, 'codex');
    expect(prompt).toContain(`<session_id>${SESSION_ID}</session_id>`);
  });

  it('should include heredoc guidance for non-Claude CLIs', () => {
    const prompt = buildNewTopicPrompt('hello', SESSION_ID, 'codex');
    expect(prompt).toContain("botmux send <<'EOF'");
    expect(prompt).toContain('第一行');
    expect(prompt).toContain('第二行');
    expect(prompt).toContain('botmux send "第一行\\n第二行"');
    expect(prompt).toContain('字面量');
  });

  it('should NOT embed <session_id> for CLIs with injectsSessionContext (claude-code)', () => {
    const prompt = buildNewTopicPrompt('hello', SESSION_ID, 'claude-code');
    expect(prompt).not.toContain('<session_id>');
  });

  it('should wrap the user message in <user_message>', () => {
    const prompt = buildNewTopicPrompt('请帮我看一下这个 bug', SESSION_ID, 'claude-code');
    expect(prompt).toContain('<user_message>');
    expect(prompt).toContain('请帮我看一下这个 bug');
    expect(prompt).toContain('</user_message>');
  });

  it('folds buffered follow-ups into the single <user_message> block', () => {
    const prompt = buildNewTopicPrompt(
      'first message',
      SESSION_ID,
      'claude-code',
      undefined,
      undefined,
      undefined,
      undefined,
      ['second message', 'third message'],
    );
    // No separate <follow_up_message> blocks anymore — messages buffered during
    // repo selection merge into the opening turn, blank-line separated.
    expect(prompt).not.toContain('<follow_up_message>');
    expect(prompt).toContain('<user_message>\nfirst message\n\nsecond message\n\nthird message\n</user_message>');
  });

  it('should include mention metadata in <mentions>', () => {
    const prompt = buildNewTopicPrompt(
      'hello',
      SESSION_ID,
      'claude-code',
      undefined,
      undefined,
      [{ name: 'Alice', openId: 'ou_alice' }],
    );
    expect(prompt).toContain('<mentions>');
    expect(prompt).toContain('name="Alice"');
    expect(prompt).toContain('open_id="ou_alice"');
  });

  it('puts stable routing and bot identity before the first user message for non-injecting CLIs', () => {
    const prompt = buildNewTopicPrompt(
      'hello',
      SESSION_ID,
      'codex',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { name: 'Codex Bot', openId: 'ou_bot' },
    );

    expect(prompt.indexOf('<botmux_routing>')).toBeLessThan(prompt.indexOf('<identity>'));
    expect(prompt.indexOf('<identity>')).toBeLessThan(prompt.indexOf('<user_message>'));
    expect(prompt.indexOf(`<session_id>${SESSION_ID}</session_id>`)).toBeLessThan(prompt.indexOf('<user_message>'));
  });

  it('keeps per-turn sender and mentions after the first user message', () => {
    const prompt = buildNewTopicPrompt(
      'hello',
      SESSION_ID,
      'codex',
      undefined,
      undefined,
      [{ name: 'Alice', openId: 'ou_alice' }],
      undefined,
      undefined,
      { name: 'Codex Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user', name: 'Sender' },
    );

    expect(prompt.indexOf('<sender ')).toBeGreaterThan(prompt.indexOf('<user_message>'));
    expect(prompt.indexOf('<mentions>')).toBeGreaterThan(prompt.indexOf('<user_message>'));
  });
});

describe('buildFollowUpContent', () => {
  const SESSION_ID = 'follow-up-session-456';

  it('should include <session_id> in normal mode', () => {
    const content = buildFollowUpContent('hello', SESSION_ID);
    expect(content).toContain(`<session_id>${SESSION_ID}</session_id>`);
  });

  it('should include <session_id> when isAdoptMode is false', () => {
    const content = buildFollowUpContent('hello', SESSION_ID, { isAdoptMode: false });
    expect(content).toContain(`<session_id>${SESSION_ID}</session_id>`);
  });

  it('should omit <session_id> in adopt mode', () => {
    const content = buildFollowUpContent('hello', SESSION_ID, { isAdoptMode: true });
    expect(content).not.toContain('<session_id>');
    expect(content).not.toContain('Session ID');
  });

  it('should include user content wrapped in <user_message> in all modes', () => {
    const normalContent = buildFollowUpContent('请修复这个问题', SESSION_ID);
    const adoptContent = buildFollowUpContent('请修复这个问题', SESSION_ID, { isAdoptMode: true });

    expect(normalContent).toContain('<user_message>\n请修复这个问题');
    expect(adoptContent).toContain('<user_message>\n请修复这个问题');
  });

  it('should include attachment block when provided', () => {
    const attachments = [{ type: 'image' as const, path: '/tmp/img.jpg', name: 'img.jpg' }];
    const content = buildFollowUpContent('看这个图', SESSION_ID, { attachments });
    expect(content).toContain('<attachments');
    expect(content).toContain('path="/tmp/img.jpg"');
  });

  it('should include mention metadata in <mentions>', () => {
    const mentions = [{ name: 'Bob', openId: 'ou_bob' }];
    const content = buildFollowUpContent('hello', SESSION_ID, { mentions });
    expect(content).toContain('<mentions>');
    expect(content).toContain('name="Bob"');
    expect(content).toContain('open_id="ou_bob"');
  });

  it('places stable reminder before follow-up user content', () => {
    const content = buildFollowUpContent('hello', SESSION_ID, {
      cliId: 'codex',
      sender: { openId: 'ou_sender', type: 'user', name: 'Sender' },
      mentions: [{ name: 'Bob', openId: 'ou_bob' }],
    });

    expect(content.indexOf('<session_id>')).toBeLessThan(content.indexOf('<botmux_reminder>'));
    expect(content.indexOf('<botmux_reminder>')).toBeLessThan(content.indexOf('<user_message>'));
    expect(content.indexOf('<sender ')).toBeGreaterThan(content.indexOf('</user_message>'));
    expect(content.indexOf('<mentions>')).toBeGreaterThan(content.indexOf('</user_message>'));
  });

  it('should omit <session_id> but keep mentions in adopt mode', () => {
    const mentions = [{ name: 'Charlie', openId: 'ou_charlie' }];
    const content = buildFollowUpContent('hello', SESSION_ID, {
      isAdoptMode: true,
      mentions,
    });
    expect(content).not.toContain('<session_id>');
    expect(content).toContain('name="Charlie"');
    expect(content).toContain('open_id="ou_charlie"');
  });

  it('should omit <session_id> but keep attachments in adopt mode', () => {
    const attachments = [{ type: 'image' as const, path: '/tmp/img.jpg', name: 'img.jpg' }];
    const content = buildFollowUpContent('看图', SESSION_ID, {
      isAdoptMode: true,
      attachments,
    });
    expect(content).not.toContain('<session_id>');
    expect(content).toContain('path="/tmp/img.jpg"');
  });

  it('omits botmux_reminder for Mira follow-ups', () => {
    const content = buildFollowUpContent('继续', SESSION_ID, {
      isAdoptMode: false,
      cliId: 'mira',
    });

    expect(content).not.toContain('<botmux_reminder>');
    expect(content).not.toContain('botmux send');
  });

  it('injects <sender_note> for cursor follow-ups carrying a sender', () => {
    const content = buildFollowUpContent('hi', SESSION_ID, {
      cliId: 'cursor',
      sender: { openId: 'ou_gp', type: 'user', name: '高鹏' },
    });
    // The note must sit right after the <sender> tag so the model reads them together.
    expect(content).toContain('<sender type="user" open_id="ou_gp" name="高鹏" />');
    expect(content).toContain('<sender_note>');
    expect(content).toContain('--mention-back');
    expect(content.indexOf('<sender_note>')).toBeGreaterThan(content.indexOf('<sender '));
  });

  it('does NOT inject <sender_note> for non-cursor CLIs even with a sender', () => {
    const content = buildFollowUpContent('hi', SESSION_ID, {
      cliId: 'codex',
      sender: { openId: 'ou_gp', type: 'user', name: '高鹏' },
    });
    expect(content).toContain('<sender '); // sender tag still present
    expect(content).not.toContain('<sender_note>');
  });

  it('does NOT inject <sender_note> for cursor when there is no sender', () => {
    const content = buildFollowUpContent('hi', SESSION_ID, { cliId: 'cursor' });
    expect(content).not.toContain('<sender_note>');
  });
});

// ─── buildReforkPrompt — wraps re-fork branch (resume / daemon-restart) ─────

describe('buildReforkPrompt', () => {
  const SESSION_ID = 'refork-session-id';

  function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
    return {
      session: {
        sessionId: SESSION_ID,
        chatId: 'oc_chat',
        rootMessageId: 'om_root',
        title: 'topic',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: 'app_test',
      chatId: 'oc_chat',
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 0,
      cliVersion: '1.0.0',
      lastMessageAt: 0,
      hasHistory: true,
      ...overrides,
    } as DaemonSession;
  }

  it('wraps non-adopt re-fork prompt in <user_message> + <botmux_reminder>', () => {
    const ds = makeDs();
    const out = buildReforkPrompt(ds, '继续聊', { cliId: 'codex' });
    expect(out).toContain('<user_message>');
    expect(out).toContain('继续聊');
    expect(out).toContain('</user_message>');
    expect(out).toContain('<botmux_reminder>');
    expect(out).toContain('botmux send');
    expect(out.indexOf('<botmux_reminder>')).toBeLessThan(out.indexOf('<user_message>'));
  });

  it('embeds <session_id> for CLIs without injectsSessionContext (codex)', () => {
    const ds = makeDs();
    const out = buildReforkPrompt(ds, 'hello', { cliId: 'codex' });
    expect(out).toContain(`<session_id>${SESSION_ID}</session_id>`);
  });

  it('omits <session_id> for claude-code (injectsSessionContext=true) but keeps reminder', () => {
    const ds = makeDs();
    const out = buildReforkPrompt(ds, 'hello', { cliId: 'claude-code' });
    expect(out).not.toContain('<session_id>');
    expect(out).toContain('<user_message>');
    expect(out).toContain('<botmux_reminder>');
  });

  it('omits botmux_reminder for Mira re-fork prompts', () => {
    const ds = makeDs();
    const out = buildReforkPrompt(ds, 'hello', { cliId: 'mira' });
    expect(out).toContain('<user_message>');
    expect(out).not.toContain('<session_id>');
    expect(out).not.toContain('<botmux_reminder>');
  });

  it('forwards attachments and mentions to the wrapper', () => {
    const ds = makeDs();
    const out = buildReforkPrompt(ds, '看图', {
      cliId: 'codex',
      attachments: [{ type: 'image', path: '/tmp/x.jpg', name: 'x.jpg' }],
      mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }],
    });
    expect(out).toContain('path="/tmp/x.jpg"');
    expect(out).toContain('name="Alice"');
    expect(out).toContain('open_id="ou_alice"');
  });

  it('uses bridge content (no botmux tags) when ds.adoptedFrom is set', () => {
    const ds = makeDs({
      adoptedFrom: { tmuxTarget: 'foo:0.0', originalCliPid: 1, cwd: '/tmp' },
    });
    const out = buildReforkPrompt(ds, 'hello', {
      cliId: 'claude-code',
      selfMention: { name: 'Claude', openId: 'ou_bot' },
    });
    expect(out).not.toContain('<user_message>');
    expect(out).not.toContain('<botmux_reminder>');
    expect(out).not.toContain('<session_id>');
    expect(out).toContain('hello');
  });
});

// ─── renderSenderTag — <sender> attribute rendering / XML escape ────────────

describe('renderSenderTag', () => {
  it('returns empty string when sender is undefined or has no openId', () => {
    expect(renderSenderTag()).toBe('');
    expect(renderSenderTag({ openId: '', type: 'user' })).toBe('');
  });

  it('emits open_id and type even when name is missing', () => {
    const out = renderSenderTag({ openId: 'ou_xyz', type: 'user' });
    expect(out).toBe('<sender type="user" open_id="ou_xyz" />');
    expect(out).not.toContain('name=');
  });

  it('includes name attribute when present', () => {
    const out = renderSenderTag({ openId: 'ou_a', type: 'user', name: '张三' });
    expect(out).toContain('type="user"');
    expect(out).toContain('open_id="ou_a"');
    expect(out).toContain('name="张三"');
  });

  it('preserves bot type for foreign botmux peers', () => {
    const out = renderSenderTag({ openId: 'ou_b', type: 'bot', name: 'CoCo' });
    expect(out).toContain('type="bot"');
    expect(out).toContain('name="CoCo"');
  });

  it('XML-escapes name and open_id so quotes/angle brackets can\'t break the tag', () => {
    const out = renderSenderTag({
      openId: 'ou_"weird"',
      type: 'user',
      name: '<Alice & "Bob"\'s pal>',
    });
    // Each special char must round-trip via entity references so the attribute
    // string stays well-formed for downstream prompt parsers.
    expect(out).toContain('name="&lt;Alice &amp; &quot;Bob&quot;&apos;s pal&gt;"');
    expect(out).toContain('open_id="ou_&quot;weird&quot;"');
    // And the tag's outer quotes are not eaten by inner ones.
    expect(out.startsWith('<sender ')).toBe(true);
    expect(out.endsWith(' />')).toBe(true);
  });
});

// ─── renderCursorSenderNote — cursor-only anti-echo guard ──────────────────

describe('renderCursorSenderNote', () => {
  it('returns the note only for cursor with a sender present', () => {
    const out = renderCursorSenderNote('cursor', true);
    expect(out).toContain('<sender_note>');
    expect(out).toContain('--mention-back');
  });

  it('returns empty for cursor when no sender tag is present', () => {
    expect(renderCursorSenderNote('cursor', false)).toBe('');
  });

  it('returns empty for every non-cursor CLI', () => {
    for (const cli of ['claude-code', 'codex', 'gemini', 'opencode', 'coco', 'aiden'] as const) {
      expect(renderCursorSenderNote(cli, true)).toBe('');
    }
  });

  it('returns empty when cliId is undefined', () => {
    expect(renderCursorSenderNote(undefined, true)).toBe('');
  });
});

// ─── renderBufferedSenderBlock — daemon pending-repo cross-user buffer ──────
//
// daemon.ts (handleThreadReply) prepends a foreign sender's <sender> tag to a
// buffered follow-up OUTSIDE the builder; it later folds into the opening
// <user_message>. For cursor the tag MUST carry an adjacent anti-echo note,
// else a folded-in ou_xxx:name reaches cursor unguarded.

describe('renderBufferedSenderBlock', () => {
  const SENDER = { openId: 'ou_bob', type: 'user', name: 'Bob' } as const;

  it('pairs the <sender> tag with an adjacent <sender_note> for cursor', () => {
    const out = renderBufferedSenderBlock(SENDER, 'cursor');
    expect(out).toContain('<sender type="user" open_id="ou_bob" name="Bob" />');
    expect(out).toContain('<sender_note>');
    // Note sits right after the tag so cursor reads them together.
    expect(out.indexOf('<sender_note>')).toBeGreaterThan(out.indexOf('<sender '));
  });

  it('renders the bare <sender> tag (no note) for non-cursor CLIs', () => {
    for (const cli of ['claude-code', 'codex', 'gemini', 'opencode', 'coco', 'aiden'] as const) {
      const out = renderBufferedSenderBlock(SENDER, cli);
      expect(out).toContain('open_id="ou_bob"');
      expect(out).not.toContain('<sender_note>');
    }
  });

  it('renders the bare <sender> tag when cliId is undefined', () => {
    const out = renderBufferedSenderBlock(SENDER, undefined);
    expect(out).toContain('open_id="ou_bob"');
    expect(out).not.toContain('<sender_note>');
  });

  it('returns empty when there is no resolvable sender', () => {
    expect(renderBufferedSenderBlock(undefined, 'cursor')).toBe('');
    expect(renderBufferedSenderBlock({ openId: '', type: 'user' }, 'cursor')).toBe('');
  });
});

// ─── buildNewTopicPrompt: buffered cursor follow-up keeps note inside body ──
//
// End-to-end shape: daemon hands buildNewTopicPrompt the buffered string
// produced by renderBufferedSenderBlock; folding into <user_message> must
// preserve the foreign sender's adjacent note (so ou_bob:Bob is guarded even
// though it lives inside the body, not at the top level).

describe('buildNewTopicPrompt cursor buffered multi-user follow-up', () => {
  it('keeps the foreign sender note adjacent inside the folded <user_message>', () => {
    const buffered = `${renderBufferedSenderBlock({ openId: 'ou_bob', type: 'user', name: 'Bob' }, 'cursor')}\nBob 的补充`;
    const prompt = buildNewTopicPrompt(
      '主消息（Alice）', 'sid', 'cursor',
      undefined, undefined, undefined, undefined,
      [buffered],
      undefined, undefined,
      { openId: 'ou_alice', type: 'user', name: 'Alice' },
    );
    const body = prompt.match(/<user_message>\n([\s\S]*?)\n<\/user_message>/)![1];
    expect(body).toContain('open_id="ou_bob"');
    expect(body).toContain('<sender_note>');
    // Bob's inline tag is immediately followed by the note inside the body.
    expect(body.indexOf('<sender_note>')).toBeGreaterThan(body.indexOf('open_id="ou_bob"'));
  });

  it('omits the buffered note for a codex session (bare foreign tag only)', () => {
    const buffered = `${renderBufferedSenderBlock({ openId: 'ou_bob', type: 'user', name: 'Bob' }, 'codex')}\nBob 的补充`;
    const prompt = buildNewTopicPrompt(
      '主消息（Alice）', 'sid', 'codex',
      undefined, undefined, undefined, undefined,
      [buffered],
      undefined, undefined,
      { openId: 'ou_alice', type: 'user', name: 'Alice' },
    );
    const body = prompt.match(/<user_message>\n([\s\S]*?)\n<\/user_message>/)![1];
    expect(body).toContain('open_id="ou_bob"');
    expect(body).not.toContain('<sender_note>');
  });
});

// ─── buildNewTopicPrompt cursor sender-note injection ───────────────────────

describe('buildNewTopicPrompt cursor <sender_note>', () => {
  it('adds <sender_note> for cursor new topics with a sender', () => {
    const prompt = buildNewTopicPrompt(
      'hello', 'sid', 'cursor',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { openId: 'ou_gp', type: 'user', name: '高鹏' },
    );
    expect(prompt).toContain('<sender_note>');
    expect(prompt.indexOf('<sender_note>')).toBeGreaterThan(prompt.indexOf('<sender '));
  });

  it('omits <sender_note> for codex new topics with the same sender', () => {
    const prompt = buildNewTopicPrompt(
      'hello', 'sid', 'codex',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { openId: 'ou_gp', type: 'user', name: '高鹏' },
    );
    expect(prompt).toContain('<sender ');
    expect(prompt).not.toContain('<sender_note>');
  });
});

// ─── pendingRepo multi-sender follow-up regression ─────────────────────────
//
// Repros the scenario the issue tracker called out: A opens a session with
// a question, B补充约束 while the repo card is still pending. Each
// buffered follow-up MUST keep its own sender attribution after the spawn
// finally happens.

describe('buildNewTopicPrompt with multi-user follow-ups', () => {
  it('folds buffered follow-ups into <user_message> while keeping per-message <sender> tags', () => {
    // daemon.ts prefixes a buffered enriched string with a <sender> tag rendered
    // from THAT message's sender when the sender differs from the first message.
    // Builder now merges them all into the single opening <user_message> body
    // rather than separate <follow_up_message> wrappers.
    const followUps = [
      `${renderSenderTag({ openId: 'ou_alice', type: 'user', name: 'Alice' })}\nAlice 的补充约束 1`,
      `${renderSenderTag({ openId: 'ou_bob', type: 'user', name: 'Bob' })}\nBob 的补充约束 2`,
    ];

    const prompt = buildNewTopicPrompt(
      '主消息（来自 Alice）',
      'test-session',
      'codex',
      undefined,
      undefined,
      undefined,
      undefined,
      followUps,
      undefined,
      undefined,
      { openId: 'ou_alice', type: 'user', name: 'Alice' },
    );

    // No separate follow-up blocks — everything folds into the opening turn.
    expect(prompt).not.toContain('<follow_up_message>');
    // One <user_message> carries the main message plus both buffered ones.
    const umMatch = prompt.match(/<user_message>\n([\s\S]*?)\n<\/user_message>/);
    expect(umMatch).not.toBeNull();
    const body = umMatch![1];
    expect(body).toContain('主消息（来自 Alice）');
    expect(body).toContain('Alice 的补充约束 1');
    expect(body).toContain('Bob 的补充约束 2');
    // Per-message sender attribution survives inline for multi-user buffers.
    expect(body).toContain('open_id="ou_alice"');
    expect(body).toContain('open_id="ou_bob"');
  });
});
