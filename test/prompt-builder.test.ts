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
import { describe, it, expect, vi, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], cb?: (...args: any[]) => void) => {
    if (typeof cb === 'function') cb(null, '', '');
    return {} as any;
  }),
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
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

// Mutable per-test bot config so the senderTag gate can be exercised in both
// states. Default shape matches the previous static mock byte-for-byte, so every
// pre-existing test keeps its original behavior.
const mockBotConfig: Record<string, unknown> = {
  larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code',
};

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: mockBotConfig })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/services/whiteboard-store.js', () => ({
  ensureDefaultWhiteboard: vi.fn(),
  getWhiteboard: vi.fn((id: string) => ({
    id,
    title: 'Whiteboard: repo',
    scope: 'project',
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  })),
  whiteboardBoardPath: vi.fn((id: string) => `/tmp/test-sessions/whiteboards/${id}/board.md`),
  whiteboardEnabled: vi.fn(() => true),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  killStalePids: vi.fn(),
  sweepDeadPidMarkers: vi.fn(),
  getActiveSessionsRegistry: vi.fn(() => undefined),
  getCurrentCliVersion: vi.fn(() => '1.0.0'),
}));

// ─── Imports ──────────────────────────────────────────────────────────────

import { buildNewTopicPrompt, buildFollowUpContent, buildReforkPrompt, renderSenderTag, renderCursorSenderNote, renderBufferedSenderBlock } from '../src/core/session-manager.js';
import { config } from '../src/config.js';
import { BOTMUX_SHELL_HINTS, buildBotmuxShellHints, buildBotmuxSystemPromptText } from '../src/adapters/cli/shared-hints.js';
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
    expect(prompt).not.toContain("botmux send &lt;&lt;'EOF'");
    expect(prompt).toContain('第一行');
    expect(prompt).toContain('第二行');
    expect(prompt).toContain('botmux send "第一行\\n第二行"');
    expect(prompt).toContain('字面量');
    expect(prompt).toContain('JSON.stringify');
    expect(prompt).toContain('--content-file');
  });

  it('tells non-injecting CLIs to silently obey hidden launch context and answer only user_message', () => {
    const prompt = buildNewTopicPrompt('hello', SESSION_ID, 'codex');
    const routing = prompt.slice(prompt.indexOf('<botmux_routing>'), prompt.indexOf('</botmux_routing>'));

    expect(routing).toContain('隐藏运行上下文');
    expect(routing).toContain('&lt;botmux_builtin_skills&gt;');
    expect(routing).toContain('&lt;identity&gt;');
    expect(routing).toContain('&lt;available_bots&gt;');
    expect(routing).toContain('不要回复、不要确认');
    expect(routing).toContain('已了解/已补充/已记录');
    expect(routing).toContain('只处理 `&lt;user_message&gt;` 中的真实用户请求');
    expect(routing).not.toContain('&amp;lt;');
  });

  it('gives Hermes the standard botmux-send routing hints like other structured-bridge CLIs', () => {
    // #365 previously steered Hermes AWAY from `botmux send` (reverse guidance)
    // as a redundant belt-and-braces on top of the real dedup fix
    // (preserveMarkTimeMs). That reverse hint weakened multi-agent collaboration
    // (bridge-forwarded finals can't carry an @mention), so Hermes now uses the
    // same send-first hints as codex/traex/grok.
    const prompt = buildNewTopicPrompt('hello', SESSION_ID, 'hermes');
    expect(prompt).toContain('把消息发给用户（唯一方式）');
    expect(prompt).not.toContain('普通文本答案不要调用 `botmux send`');
    expect(prompt).not.toContain('botmux 会自动把 final_output 转发到飞书');
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

  it('places the short whiteboard hint before user content', () => {
    const prompt = buildNewTopicPrompt(
      'ship this',
      SESSION_ID,
      'claude-code',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { whiteboardId: 'wb_test' },
    );

    expect(prompt).toContain('<whiteboard id="wb_test">');
    expect(prompt).toContain('读取：`botmux whiteboard read --id wb_test --json`');
    expect(prompt).toContain('&lt;上次 read 的 updatedAt&gt;');
    expect(prompt).toContain('&lt;内容&gt;');
    const whiteboard = prompt.slice(
      prompt.indexOf('<whiteboard '),
      prompt.indexOf('</whiteboard>') + '</whiteboard>'.length,
    );
    const whiteboardProse = whiteboard.replace(/<\/?whiteboard(?:\s[^>]*)?>/g, '');
    expect(whiteboardProse.match(/<[^<>\r\n]+>/g) ?? []).toEqual([]);
    // The CAS flow: update carries --expected-updated-at, and a mismatch tells
    // the agent to re-read. Pin both so the prompt keeps guiding agents to CAS.
    expect(prompt).toContain('update --id wb_test --expected-updated-at');
    expect(prompt).toContain('whiteboard_cas_mismatch');
    expect(prompt).toContain('不要直接读写本地文件');
    expect(prompt).toContain('用户可见结论仍必须 `botmux send`。');
    expect(prompt).not.toContain('/whiteboards/wb_test/board.md');
    expect(prompt).not.toContain('Do not assume its contents are in context');
    expect(prompt).not.toContain('When you first create or materially update');
    // Whiteboard sits before <user_message> (a new topic has no <botmux_reminder>),
    // matching follow-up / refork ordering.
    expect(prompt.indexOf('<whiteboard ')).toBeLessThan(prompt.indexOf('<user_message>'));
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

  it.each([
    ['zh', '&lt;对方 open_id&gt;'],
    ['en', '&lt;their open_id&gt;'],
  ] as const)('escapes tag-like placeholders in the %s inline identity prose', (locale, expectedPlaceholder) => {
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
      locale,
    );
    const identity = prompt.slice(prompt.indexOf('<identity>'), prompt.indexOf('</identity>') + '</identity>'.length);
    const prose = identity.replace(/<\/?(?:identity|name|open_id|routing_rules)>/g, '');

    expect(identity).toContain(expectedPlaceholder);
    expect(prose.match(/<[^<>\r\n]+>/g) ?? []).toEqual([]);
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

describe('botmux routing prose XML boundaries', () => {
  it.each([
    ['zh', '&lt;open_id:名字&gt;'],
    ['en', '&lt;open_id:name&gt;'],
  ] as const)('escapes tag-like placeholders in %s inline shell hints while preserving heredoc syntax', (locale, mentionPlaceholder) => {
    const hints = buildBotmuxShellHints(locale).join('\n');

    expect(hints).toContain('&lt;message_id&gt;');
    expect(hints).toContain(mentionPlaceholder);
    expect(hints).toContain('&lt;whiteboard&gt;');
    expect(hints).toContain("botmux send <<'EOF'");
    expect(hints).not.toContain("botmux send &lt;&lt;'EOF'");
    expect(hints.match(/<[^<>\r\n]+>/g) ?? []).toEqual([]);
  });

  it('keeps the legacy static shell hints on the same selective-escaping boundary', () => {
    const hints = BOTMUX_SHELL_HINTS.join('\n');

    expect(hints).toContain('&lt;message_id&gt;');
    expect(hints).toContain("botmux send <<'EOF'");
    expect(hints).not.toContain("botmux send &lt;&lt;'EOF'");
    expect(hints.match(/<[^<>\r\n]+>/g) ?? []).toEqual([]);
  });

  it.each([
    ['zh', '&lt;对方 open_id&gt;'],
    ['en', '&lt;their open_id&gt;'],
  ] as const)('escapes tag-like placeholders in the %s system-prompt prose while preserving real structure and heredoc syntax', (locale, mentionPlaceholder) => {
    const prompt = buildBotmuxSystemPromptText({
      locale,
      botName: 'Codex Bot',
      botOpenId: 'ou_bot',
    });
    const prose = prompt.replace(/<\/?(?:botmux_routing|identity|name|open_id|routing_rules)>/g, '');

    expect(prompt).toContain('<botmux_routing>');
    expect(prompt).toContain('<identity>');
    expect(prompt).toContain(mentionPlaceholder);
    expect(prompt).toContain('&lt;available_bots&gt;');
    expect(prompt).toContain('&lt;whiteboard&gt;');
    expect(prompt).toContain("botmux send <<'EOF'");
    expect(prompt).not.toContain("botmux send &lt;&lt;'EOF'");
    expect(prose.match(/<[^<>\r\n]+>/g) ?? []).toEqual([]);
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

  it('includes substitute trigger metadata in follow-up prompts', () => {
    const content = buildFollowUpContent('hello', SESSION_ID, {
      sender: { openId: 'ou_sender', type: 'user', name: 'Sender' },
      mentions: [{ name: 'Alice', openId: 'ou_alice', userId: 'u_alice' }],
      substituteTrigger: {
        target: { name: 'Alice', openId: 'ou_alice', userId: 'u_alice' },
        disclosure: 'prefix',
      },
    });

    expect(content).toContain('<substitute_trigger>');
    expect(content).toContain('name="Alice"');
    expect(content).toContain('open_id="ou_alice"');
    expect(content).toContain('user_id="u_alice"');
    expect(content).toContain('<disclosure>prefix</disclosure>');
    expect(content.indexOf('<sender ')).toBeLessThan(content.indexOf('<substitute_trigger>'));
    expect(content.indexOf('<substitute_trigger>')).toBeLessThan(content.indexOf('<mentions>'));
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
    // Complex send guidance is discoverable once in the opening catalog; keep
    // every follow-up reminder intentionally tiny. By default (experimental
    // anti-resend toggle OFF) it is exactly #554's nothing-to-send sentinel
    // baseline — no anti-resend clause appended.
    expect(content).toContain('<botmux_reminder>发给你的消息至少 botmux send 回应一次,别沉默;发什么、发几条你自己判断。只有根本不是发给你的消息才让 final 只输出 BOTMUX_NOTHING_TO_SEND</botmux_reminder>');
    expect(content).not.toContain('别因「无输出」提示重发');
    expect(content).not.toContain('JSON.stringify');
    expect(content).not.toContain('botmux skill show botmux-send');
  });

  it('carries the anti-resend reminder variant when config.noVisibleOutputHint is ON', () => {
    (config as { noVisibleOutputHint?: boolean }).noVisibleOutputHint = true;
    try {
      const content = buildFollowUpContent('hello', SESSION_ID, { cliId: 'codex' });
      // ON variant must inherit #554's sentinel semantics AND add anti-resend.
      expect(content).toContain('final 只输出 BOTMUX_NOTHING_TO_SEND');
      expect(content).toMatch(/<botmux_reminder>[^<]*别因「无输出」提示重发[^<]*<\/botmux_reminder>/);
    } finally {
      delete (config as { noVisibleOutputHint?: boolean }).noVisibleOutputHint;
    }
  });

  it('gives Hermes the standard follow-up reminder like other CLIs (no reverse send guidance)', () => {
    // #365 previously steered Hermes AWAY from `botmux send` (reverse guidance)
    // as redundant belt-and-braces on top of the real dedup fix
    // (preserveMarkTimeMs). That reverse hint weakened multi-agent collaboration
    // (bridge-forwarded finals can't carry an @mention), so Hermes now shares
    // the standard path. With the anti-resend toggle OFF (default) that is
    // exactly #554's nothing-to-send sentinel baseline — same as codex/traex.
    const content = buildFollowUpContent('hello', SESSION_ID, { cliId: 'hermes' });

    expect(content).toContain('<botmux_reminder>发给你的消息至少 botmux send 回应一次,别沉默;发什么、发几条你自己判断。只有根本不是发给你的消息才让 final 只输出 BOTMUX_NOTHING_TO_SEND</botmux_reminder>');
    expect(content).not.toContain('普通文字回复不要调用 `botmux send`');
    expect(content).not.toContain('直接把给用户看的答案写在 final');
  });

  it('routes Hermes through the shared anti-resend branch when noVisibleOutputHint is ON', () => {
    // Codex-review guard for #653: prove Hermes really lands in the shared
    // noVisibleOutputHint branch (not a special-cased bypass), so the toggle
    // reaches it just like every other non-Mira CLI.
    (config as { noVisibleOutputHint?: boolean }).noVisibleOutputHint = true;
    try {
      const content = buildFollowUpContent('hello', SESSION_ID, { cliId: 'hermes' });
      expect(content).toContain('final 只输出 BOTMUX_NOTHING_TO_SEND');
      expect(content).toMatch(/<botmux_reminder>[^<]*别因「无输出」提示重发[^<]*<\/botmux_reminder>/);
    } finally {
      delete (config as { noVisibleOutputHint?: boolean }).noVisibleOutputHint;
    }
  });

  it('places the short whiteboard hint before follow-up user content', () => {
    const content = buildFollowUpContent('continue', SESSION_ID, {
      cliId: 'codex',
      whiteboardId: 'wb_follow',
    });

    expect(content).toContain('<whiteboard id="wb_follow">');
    expect(content).toContain('更新状态');
    expect(content).not.toContain('/whiteboards/wb_follow/board.md');
    expect(content).not.toContain('Local project whiteboard is enabled for durable project context');
    // Whiteboard sits after <botmux_reminder> and before <user_message>.
    expect(content.indexOf('<botmux_reminder>')).toBeLessThan(content.indexOf('<whiteboard '));
    expect(content.indexOf('<whiteboard ')).toBeLessThan(content.indexOf('<user_message>'));
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

  it('places the whiteboard hint after <botmux_reminder> and before <user_message> on re-fork', () => {
    const ds = makeDs();
    (ds.session as any).whiteboardId = 'wb_refork';
    const out = buildReforkPrompt(ds, '继续', { cliId: 'codex' });
    expect(out).toContain('<whiteboard id="wb_refork">');
    expect(out.indexOf('<botmux_reminder>')).toBeLessThan(out.indexOf('<whiteboard '));
    expect(out.indexOf('<whiteboard ')).toBeLessThan(out.indexOf('<user_message>'));
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

  it('includes and XML-escapes the optional sender email', () => {
    const out = renderSenderTag({
      openId: 'ou_email',
      type: 'user',
      name: 'Alice',
      email: 'alice&ops@example.com',
    });
    expect(out).toBe(
      '<sender type="user" open_id="ou_email" name="Alice" email="alice&amp;ops@example.com" />',
    );
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

// ─── senderTag switch — per-bot gate over the <sender> block ────────────────

describe('senderTag switch', () => {
  const sender = { openId: 'ou_gate1234567890', type: 'user' as const, name: '申晗' };

  afterEach(() => { delete mockBotConfig.senderTag; });

  it('injects the tag when senderTag is absent (default ON)', () => {
    expect(renderSenderTag(sender, 'app_test')).toContain('open_id="ou_gate1234567890"');
  });

  it('injects the tag when senderTag is explicitly true', () => {
    mockBotConfig.senderTag = true;
    expect(renderSenderTag(sender, 'app_test')).toContain('<sender ');
  });

  it('suppresses the tag when senderTag is false', () => {
    mockBotConfig.senderTag = false;
    expect(renderSenderTag(sender, 'app_test')).toBe('');
  });

  it('ignores the switch when no larkAppId is supplied (synthetic callers)', () => {
    mockBotConfig.senderTag = false;
    // Without an appId there is no bot to consult, so behavior must stay exactly
    // as it was before the switch existed.
    expect(renderSenderTag(sender)).toContain('<sender ');
  });

  it('fails OPEN when the bot cannot be read', async () => {
    const { getBot } = await import('../src/bot-registry.js');
    vi.mocked(getBot).mockImplementationOnce(() => { throw new Error('unknown bot'); });
    // A config-read failure must never silently strip per-turn attribution.
    expect(renderSenderTag(sender, 'app_test')).toContain('<sender ');
  });

  it('drops the tag from a new-topic prompt when off, keeping every other block', () => {
    mockBotConfig.senderTag = false;
    const off = buildNewTopicPrompt(
      '帮我看下', 'sess-1', 'claude-code', undefined, undefined, undefined,
      undefined, undefined, undefined, 'zh', sender, { larkAppId: 'app_test', chatId: 'oc_1' },
    );
    expect(off).not.toContain('<sender ');
    expect(off).toContain('<user_message>');

    delete mockBotConfig.senderTag;
    const on = buildNewTopicPrompt(
      '帮我看下', 'sess-1', 'claude-code', undefined, undefined, undefined,
      undefined, undefined, undefined, 'zh', sender, { larkAppId: 'app_test', chatId: 'oc_1' },
    );
    expect(on).toContain('<sender ');
    // The ONLY difference is the sender block — nothing else shifts.
    expect(on.replace(/\n*<sender [^>]*\/>/, '')).toBe(off);
  });

  it('drops the tag from a follow-up turn when off', () => {
    mockBotConfig.senderTag = false;
    const out = buildFollowUpContent('继续', 'sess-2', {
      sender, larkAppId: 'app_test', chatId: 'oc_1', cliId: 'claude-code', locale: 'zh',
    });
    expect(out).not.toContain('<sender ');
    expect(out).toContain('<user_message>');
  });

  it('drops the cursor anti-echo note together with the tag', () => {
    // The note exists only to stop cursor echoing an inline tag. With no tag
    // there is nothing to misread, so the note must go too.
    mockBotConfig.senderTag = false;
    const out = buildFollowUpContent('继续', 'sess-3', {
      sender, larkAppId: 'app_test', chatId: 'oc_1', cliId: 'cursor', locale: 'zh',
    });
    expect(out).not.toContain('<sender ');
    expect(out).not.toContain('<sender_note>');

    delete mockBotConfig.senderTag;
    const on = buildFollowUpContent('继续', 'sess-3', {
      sender, larkAppId: 'app_test', chatId: 'oc_1', cliId: 'cursor', locale: 'zh',
    });
    expect(on).toContain('<sender ');
    expect(on).toContain('<sender_note>');
  });

  it('gates the daemon buffered-follow-up path too', () => {
    mockBotConfig.senderTag = false;
    expect(renderBufferedSenderBlock(sender, 'cursor', 'zh', 'app_test')).toBe('');
    delete mockBotConfig.senderTag;
    expect(renderBufferedSenderBlock(sender, 'cursor', 'zh', 'app_test')).toContain('<sender ');
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
