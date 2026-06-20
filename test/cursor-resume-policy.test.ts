import { describe, expect, it } from 'vitest';
import {
  shouldObserveCursorChatId,
  shouldPersistObservedCursorChatId,
} from '../src/services/cursor-resume-policy.js';

describe('cursor resume policy', () => {
  it('allows fresh Cursor launches to observe and persist the created chat id', () => {
    expect(shouldObserveCursorChatId({
      cliId: 'cursor',
      effectiveResume: false,
      effectiveCliSessionId: undefined,
    })).toBe(true);
    expect(shouldPersistObservedCursorChatId({
      effectiveResume: false,
      effectiveCliSessionId: undefined,
      observedChatId: 'fresh-chat',
    })).toBe(true);
  });

  it('allows fresh-demotion to replace a stale resume id with the new chat id', () => {
    expect(shouldObserveCursorChatId({
      cliId: 'cursor',
      effectiveResume: false,
      effectiveCliSessionId: undefined,
    })).toBe(true);
    expect(shouldPersistObservedCursorChatId({
      effectiveResume: false,
      effectiveCliSessionId: 'old-chat',
      observedChatId: 'new-chat',
    })).toBe(true);
  });

  it('allows exact resume only when the observed chat id matches the resume target', () => {
    expect(shouldObserveCursorChatId({
      cliId: 'cursor',
      effectiveResume: true,
      effectiveCliSessionId: 'chat-1',
    })).toBe(true);
    expect(shouldPersistObservedCursorChatId({
      effectiveResume: true,
      effectiveCliSessionId: 'chat-1',
      observedChatId: 'chat-1',
    })).toBe(true);
    expect(shouldPersistObservedCursorChatId({
      effectiveResume: true,
      effectiveCliSessionId: 'chat-1',
      observedChatId: 'chat-2',
    })).toBe(false);
  });

  it('blocks --continue resumes from observing and persisting Cursor global latest chat', () => {
    expect(shouldObserveCursorChatId({
      cliId: 'cursor',
      effectiveResume: true,
      effectiveCliSessionId: undefined,
    })).toBe(false);
    expect(shouldPersistObservedCursorChatId({
      effectiveResume: true,
      effectiveCliSessionId: undefined,
      observedChatId: 'global-latest-chat',
    })).toBe(false);
  });

  it('does not observe non-Cursor sessions', () => {
    expect(shouldObserveCursorChatId({
      cliId: 'codex',
      effectiveResume: false,
    })).toBe(false);
  });
});
