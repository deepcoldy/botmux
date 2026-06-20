/**
 * Tests for `findInheritablePeer` — the helper that decides whether a newly
 * created session can reuse a sibling's workingDir (and skip the repo card).
 *
 * Run:  pnpm vitest run test/inherit-peer.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFindByRoot = vi.fn();
const mockFindByChat = vi.fn();
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock('../src/services/session-store.js', () => ({
  findActiveSessionsByRoot: (...args: unknown[]) => mockFindByRoot(...args),
  findActiveChatScopeSessionsByChat: (...args: unknown[]) => mockFindByChat(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { warn: mockLoggerWarn },
}));

import { findInheritablePeer } from '../src/core/inherit-peer.js';

function makePeer(overrides: Partial<{ sessionId: string; rootMessageId: string; chatId: string; scope: 'thread' | 'chat'; workingDir: string; larkAppId: string }>): any {
  return {
    sessionId: overrides.sessionId ?? 's-1',
    rootMessageId: overrides.rootMessageId ?? 'om_root',
    chatId: overrides.chatId ?? 'oc_chat',
    scope: overrides.scope ?? 'thread',
    workingDir: overrides.workingDir,
    larkAppId: overrides.larkAppId ?? 'app-other',
  };
}

let tmpRoot = '';

function tempDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), 'botmux-inherit-peer-'));
  mockFindByRoot.mockReturnValue([]);
  mockFindByChat.mockReturnValue([]);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('findInheritablePeer — layer 1 (cross-bot same-anchor)', () => {
  it('returns a thread-scope peer pinned at the same root by another bot', () => {
    const workingDir = tempDir('repo-a');
    mockFindByRoot.mockReturnValue([
      makePeer({ sessionId: 'peer-1', rootMessageId: 'om_root', workingDir, larkAppId: 'app-other' }),
    ]);
    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });
    expect(result).toEqual({ sessionId: 'peer-1', larkAppId: 'app-other', workingDir });
  });

  it('skips peer that belongs to the same bot (would be self-inherit)', () => {
    mockFindByRoot.mockReturnValue([
      makePeer({ sessionId: 'self-peer', rootMessageId: 'om_root', workingDir: '/repo/a', larkAppId: 'app-self' }),
    ]);
    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });
    expect(result).toBeNull();
  });

  it('returns chat-scope peer pinned at the same chat by another bot', () => {
    const workingDir = tempDir('repo-b');
    mockFindByChat.mockReturnValue([
      makePeer({ sessionId: 'peer-2', chatId: 'oc_chat', scope: 'chat', workingDir, larkAppId: 'app-other' }),
    ]);
    const result = findInheritablePeer({
      scope: 'chat',
      anchor: 'oc_chat',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });
    expect(result).toEqual({ sessionId: 'peer-2', larkAppId: 'app-other', workingDir });
  });

  it('skips a stale same-anchor peer workingDir and inherits the next valid peer', () => {
    const missingDir = join(tmpRoot, 'missing-repo');
    const validDir = tempDir('repo-c');
    mockFindByRoot.mockReturnValue([
      makePeer({ sessionId: 'stale-peer', rootMessageId: 'om_root', workingDir: missingDir, larkAppId: 'app-other' }),
      makePeer({ sessionId: 'valid-peer', rootMessageId: 'om_root', workingDir: validDir, larkAppId: 'app-third' }),
    ]);

    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });

    expect(result).toEqual({ sessionId: 'valid-peer', larkAppId: 'app-third', workingDir: validDir });
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('ignored inherited peer workingDir'));
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining(missingDir));
  });

  it('returns null and logs when every same-anchor peer workingDir is invalid', () => {
    const filePath = join(tmpRoot, 'not-a-directory');
    writeFileSync(filePath, 'not a directory', 'utf-8');
    mockFindByRoot.mockReturnValue([
      makePeer({ sessionId: 'file-peer', rootMessageId: 'om_root', workingDir: filePath, larkAppId: 'app-other' }),
    ]);

    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });

    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('ignored inherited peer workingDir'));
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining(filePath));
  });
});

describe('findInheritablePeer — layer 2 removed (普通群 new thread no longer inherits chat-scope)', () => {
  it('returns null when scope=thread + chatType=group + only sibling is a chat-scope session', () => {
    // Layer 1: no same-anchor peer.
    mockFindByRoot.mockReturnValue([]);
    // Layer 2 used to fall through to chat-scope siblings — must NOT anymore.
    mockFindByChat.mockReturnValue([
      makePeer({ sessionId: 'chat-peer', chatId: 'oc_chat', scope: 'chat', workingDir: '/repo/outer', larkAppId: 'app-self' }),
    ]);
    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_new_thread',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });
    expect(result).toBeNull();
  });

  it('still returns null when chat-scope peer belongs to another bot (no same-anchor peer)', () => {
    mockFindByRoot.mockReturnValue([]);
    mockFindByChat.mockReturnValue([
      makePeer({ sessionId: 'chat-peer-other-bot', chatId: 'oc_chat', scope: 'chat', workingDir: '/repo/outer', larkAppId: 'app-other' }),
    ]);
    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_new_thread',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });
    expect(result).toBeNull();
  });
});

describe('findInheritablePeer — guards', () => {
  it('returns null when no peer has a workingDir set', () => {
    mockFindByRoot.mockReturnValue([
      makePeer({ sessionId: 'peer-no-dir', rootMessageId: 'om_root', workingDir: undefined, larkAppId: 'app-other' }),
    ]);
    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      selfAppId: 'app-self',
    });
    expect(result).toBeNull();
  });

  it('returns null in p2p when no same-anchor peer exists', () => {
    mockFindByRoot.mockReturnValue([]);
    mockFindByChat.mockReturnValue([]);
    const result = findInheritablePeer({
      scope: 'thread',
      anchor: 'om_dm',
      chatId: 'oc_p2p',
      chatType: 'p2p',
      selfAppId: 'app-self',
    });
    expect(result).toBeNull();
  });
});
