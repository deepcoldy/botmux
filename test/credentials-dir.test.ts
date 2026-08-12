/**
 * credentials-dir 解析单测：env 优先 > breadcrumb > ~/.botmux fallback，
 * 非法相对路径 fail-closed，breadcrumb 写入幂等。
 *
 * Run:  pnpm vitest run test/credentials-dir.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveCredentialsDir,
  persistCredentialsDirBreadcrumb,
} from '../src/core/credentials-dir.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'creds-dir-unit-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeHome(): string {
  const home = join(tmpRoot, 'home');
  mkdirSync(join(home, '.botmux'), { recursive: true });
  return home;
}

describe('resolveCredentialsDir', () => {
  it('defaults to ~/.botmux when nothing is configured', () => {
    const home = makeHome();
    expect(resolveCredentialsDir({ env: {}, homeDir: home })).toBe(join(home, '.botmux'));
  });

  it('prefers BOTMUX_CREDENTIALS_DIR (absolute)', () => {
    const home = makeHome();
    const dir = join(tmpRoot, 'creds');
    mkdirSync(dir, { recursive: true });
    expect(resolveCredentialsDir({ env: { BOTMUX_CREDENTIALS_DIR: dir }, homeDir: home })).toBe(dir);
  });

  it('rejects a relative BOTMUX_CREDENTIALS_DIR (fail closed)', () => {
    const home = makeHome();
    expect(() => resolveCredentialsDir({ env: { BOTMUX_CREDENTIALS_DIR: 'rel/creds' }, homeDir: home }))
      .toThrow(/绝对路径/);
  });

  it('follows a valid breadcrumb written by the daemon', () => {
    const home = makeHome();
    const dir = join(tmpRoot, 'creds');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, '.botmux', '.credentials-dir'), dir, 'utf8');
    expect(resolveCredentialsDir({ env: {}, homeDir: home })).toBe(dir);
  });

  it('ignores a breadcrumb pointing at a missing directory (falls back)', () => {
    const home = makeHome();
    writeFileSync(join(home, '.botmux', '.credentials-dir'), join(tmpRoot, 'gone'), 'utf8');
    expect(resolveCredentialsDir({ env: {}, homeDir: home })).toBe(join(home, '.botmux'));
  });

  it('ignores a relative breadcrumb (never guesses)', () => {
    const home = makeHome();
    writeFileSync(join(home, '.botmux', '.credentials-dir'), 'rel/creds', 'utf8');
    expect(resolveCredentialsDir({ env: {}, homeDir: home })).toBe(join(home, '.botmux'));
  });

  it('ignores a symlink breadcrumb', () => {
    const home = makeHome();
    const dir = join(tmpRoot, 'creds');
    mkdirSync(dir, { recursive: true });
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(dir, join(home, '.botmux', '.credentials-dir'));
    expect(resolveCredentialsDir({ env: {}, homeDir: home })).toBe(join(home, '.botmux'));
  });

  it('env beats a stale breadcrumb', () => {
    const home = makeHome();
    const stale = join(tmpRoot, 'stale');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(home, '.botmux', '.credentials-dir'), stale, 'utf8');
    const dir = join(tmpRoot, 'creds');
    mkdirSync(dir, { recursive: true });
    expect(resolveCredentialsDir({ env: { BOTMUX_CREDENTIALS_DIR: dir }, homeDir: home })).toBe(dir);
  });
});

describe('persistCredentialsDirBreadcrumb', () => {
  it('writes the credential root next to .data-dir', () => {
    const home = makeHome();
    const dir = join(tmpRoot, 'creds');
    persistCredentialsDirBreadcrumb(dir, { homeDir: home });
    expect(readFileSync(join(home, '.botmux', '.credentials-dir'), 'utf8')).toBe(dir);
  });

  it('creates ~/.botmux when absent', () => {
    const home = join(tmpRoot, 'fresh-home');
    const dir = join(tmpRoot, 'creds');
    mkdirSync(dir, { recursive: true });
    persistCredentialsDirBreadcrumb(dir, { homeDir: home });
    expect(resolveCredentialsDir({ env: {}, homeDir: home })).toBe(dir);
  });
});
