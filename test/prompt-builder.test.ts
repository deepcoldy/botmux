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

import { buildNewTopicPrompt, buildFollowUpContent } from '../src/core/session-manager.js';

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

  it('should include follow-up messages wrapped in <follow_up_message>', () => {
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
    expect(prompt).toContain('<follow_up_message>\nsecond message\n</follow_up_message>');
    expect(prompt).toContain('<follow_up_message>\nthird message\n</follow_up_message>');
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
});
