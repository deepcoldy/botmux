import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mockLarkGet = vi.fn();
vi.mock('../src/im/lark/lark-get.js', () => ({
  larkGet: (...args: any[]) => mockLarkGet(...args),
  larkRequestDeadline: () => undefined,
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({})),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getCachedChatMode,
  getCachedChatModeStrict,
  getChatMode,
  getChatModeStrict,
} from '../src/im/lark/client.js';

const APP = 'app_mode_cache';
const OTHER_APP = 'app_mode_cache_other';
const CHAT = 'oc_mode_cache';

describe('chat mode cache provenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    mockLarkGet.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a successful strict query as strict', async () => {
    mockLarkGet.mockResolvedValue({ code: 0, data: { chat_mode: 'group' } });
    await expect(getChatModeStrict(APP, CHAT)).resolves.toBe('group');
    expect(getCachedChatMode(APP, CHAT)).toBe('group');
    expect(getCachedChatModeStrict(APP, CHAT)).toBe('group');
  });

  it('never treats the lenient unknown→group fallback as strict', async () => {
    mockLarkGet.mockResolvedValue({ code: 500, msg: 'boom' });
    const lenientChat = 'oc_mode_cache_lenient';
    await expect(getChatMode(APP, lenientChat)).resolves.toBe('group');
    expect(getCachedChatMode(APP, lenientChat)).toBe('group');
    expect(getCachedChatModeStrict(APP, lenientChat)).toBeUndefined();
  });

  it('keeps strict provenance isolated per app for the same chat', async () => {
    mockLarkGet.mockResolvedValue({ code: 0, data: { chat_mode: 'topic' } });
    await getChatModeStrict(APP, CHAT);
    expect(getCachedChatModeStrict(APP, CHAT)).toBe('topic');
    expect(getCachedChatModeStrict(OTHER_APP, CHAT)).toBeUndefined();
  });

  it('expires strict entries after the TTL', async () => {
    mockLarkGet.mockResolvedValue({ code: 0, data: { chat_mode: 'group' } });
    await getChatModeStrict(APP, CHAT);
    expect(getCachedChatModeStrict(APP, CHAT)).toBe('group');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getCachedChatModeStrict(APP, CHAT)).toBeUndefined();
  });

  it('a failed strict query returns unknown even when an older strict cache exists', async () => {
    mockLarkGet.mockResolvedValueOnce({ code: 0, data: { chat_mode: 'group' } });
    await expect(getChatModeStrict(APP, CHAT)).resolves.toBe('group');
    mockLarkGet.mockResolvedValueOnce({ code: 500, msg: 'boom' });
    await expect(getChatModeStrict(APP, CHAT)).resolves.toBe('unknown');
  });
});
