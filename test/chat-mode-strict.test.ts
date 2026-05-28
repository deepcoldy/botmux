/**
 * Unit tests for getChatModeStrict (client.ts) — the fail-closed chat-mode
 * resolver behind the private /card gate.
 *
 * Locks two things in particular:
 *  - p2p is detected via chat_mode==='p2p' (NOT chat_type, which is the group's
 *    public/private visibility and is undefined for DMs). Regression guard for
 *    the bug where a DM was misclassified as 'group'.
 *  - on API error / non-zero code the result is 'unknown' (never a guessed
 *    'group'), so privacy-critical callers can fail closed.
 *
 * Run:  pnpm vitest run test/chat-mode-strict.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequest = vi.fn();

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({ request: (...a: any[]) => mockRequest(...a) })),
  getAllBots: vi.fn(() => []),
  getBot: vi.fn(),
  loadBotConfigs: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { getChatModeStrict, getChatMode } from '../src/im/lark/client.js';

const ok = (data: any) => ({ code: 0, msg: 'success', data });

beforeEach(() => {
  mockRequest.mockReset();
});

describe('getChatModeStrict', () => {
  it("classifies a DM as 'p2p' via chat_mode (chat_type is undefined for DMs)", async () => {
    mockRequest.mockResolvedValueOnce(ok({ chat_mode: 'p2p', chat_type: undefined, group_message_type: undefined }));
    expect(await getChatModeStrict('app', 'oc_dm')).toBe('p2p');
  });

  it("classifies a flat private group as 'group'", async () => {
    mockRequest.mockResolvedValueOnce(ok({ chat_mode: 'group', chat_type: 'private', group_message_type: 'chat' }));
    expect(await getChatModeStrict('app', 'oc_g')).toBe('group');
  });

  it("classifies a thread-toggled group (group_message_type='thread') as 'topic'", async () => {
    mockRequest.mockResolvedValueOnce(ok({ chat_mode: 'group', chat_type: 'private', group_message_type: 'thread' }));
    expect(await getChatModeStrict('app', 'oc_t')).toBe('topic');
  });

  it("classifies a legacy chat_mode='topic' group as 'topic'", async () => {
    mockRequest.mockResolvedValueOnce(ok({ chat_mode: 'topic', group_message_type: undefined }));
    expect(await getChatModeStrict('app', 'oc_legacy')).toBe('topic');
  });

  it("does NOT misclassify a DM as 'group' (regression: chat_type was wrongly checked for 'p2p')", async () => {
    mockRequest.mockResolvedValueOnce(ok({ chat_mode: 'p2p', chat_type: undefined }));
    expect(await getChatModeStrict('app', 'oc_dm2')).not.toBe('group');
  });

  it("returns 'unknown' for an empty response body (can't confirm → fail closed)", async () => {
    mockRequest.mockResolvedValueOnce(ok({}));
    expect(await getChatModeStrict('app', 'oc_empty')).toBe('unknown');
  });

  it("returns 'unknown' for an unrecognized chat_mode (future enum value)", async () => {
    mockRequest.mockResolvedValueOnce(ok({ chat_mode: 'super_secret_mode' }));
    expect(await getChatModeStrict('app', 'oc_future')).toBe('unknown');
  });

  it("returns 'unknown' on a non-zero API code (no 'group' fallback)", async () => {
    mockRequest.mockResolvedValueOnce({ code: 99991663, msg: 'rate limited', data: null });
    expect(await getChatModeStrict('app', 'oc_err')).toBe('unknown');
  });

  it("returns 'unknown' when the API call throws", async () => {
    mockRequest.mockRejectedValueOnce(new Error('network down'));
    expect(await getChatModeStrict('app', 'oc_throw')).toBe('unknown');
  });
});

describe('getChatMode (lenient) — routing unaffected by the strict change', () => {
  it("still maps an unconfirmable chat (empty body → strict 'unknown') to 'group'", async () => {
    mockRequest.mockResolvedValueOnce(ok({}));
    // fresh chatId to avoid the module-level cache
    expect(await getChatMode('app', 'oc_lenient_empty')).toBe('group');
  });
});
