import { describe, it, expect } from 'vitest';
import { getCliDisplayName } from '../cli-display.js';

describe('getCliDisplayName', () => {
  it('returns "Claude" for claude-code', () => {
    expect(getCliDisplayName('claude-code')).toBe('Claude');
  });

  it('returns "Aiden" for aiden', () => {
    expect(getCliDisplayName('aiden')).toBe('Aiden');
  });

  it('returns "CoCo" for coco', () => {
    expect(getCliDisplayName('coco')).toBe('CoCo');
  });

  it('returns "Codex" for codex', () => {
    expect(getCliDisplayName('codex')).toBe('Codex');
  });

  it('returns "Gemini" for gemini', () => {
    expect(getCliDisplayName('gemini')).toBe('Gemini');
  });

  it('returns "OpenCode" for opencode', () => {
    expect(getCliDisplayName('opencode')).toBe('OpenCode');
  });

  it('returns the ID itself for unknown CLI IDs', () => {
    expect(getCliDisplayName('some-unknown-cli')).toBe('some-unknown-cli');
  });
});
