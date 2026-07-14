import { describe, expect, it } from 'vitest';
import { CodexUpdateDialogGuard } from '../src/utils/codex-update-dialog.js';

describe('CodexUpdateDialogGuard', () => {
  it('detects the numbered Update now / Skip picker through ANSI', () => {
    const guard = new CodexUpdateDialogGuard();
    const menu = '\x1b[1;1H› 1. Update now\x1b[2;3H2. Skip';

    expect(guard.inspect(menu)).toBe('dismiss');
    expect(guard.inspect(menu)).toBe('suppress');
  });

  it('detects the newer Remind me later wording across PTY chunks', () => {
    const guard = new CodexUpdateDialogGuard();

    expect(guard.inspect('\x1b[4;3HUpdate now (runs `npm install')).toBe('pass');
    expect(guard.inspect('\x1b[5;3HRemind me later')).toBe('dismiss');
  });

  it('does not mistake the normal composer for an update picker', () => {
    const guard = new CodexUpdateDialogGuard();

    expect(guard.inspect('\x1b[10;1H›\x1b[10;3HWrite tests for @filename')).toBe('pass');
  });

  it('can be reset for a fresh CLI spawn', () => {
    const guard = new CodexUpdateDialogGuard();
    const menu = '› 1. Update now\n  2. Skip';

    expect(guard.inspect(menu)).toBe('dismiss');
    guard.reset();
    expect(guard.inspect(menu)).toBe('dismiss');
  });
});
