import { describe, expect, it, vi } from 'vitest';
import { transferSandboxCleanupOwnership } from '../src/services/sandbox-cleanup-transfer.js';

describe('transferSandboxCleanupOwnership', () => {
  it('transfers same-tree ownership without deleting the prepared reused view', () => {
    const oldCleanup = vi.fn();
    const newCleanup = vi.fn();
    const owner = transferSandboxCleanupOwnership(oldCleanup, newCleanup, true);

    expect(oldCleanup).not.toHaveBeenCalled();
    owner();
    expect(newCleanup).toHaveBeenCalledOnce();
    expect(oldCleanup).not.toHaveBeenCalled();
  });

  it('keeps ordinary replacement behavior by retiring the old tree', () => {
    const oldCleanup = vi.fn();
    const newCleanup = vi.fn();
    const owner = transferSandboxCleanupOwnership(oldCleanup, newCleanup, false);

    expect(oldCleanup).toHaveBeenCalledOnce();
    expect(newCleanup).not.toHaveBeenCalled();
    owner();
    expect(newCleanup).toHaveBeenCalledOnce();
  });

  it('does not claim replacement ownership when old cleanup throws', () => {
    const newCleanup = vi.fn();
    expect(() => transferSandboxCleanupOwnership(() => {
      throw new Error('old cleanup failed');
    }, newCleanup, false)).toThrow('old cleanup failed');
    expect(newCleanup).not.toHaveBeenCalled();
  });
});
