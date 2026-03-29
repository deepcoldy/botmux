/**
 * Unit tests for prompt building functions: buildNewTopicPrompt, buildFollowUpContent.
 *
 * Covers:
 *   1. buildNewTopicPrompt always includes Session ID (used in normal mode)
 *   2. buildFollowUpContent includes Session ID in normal mode
 *   3. buildFollowUpContent omits Session ID in adopt mode (no MCP)
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

  it('should include Session ID in the prompt', () => {
    const prompt = buildNewTopicPrompt('hello', SESSION_ID, 'claude-code');
    expect(prompt).toContain(`Session ID: ${SESSION_ID}`);
  });

  it('should include the user message', () => {
    const prompt = buildNewTopicPrompt('请帮我看一下这个 bug', SESSION_ID, 'claude-code');
    expect(prompt).toContain('请帮我看一下这个 bug');
  });

  it('should include follow-up messages when provided', () => {
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
    expect(prompt).toContain('用户追加了：\n---\nsecond message\n---');
    expect(prompt).toContain('用户追加了：\n---\nthird message\n---');
  });

  it('should include mention metadata when provided', () => {
    const prompt = buildNewTopicPrompt(
      'hello',
      SESSION_ID,
      'claude-code',
      undefined,
      undefined,
      [{ name: 'Alice', openId: 'ou_alice' }],
    );
    expect(prompt).toContain('@Alice');
    expect(prompt).toContain('ou_alice');
  });
});

describe('buildFollowUpContent', () => {
  const SESSION_ID = 'follow-up-session-456';

  it('should include Session ID in normal mode', () => {
    const content = buildFollowUpContent('hello', SESSION_ID);
    expect(content).toContain(`Session ID: ${SESSION_ID}`);
  });

  it('should include Session ID when isAdoptMode is false', () => {
    const content = buildFollowUpContent('hello', SESSION_ID, { isAdoptMode: false });
    expect(content).toContain(`Session ID: ${SESSION_ID}`);
  });

  it('should omit Session ID in adopt mode', () => {
    const content = buildFollowUpContent('hello', SESSION_ID, { isAdoptMode: true });
    expect(content).not.toContain('Session ID');
  });

  it('should include user content in all modes', () => {
    const normalContent = buildFollowUpContent('请修复这个问题', SESSION_ID);
    const adoptContent = buildFollowUpContent('请修复这个问题', SESSION_ID, { isAdoptMode: true });

    expect(normalContent).toContain('请修复这个问题');
    expect(adoptContent).toContain('请修复这个问题');
  });

  it('should include attachment hints when provided', () => {
    const attachments = [{ type: 'image' as const, path: '/tmp/img.jpg', name: 'img.jpg' }];
    const content = buildFollowUpContent('看这个图', SESSION_ID, { attachments });
    expect(content).toContain('附件');
    expect(content).toContain('/tmp/img.jpg');
  });

  it('should include mention metadata when provided', () => {
    const mentions = [{ name: 'Bob', openId: 'ou_bob' }];
    const content = buildFollowUpContent('hello', SESSION_ID, { mentions });
    expect(content).toContain('@Bob');
    expect(content).toContain('ou_bob');
  });

  it('should omit Session ID but keep mentions in adopt mode', () => {
    const mentions = [{ name: 'Charlie', openId: 'ou_charlie' }];
    const content = buildFollowUpContent('hello', SESSION_ID, {
      isAdoptMode: true,
      mentions,
    });
    expect(content).not.toContain('Session ID');
    expect(content).toContain('@Charlie');
    expect(content).toContain('ou_charlie');
  });

  it('should omit Session ID but keep attachments in adopt mode', () => {
    const attachments = [{ type: 'image' as const, path: '/tmp/img.jpg', name: 'img.jpg' }];
    const content = buildFollowUpContent('看图', SESSION_ID, {
      isAdoptMode: true,
      attachments,
    });
    expect(content).not.toContain('Session ID');
    expect(content).toContain('/tmp/img.jpg');
  });
});
