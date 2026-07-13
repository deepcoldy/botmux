import { describe, expect, it } from 'vitest';
import { docWatchCommandNeedsSession, parseDocWatchCommand } from '../src/core/doc-watch-command.js';
import { isDocNativeSession } from '../src/core/types.js';

describe('parseDocWatchCommand', () => {
  it('parses a watch with directory and all-comments mode', () => {
    expect(parseDocWatchCommand(
      '/watch-comment https://example.feishu.cn/docx/AbCdEf12345678901234 --dir /work/repo --all',
    )).toEqual({
      kind: 'watch',
      docRef: 'https://example.feishu.cn/docx/AbCdEf12345678901234',
      workingDir: '/work/repo',
      requestedMode: 'all',
    });
  });

  it('parses mentions-only mode', () => {
    expect(parseDocWatchCommand('/watch-comment AbCdEf12345678901234 --mentions-only')).toEqual({
      kind: 'watch',
      docRef: 'AbCdEf12345678901234',
      workingDir: undefined,
      requestedMode: 'mention-only',
    });
  });

  it('parses list and off (no approval subcommands — notify-not-approve model)', () => {
    expect(parseDocWatchCommand('/watch-comment list')).toEqual({ kind: 'list' });
    expect(parseDocWatchCommand('/watch-comment off')).toEqual({ kind: 'off' });
    expect(parseDocWatchCommand('/watch-comment off token123')).toEqual({ kind: 'off', docRef: 'token123' });
    expect(parseDocWatchCommand('/watch-comment off all')).toEqual({ kind: 'off' });
  });

  it('rejects missing arguments and conflicting modes', () => {
    expect(parseDocWatchCommand('/watch-comment --all')).toEqual({ kind: 'invalid', reason: 'missing_argument' });
    expect(parseDocWatchCommand('/watch-comment token123 --all --mentions-only')).toEqual({
      kind: 'invalid',
      reason: 'conflicting_modes',
    });
  });
});

describe('docWatchCommandNeedsSession', () => {
  it('prewarms only for an actual watch action', () => {
    expect(docWatchCommandNeedsSession('/watch-comment https://example.feishu.cn/docx/AbCdEf12345678901234 --all')).toBe(true);
    expect(docWatchCommandNeedsSession('/watch-comment list')).toBe(false);
    expect(docWatchCommandNeedsSession('/watch-comment off all')).toBe(false);
  });
});

describe('isDocNativeSession', () => {
  it('recognizes virtual doc comment sessions but not real Lark chats', () => {
    expect(isDocNativeSession({ scope: 'chat', chatId: 'doc:token123' })).toBe(true);
    expect(isDocNativeSession({ scope: 'chat', chatId: 'oc_real_chat' })).toBe(false);
    expect(isDocNativeSession({ scope: 'thread', chatId: 'doc:token123' })).toBe(false);
  });
});
