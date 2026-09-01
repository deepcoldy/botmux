import { describe, expect, it } from 'bun:test';
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

  it('resume without a cliSessionId observes and persists (adapter starts fresh, no --continue)', () => {
    // The adapter no longer falls back to --continue (a cross-session leak
    // hazard), so resume=true without a cliSessionId is effectively a FRESH
    // launch. Observing captures the new chat id that would otherwise stay
    // uncaptured — the old policy blocked it for the --continue era.
    expect(shouldObserveCursorChatId({
      cliId: 'cursor',
      effectiveResume: true,
      effectiveCliSessionId: undefined,
    })).toBe(true);
    expect(shouldPersistObservedCursorChatId({
      effectiveResume: true,
      effectiveCliSessionId: undefined,
      observedChatId: 'freshly-minted-chat',
    })).toBe(true);
  });

  it('does not observe non-Cursor sessions', () => {
    expect(shouldObserveCursorChatId({
      cliId: 'codex',
      effectiveResume: false,
    })).toBe(false);
  });
});
