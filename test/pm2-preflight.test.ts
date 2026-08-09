import { describe, expect, it, vi } from 'vitest';
import { assertLinuxPm2GodExecutableUsable } from '../src/cli/pm2-preflight.js';

describe('PM2 deleted-Node preflight', () => {
  it('fails closed when /proc proves the God executable was deleted', () => {
    const exists = vi.fn(() => true);
    expect(() => assertLinuxPm2GodExecutableUsable(42, {
      readlink: () => '/old/node (deleted)',
      exists,
    })).toThrow(/拒绝自动清理/);
    expect(exists).not.toHaveBeenCalled();
  });

  it('fails closed when the successfully resolved executable no longer exists', () => {
    expect(() => assertLinuxPm2GodExecutableUsable(42, {
      readlink: () => '/old/node',
      exists: () => false,
    })).toThrow(/Node 二进制已失效/);
  });

  it('only skips a genuine /proc inspection failure', () => {
    expect(() => assertLinuxPm2GodExecutableUsable(42, {
      readlink: () => { throw new Error('permission denied'); },
      exists: () => false,
    })).not.toThrow();
  });
});
