import { describe, expect, it, vi } from 'vitest';
import {
  HerdrWebTerminalBinding,
  type HerdrWebTerminalBackend,
  type HerdrWebTerminalSize,
} from '../src/utils/herdr-web-terminal-binding.js';

function fakeBackend(existingSize: HerdrWebTerminalSize | null = null): HerdrWebTerminalBackend {
  return {
    acquireWebTerminal: vi.fn(() => existingSize),
    resizeWebTerminal: vi.fn((_viewer, cols, rows) => ({ cols, rows })),
    releaseWebTerminal: vi.fn(() => null),
    isWebTerminalOwner: vi.fn(() => true),
  };
}

describe('Herdr web terminal worker binding', () => {
  it('rebinds an already-connected viewer after the worker replaces its backend', () => {
    const viewer = {};
    const first = fakeBackend();
    const restarted = fakeBackend();
    let current: HerdrWebTerminalBackend | null = first;
    const binding = new HerdrWebTerminalBinding(viewer, () => current);

    binding.resize(80, 24);
    expect(first.acquireWebTerminal).toHaveBeenCalledWith(viewer);
    expect(first.resizeWebTerminal).toHaveBeenCalledWith(viewer, 80, 24);

    current = restarted;
    binding.resize(150, 42);

    expect(first.releaseWebTerminal).toHaveBeenCalledWith(viewer);
    expect(restarted.acquireWebTerminal).toHaveBeenCalledWith(viewer);
    expect(restarted.resizeWebTerminal).toHaveBeenCalledWith(viewer, 150, 42);

    binding.release();
    expect(restarted.releaseWebTerminal).toHaveBeenCalledWith(viewer);
    expect(first.releaseWebTerminal).toHaveBeenCalledTimes(1);
  });

  it('restores the last browser grid after backend replacement without another resize event', () => {
    const viewer = {};
    const first = fakeBackend();
    const restarted = fakeBackend();
    let current: HerdrWebTerminalBackend | null = first;
    const binding = new HerdrWebTerminalBinding(viewer, () => current);

    binding.resize(120, 36);
    current = restarted;

    expect(binding.restore()).toEqual({
      backend: restarted,
      initialSize: null,
      size: { cols: 120, rows: 36 },
    });
    expect(first.releaseWebTerminal).toHaveBeenCalledWith(viewer);
    expect(restarted.acquireWebTerminal).toHaveBeenCalledWith(viewer);
    expect(restarted.resizeWebTerminal).toHaveBeenCalledWith(viewer, 120, 36);
  });

  it('pins a viewer to the new backend owner size when restart already has an owner', () => {
    const viewer = {};
    const first = fakeBackend();
    const restarted = fakeBackend({ cols: 120, rows: 36 });
    let current: HerdrWebTerminalBackend | null = first;
    const binding = new HerdrWebTerminalBinding(viewer, () => current);
    binding.sync();

    current = restarted;
    expect(binding.sync()).toEqual({
      backend: restarted,
      initialSize: { cols: 120, rows: 36 },
    });
  });

  it('does not double acquire or release while the backend is unchanged', () => {
    const viewer = {};
    const backend = fakeBackend();
    const binding = new HerdrWebTerminalBinding(viewer, () => backend);

    binding.sync();
    binding.sync();
    binding.release();
    binding.release();

    expect(backend.acquireWebTerminal).toHaveBeenCalledTimes(1);
    expect(backend.releaseWebTerminal).toHaveBeenCalledTimes(1);
  });
});
