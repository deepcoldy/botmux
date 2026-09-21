import { describe, expect, it } from 'vitest';
import {
  scratchHostView,
  remapIntoMerged,
} from '../src/adapters/backend/scratch-sandbox.js';
import {
  scratchMergedRootFor,
  scratchViewPath,
  registerScratchView,
  registeredScratchView,
  clearScratchView,
} from '../src/services/scratch-host-view.js';

describe('scratch host-view path mapping', () => {
  const merged = '/var/lib/botmux/data/sandboxes/sid-1/root';

  it('prefixes an absolute host path with the merged root', () => {
    expect(scratchHostView(merged, '/root/.codex/x.jsonl'))
      .toBe(`${merged}/root/.codex/x.jsonl`);
    expect(scratchHostView(merged, '/etc/hostname')).toBe(`${merged}/etc/hostname`);
  });

  it('rejects relative input', () => {
    expect(() => scratchHostView(merged, 'etc/hostname')).toThrow(/absolute path/);
  });

  it('keeps the back-compat alias identical', () => {
    expect(remapIntoMerged(merged, '/root/x')).toBe(scratchHostView(merged, '/root/x'));
  });

  it('derives the merged root deterministically from dataDir + sid', () => {
    expect(scratchMergedRootFor('/data', 'sid'))
      .toBe('/data/sandboxes/sid/root');
  });

  it('returns the input unchanged without a merged root (non-scratch sessions)', () => {
    expect(scratchViewPath(undefined, '/root/x')).toBe('/root/x');
    expect(scratchViewPath('/m', 'rel')).toBe('rel');
  });

  it('maps through a given merged root', () => {
    expect(scratchViewPath('/m', '/root/x')).toBe('/m/root/x');
  });

  it('tracks the per-session live view registry', () => {
    expect(registeredScratchView('sid-reg')).toBeUndefined();
    registerScratchView('sid-reg', '/m/root');
    expect(registeredScratchView('sid-reg')).toBe('/m/root');
    registerScratchView('sid-reg', undefined); // no-op on undefined
    expect(registeredScratchView('sid-reg')).toBe('/m/root');
    clearScratchView('sid-reg');
    expect(registeredScratchView('sid-reg')).toBeUndefined();
  });
});
