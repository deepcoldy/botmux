import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveBotmuxVersion } from '../src/utils/version-info.js';

describe('version info', () => {
  it('caches git describe fallback per install root', () => {
    const root = `/tmp/botmux-version-cache-hit-${process.pid}-${Date.now()}`;
    const execFileSync = vi.fn(() => 'v2.95.0\n');

    expect(resolveEffectiveBotmuxVersion({ rawVersion: '0.0.0', rootDir: root, execFileSync })).toBe('2.95.0');
    expect(resolveEffectiveBotmuxVersion({ rawVersion: '0.0.0', rootDir: root, execFileSync })).toBe('2.95.0');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('caches git describe misses so probes stay cheap', () => {
    const root = `/tmp/botmux-version-cache-miss-${process.pid}-${Date.now()}`;
    const execFileSync = vi.fn(() => {
      throw new Error('not a git checkout');
    });

    expect(resolveEffectiveBotmuxVersion({ rawVersion: '0.0.0', rootDir: root, execFileSync })).toBe('0.0.0');
    expect(resolveEffectiveBotmuxVersion({ rawVersion: '0.0.0', rootDir: root, execFileSync })).toBe('0.0.0');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
