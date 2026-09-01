import { describe, expect, it } from 'bun:test';
import { detectCodexComposerState } from '../src/services/codex-composer-state.js';

describe('detectCodexComposerState', () => {
  it('detects the single-line draft that caused a Lark message to be prefixed', () => {
    const viewport = [
      '  Tip: Use /fast for faster inference.',
      '',
      '› 帮我查一下最新的 botmux 在',
      '',
      '  gpt-5.6-sol high · Context 12% used',
    ].join('\n');

    expect(detectCodexComposerState({
      viewport,
      cursor: { x: 24, y: 2 },
    })).toBe('draft');
  });

  it('treats an empty Codex placeholder as an empty composer', () => {
    const viewport = [
      '  Tip: Use /fast for faster inference.',
      '',
      '› Write tests for @filename',
      '',
      '  gpt-5.6-sol high · Context 12% used',
    ].join('\n');

    expect(detectCodexComposerState({
      viewport,
      cursor: { x: 2, y: 2 },
    })).toBe('empty');
  });

  it('detects a multi-line draft even when the cursor is on an empty continuation line', () => {
    const viewport = [
      '› LINE_ONE',
      '',
      '',
      '  gpt-5.6-sol high · Context 12% used',
    ].join('\n');

    expect(detectCodexComposerState({
      viewport,
      cursor: { x: 2, y: 1 },
    })).toBe('draft');
  });

  it('returns unknown when the current viewport does not expose a composer marker', () => {
    expect(detectCodexComposerState({
      viewport: 'Working...\nRunning command',
      cursor: { x: 0, y: 1 },
    })).toBe('unknown');
  });
});
