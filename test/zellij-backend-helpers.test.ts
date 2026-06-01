import { describe, it, expect } from 'vitest';
import {
  tmuxKeyToBytes,
  kdlString,
  buildLayoutString,
  ZELLIJ_CONFIG_KDL,
} from '../src/adapters/backend/zellij-backend.js';
import {
  parseZellijVersion,
  isZellijVersionSupported,
} from '../src/setup/ensure-zellij.js';

describe('tmuxKeyToBytes', () => {
  it('maps named keys to terminal byte sequences', () => {
    expect(tmuxKeyToBytes('Enter')).toBe('\r');
    expect(tmuxKeyToBytes('Escape')).toBe('\x1b');
    expect(tmuxKeyToBytes('Tab')).toBe('\t');
    expect(tmuxKeyToBytes('BSpace')).toBe('\x7f');
    expect(tmuxKeyToBytes('Up')).toBe('\x1b[A');
    expect(tmuxKeyToBytes('M-Enter')).toBe('\x1b\r');
  });

  it('maps C-<x> control combos to control bytes', () => {
    expect(tmuxKeyToBytes('C-c')).toBe('\x03');
    expect(tmuxKeyToBytes('C-d')).toBe('\x04');
    expect(tmuxKeyToBytes('C-a')).toBe('\x01');
  });

  it('maps M-<x> meta combos to ESC-prefixed bytes', () => {
    expect(tmuxKeyToBytes('M-b')).toBe('\x1bb');
  });

  it('falls back to the literal string for unknown keys (no dropped input)', () => {
    expect(tmuxKeyToBytes('weird')).toBe('weird');
  });
});

describe('kdlString', () => {
  it('escapes backslashes and quotes', () => {
    expect(kdlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('buildLayoutString', () => {
  it('produces a single command pane with close_on_exit and the CLI args', () => {
    const kdl = buildLayoutString('claude', ['--resume', 'abc'], {
      cwd: '/work/dir',
      cols: 120,
      rows: 40,
      env: {},
    });
    expect(kdl).toContain('layout {');
    expect(kdl).toContain('close_on_exit=true');
    // cwd is passed as a wrapper-script arg (execvp semantics, KDL-quoted).
    expect(kdl).toContain('"/work/dir"');
    expect(kdl).toContain('"claude"');
    expect(kdl).toContain('"--resume"');
    expect(kdl).toContain('"abc"');
  });
});

describe('ZELLIJ_CONFIG_KDL', () => {
  it('locks input and clears keybinds so pty.write passes straight through', () => {
    expect(ZELLIJ_CONFIG_KDL).toContain('default_mode "locked"');
    expect(ZELLIJ_CONFIG_KDL).toContain('clear-defaults=true');
  });
});

describe('zellij version gate', () => {
  it('parses versions', () => {
    expect(parseZellijVersion('zellij 0.44.1')).toEqual({ major: 0, minor: 44, patch: 1 });
    expect(parseZellijVersion('garbage')).toBeUndefined();
  });

  it('requires >= 0.44.0', () => {
    expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 1 })).toBe(true);
    expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 0 })).toBe(true);
    expect(isZellijVersionSupported({ major: 0, minor: 43, patch: 9 })).toBe(false);
    expect(isZellijVersionSupported({ major: 0, minor: 45, patch: 0 })).toBe(true);
    expect(isZellijVersionSupported({ major: 1, minor: 0, patch: 0 })).toBe(true);
  });
});
