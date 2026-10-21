/**
 * Pi's "updated while this session was running" warning and the install
 * version it is checked against.
 *
 * Run: bun x vitest run --project unit test/pi-install-change.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePiInstallUpdatedNotice, readPiInstallVersion } from '../src/adapters/cli/pi.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parsePiInstallUpdatedNotice', () => {
  it('reads both versions off the warning line Pi renders (1.1.0 and 1.3.0 share the format)', () => {
    const line = ' Warning: pi was updated to 1.3.0 while this session was running (1.1.0). Features that load code on demand can fail until restart. Restart with `pi --session 7bf18de9` to continue this session.';
    expect(parsePiInstallUpdatedNotice(line)).toEqual({ installedVersion: '1.3.0', runningVersion: '1.1.0' });
  });

  it('survives a wrap that dropped the space between words', () => {
    expect(parsePiInstallUpdatedNotice('Warning: pi was updated to 1.3.0 while this sessionwas running (1.1.0-beta.2).'))
      .toEqual({ installedVersion: '1.3.0', runningVersion: '1.1.0-beta.2' });
  });

  it('ignores the sentence quoted without Pi\'s warning prefix or without real versions', () => {
    expect(parsePiInstallUpdatedNotice('屏幕提示 "pi was updated to 1.3.0 while this session was running (1.1.0)"')).toBeUndefined();
    expect(parsePiInstallUpdatedNotice('`Warning: pi was updated to <installed> while this session was running (<running>)`')).toBeUndefined();
    expect(parsePiInstallUpdatedNotice(String.raw`/Warning:\s*pi\s*was\s*updated\s*to\s*(\d[\w.+-]*?)\s*while\s*this\s*session\s*was\s*running\s*\((\d[\w.+-]*)\)/`)).toBeUndefined();
  });
});

describe('readPiInstallVersion', () => {
  function makeInstall(version: string, name = '@earendil-works/pi-coding-agent'): { bin: string; pkg: string } {
    const root = mkdtempSync(join(tmpdir(), 'botmux-pi-install-'));
    tempDirs.push(root);
    const pkgDir = join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
    mkdirSync(join(pkgDir, 'dist', 'bundle'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
    writeFileSync(join(pkgDir, 'dist', 'bundle', 'cli.js'), '#!/usr/bin/env node\n');
    mkdirSync(join(root, 'bin'));
    const bin = join(root, 'bin', 'pi');
    symlinkSync(join(pkgDir, 'dist', 'bundle', 'cli.js'), bin);
    return { bin, pkg: join(pkgDir, 'package.json') };
  }

  it('follows the bin symlink up to the Pi package.json', () => {
    const { bin, pkg } = makeInstall('1.1.0');
    expect(readPiInstallVersion(bin)).toBe('1.1.0');
    // An upgrade rewrites the same package.json in place — the file Pi re-reads.
    writeFileSync(pkg, JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0' }));
    expect(readPiInstallVersion(bin)).toBe('1.3.0');
  });

  it('accepts the package under its older scope', () => {
    expect(readPiInstallVersion(makeInstall('0.80.6', '@mariozechner/pi-coding-agent').bin)).toBe('0.80.6');
  });

  it('is undefined for a bin that is not a Pi package (wrapper script) or does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-pi-wrapper-'));
    tempDirs.push(root);
    const wrapper = join(root, 'pi');
    writeFileSync(wrapper, '#!/bin/sh\nexec pi "$@"\n');
    expect(readPiInstallVersion(wrapper)).toBeUndefined();
    expect(readPiInstallVersion(join(root, 'missing'))).toBeUndefined();
  });
});
