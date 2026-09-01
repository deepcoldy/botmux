import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  readSecureHostFileSync,
  type SecureHostParentHandle,
  unlinkSecureHostFileSync,
  withSecureHostParentSync,
  writeSecureHostFileSync,
} from '../src/platform/secure-host-file.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-secure-host-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('secure host authority files', () => {
  it('writes exact 0600 and durably reads/unlinks a regular leaf', () => {
    const file = join(tempRoot(), '.botmux', 'platform.json');
    writeSecureHostFileSync(file, '{"machineToken":"secret"}\n');
    expect(lstatSync(file).mode & 0o777).toBe(process.platform === 'win32' ? lstatSync(file).mode & 0o777 : 0o600);
    expect(readSecureHostFileSync(file)).toContain('secret');
    expect(unlinkSecureHostFileSync(file)).toBe(true);
    expect(unlinkSecureHostFileSync(file)).toBe(false);
  });

  it('rejects platform.json leaf symlinks for read, write, and unlink', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const dir = join(root, '.botmux');
    mkdirSync(dir, { mode: 0o700 });
    const target = join(root, 'target.json');
    writeFileSync(target, 'keep', { mode: 0o600 });
    const file = join(dir, 'platform.json');
    symlinkSync(target, file);

    expect(() => readSecureHostFileSync(file)).toThrow(/符号链接|发生变化/);
    expect(() => writeSecureHostFileSync(file, 'replace')).toThrow(/符号链接|发生变化/);
    expect(() => unlinkSecureHostFileSync(file)).toThrow(/符号链接|发生变化/);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('fails closed on a group-writable parent and oversized authority file', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const dir = join(root, '.botmux');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'device.json');
    writeFileSync(file, 'x'.repeat(70 * 1024), { mode: 0o600 });
    expect(() => readSecureHostFileSync(file)).toThrow(/大小异常/);

    rmSync(file);
    chmodSync(dir, 0o720);
    expect(() => writeSecureHostFileSync(file, 'secret')).toThrow(/其它用户写入|组内/);
  });

  it('pins a safe credential directory under a replaceable ancestor on Linux', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    chmodSync(root, 0o777);
    const dir = join(root, '.botmux');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'device.json');

    if (process.platform === 'linux') {
      writeSecureHostFileSync(file, 'secret');
      expect(readSecureHostFileSync(file)).toBe('secret');
      expect(unlinkSecureHostFileSync(file)).toBe(true);
      expect(readSecureHostFileSync(file)).toBeNull();
    } else {
      expect(() => writeSecureHostFileSync(file, 'secret')).toThrow(/祖先目录替换/);
    }
  });

  it('accepts an owned child under a sticky writable ancestor', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    chmodSync(root, 0o1777);
    const file = join(root, '.botmux', 'device.json');

    writeSecureHostFileSync(file, 'secret');
    expect(readSecureHostFileSync(file)).toBe('secret');
  });
});

describe('withSecureHostParentSync', () => {
  it('pins the parent for read+write and exposes no raw path capability', () => {
    const root = tempRoot();
    const file = join(root, '.botmux', '.dashboard-token');
    const result = withSecureHostParentSync(file, (parent) => {
      expect(parent.leafName).toBe('.dashboard-token');
      // The handle must NOT hand out a raw /proc/self/fd path capability.
      expect((parent as Record<string, unknown>).leafPath).toBeUndefined();
      expect((parent as Record<string, unknown>).parentPath).toBeUndefined();
      expect(parent.readLeaf()).toBeNull(); // absent leaf reads as null, not a throw
      parent.writeLeaf('tok-value');
      return parent.readLeaf();
    });
    expect(result).toBe('tok-value');
    expect(lstatSync(file).mode & 0o777).toBe(process.platform === 'win32' ? lstatSync(file).mode & 0o777 : 0o600);
    expect(readSecureHostFileSync(file)).toBe('tok-value');
  });

  it('serializes a get-or-create through withLeafLock', () => {
    const root = tempRoot();
    const file = join(root, '.botmux', '.dashboard-token');
    const token = withSecureHostParentSync(file, (parent) =>
      parent.withLeafLock(() => {
        const existing = parent.readLeaf()?.trim() || null;
        if (existing) return existing;
        parent.writeLeaf('locked-token');
        return 'locked-token';
      }),
    );
    expect(token).toBe('locked-token');
    expect(readSecureHostFileSync(file)).toBe('locked-token');
  });

  it('pins a safe credential dir under a 0777 ancestor on Linux; strict elsewhere', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    chmodSync(root, 0o777);
    const dir = join(root, '.botmux');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, '.dashboard-token');

    if (process.platform === 'linux') {
      const token = withSecureHostParentSync(file, (parent) =>
        parent.withLeafLock(() => {
          parent.writeLeaf('anchored-token');
          return parent.readLeaf();
        }),
      );
      expect(token).toBe('anchored-token');
      expect(readSecureHostFileSync(file)).toBe('anchored-token');
    } else {
      // Non-Linux keeps the conservative ancestor-chain requirement.
      expect(() => withSecureHostParentSync(file, (parent) => parent.writeLeaf('x')))
        .toThrow(/祖先目录替换/);
    }
  });

  it('refuses a leaf symlink through the pinned handle without touching its target', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const dir = join(root, '.botmux');
    mkdirSync(dir, { mode: 0o700 });
    const victim = join(root, 'victim');
    writeFileSync(victim, 'keep-me', { mode: 0o600 });
    const file = join(dir, '.dashboard-token');
    symlinkSync(victim, file);

    expect(() => withSecureHostParentSync(file, (parent) => parent.writeLeaf('replace'))).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep-me');
  });

  it('fails closed when a leaked handle is used after the call returns', () => {
    const root = tempRoot();
    const file = join(root, '.botmux', '.dashboard-token');
    // Escape the handle out of the callback (models a sync closure leak or an
    // async continuation that slipped past the compile-time NonThenable bound).
    let leaked!: SecureHostParentHandle;
    withSecureHostParentSync(file, (parent) => {
      leaked = parent;
      parent.writeLeaf('inside-token');
      return 0;
    });
    // After release the descriptor may be recycled to an unchecked directory,
    // so every capability must throw rather than touch /proc/self/fd/<fd>.
    expect(() => leaked.readLeaf()).toThrow(/句柄已释放/);
    expect(() => leaked.writeLeaf('after-release')).toThrow(/句柄已释放/);
    expect(() => leaked.withLeafLock(() => 0)).toThrow(/句柄已释放/);
    // The one legitimate in-callback write is the only mutation that landed.
    expect(readSecureHostFileSync(file)).toBe('inside-token');
  });

  it('invalidates the handle even when the callback throws', () => {
    const root = tempRoot();
    const file = join(root, '.botmux', '.dashboard-token');
    let leaked!: SecureHostParentHandle;
    expect(() => withSecureHostParentSync(file, (parent) => {
      leaked = parent;
      throw new Error('boom');
    })).toThrow('boom');
    expect(() => leaked.writeLeaf('after-throw')).toThrow(/句柄已释放/);
    expect(() => leaked.withLeafLock(() => 0)).toThrow(/句柄已释放/);
  });
});
