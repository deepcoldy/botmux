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
import { afterEach, describe, expect, it } from 'vitest';
import {
  readSecureHostFileSync,
  unlinkSecureHostFileSync,
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
