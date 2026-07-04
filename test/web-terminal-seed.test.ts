import { describe, it, expect, vi } from 'vitest';
import { chooseWebTerminalSeed } from '../src/utils/web-terminal-seed.js';

describe('chooseWebTerminalSeed', () => {
  it('uses the tmux capture when capture is available and non-empty', () => {
    const seed = chooseWebTerminalSeed({
      canCapture: true,
      capture: () => 'CAPTURE-SNAPSHOT',
      scrollback: 'RAW-SCROLLBACK',
    });
    expect(seed).toBe('CAPTURE-SNAPSHOT');
  });

  it('falls back to raw scrollback when no capture is available (PtyBackend)', () => {
    const capture = vi.fn(() => 'CAPTURE-SNAPSHOT');
    const seed = chooseWebTerminalSeed({
      canCapture: false,
      capture,
      scrollback: 'RAW-SCROLLBACK',
    });
    expect(seed).toBe('RAW-SCROLLBACK');
    expect(capture).not.toHaveBeenCalled(); // don't pay for a capture we won't use
  });

  it('falls back to raw scrollback when the capture comes back empty (tmux hiccup)', () => {
    const seed = chooseWebTerminalSeed({
      canCapture: true,
      capture: () => '',
      scrollback: 'RAW-SCROLLBACK',
    });
    expect(seed).toBe('RAW-SCROLLBACK');
  });

  it('falls back to raw scrollback and reports when the capture throws', () => {
    const onError = vi.fn();
    const seed = chooseWebTerminalSeed({
      canCapture: true,
      capture: () => { throw new Error('pane gone'); },
      scrollback: 'RAW-SCROLLBACK',
      onError,
    });
    expect(seed).toBe('RAW-SCROLLBACK');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toContain('pane gone');
  });
});
