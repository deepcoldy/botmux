import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLarkTestCli } from './helpers/lark-test-cli.js';

describe('real CLI contract executable selection', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function root() { const path = mkdtempSync(join(tmpdir(), 'lark-executable-')); roots.push(path); return path; }
  function native(path: string) { writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]), { mode: 0o700 }); return path; }

  it('uses the explicit native executable when PATH selects an identity wrapper', () => {
    const dir = root(); const binary = native(join(dir, 'native-cli'));
    writeFileSync(join(dir, 'lark-cli'), '#!/bin/sh\nexit 77\n', { mode: 0o700 });
    expect(resolveLarkTestCli({ PATH: dir, BOTMUX_TEST_LARK_CLI: binary })).toBe(realpathSync(binary));
  });
  it('rejects an explicitly configured wrapper rather than falling back to PATH', () => {
    const dir = root(); const wrapper = join(dir, 'wrapper');
    writeFileSync(wrapper, '#!/bin/sh\nexit 77\n', { mode: 0o700 }); native(join(dir, 'lark-cli'));
    const resolve = resolveLarkTestCli;
    expect(() => resolve({ PATH: dir, BOTMUX_TEST_LARK_CLI: wrapper })).toThrow(/native executable/);
  });
  it('rejects missing and nonexecutable explicit paths', () => {
    const dir = root(); const resolve = resolveLarkTestCli;
    expect(() => resolve({ BOTMUX_TEST_LARK_CLI: join(dir, 'missing') })).toThrow();
    const binary = native(join(dir, 'native-cli')); chmodSync(binary, 0o600);
    expect(() => resolve({ BOTMUX_TEST_LARK_CLI: binary })).toThrow();
  });
  it('rejects a PATH symlink pointing at an identity wrapper', () => {
    const dir = root(); const wrapper = join(dir, 'wrapper');
    writeFileSync(wrapper, '#!/bin/sh\nexit 77\n', { mode: 0o700 }); symlinkSync(wrapper, join(dir, 'lark-cli'));
    const resolve = resolveLarkTestCli;
    expect(() => resolve({ PATH: dir })).toThrow(/native executable/);
  });
  it('fails rather than skipping when the maintenance contract is required', () => {
    const resolve = resolveLarkTestCli;
    expect(() => resolve({ PATH: '', BOTMUX_TEST_REQUIRE_LARK_CLI: '1' })).toThrow(/required/);
    expect(resolve({ PATH: '' })).toBeNull();
  });
  it('rejects a native executable whose bytes changed after preflight', () => {
    const dir = root(); const binary = native(join(dir, 'native-cli')); const resolve = resolveLarkTestCli;
    expect(() => resolve({ BOTMUX_TEST_LARK_CLI: binary, BOTMUX_TEST_LARK_CLI_SHA256: '0'.repeat(64) })).toThrow(/changed/);
  });
});
