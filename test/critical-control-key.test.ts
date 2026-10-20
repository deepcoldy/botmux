import { describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_CANCEL_COOLDOWN_MS,
  isCriticalInterruptKey,
  sendCriticalControlKey,
} from '../src/adapters/backend/critical-control-key.js';

describe('critical terminal control delivery', () => {
  it('classifies only interrupt keys as critical', () => {
    expect(TERMINAL_CANCEL_COOLDOWN_MS).toBeGreaterThan(500);
    expect(isCriticalInterruptKey('ctrlc')).toBe(true);
    expect(isCriticalInterruptKey('esc')).toBe(true);
    for (const key of ['enter', 'tab', 'up', 'down', 'left', 'right']) {
      expect(isCriticalInterruptKey(key)).toBe(false);
    }
  });

  it('waits past OMP double-Ctrl+C shutdown before retrying Ctrl+C', async () => {
    const sendOnce = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const wait = vi.fn(async () => {});

    await expect(sendCriticalControlKey('ctrlc', sendOnce, wait)).resolves.toBe(true);
    expect(sendOnce).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(TERMINAL_CANCEL_COOLDOWN_MS);
  });

  it('keeps Escape retry latency short', async () => {
    const sendOnce = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const wait = vi.fn(async () => {});

    await expect(sendCriticalControlKey('esc', sendOnce, wait)).resolves.toBe(true);
    expect(sendOnce).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(100);
  });

  it('fails after exactly two rejected or throwing attempts', async () => {
    const rejected = vi.fn(() => false);
    await expect(sendCriticalControlKey('ctrlc', rejected, async () => {})).resolves.toBe(false);
    expect(rejected).toHaveBeenCalledTimes(2);

    const throwing = vi.fn(() => { throw new Error('transport down'); });
    await expect(sendCriticalControlKey('esc', throwing, async () => {})).resolves.toBe(false);
    expect(throwing).toHaveBeenCalledTimes(2);
  });

  it('does not delay or retry an accepted interrupt', async () => {
    const sendOnce = vi.fn(() => undefined);
    const wait = vi.fn(async () => {});

    await expect(sendCriticalControlKey('ctrlc', sendOnce, wait)).resolves.toBe(true);
    expect(sendOnce).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});
