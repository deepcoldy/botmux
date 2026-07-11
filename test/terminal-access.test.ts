import { describe, expect, it } from 'vitest';
import { resolveTerminalWriteAccess } from '../src/core/terminal-access.js';

describe('resolveTerminalWriteAccess', () => {
  it('allows a logged-in platform owner without a token', () => {
    expect(resolveTerminalWriteAccess('owner', false)).toEqual({
      hasWrite: true,
      platformReadonly: false,
    });
  });

  it('allows a valid private token even when the platform viewer is a guest', () => {
    expect(resolveTerminalWriteAccess('guest', true)).toEqual({
      hasWrite: true,
      platformReadonly: false,
    });
  });

  it('keeps unauthenticated platform viewers read-only without a token', () => {
    expect(resolveTerminalWriteAccess('guest', false)).toEqual({
      hasWrite: false,
      platformReadonly: true,
    });
  });

  it('keeps local token behavior unchanged', () => {
    expect(resolveTerminalWriteAccess(undefined, true).hasWrite).toBe(true);
    expect(resolveTerminalWriteAccess(undefined, false).hasWrite).toBe(false);
  });
});
