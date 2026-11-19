import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeCodexProfile, scanCodexProfiles, validateCodexProfile, resolveCodexProfileHome, assertCodexProfileConfig, assertCodexProfileRuntime, type ProfileLaunch } from '../src/services/codex-profiles.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture(version = '0.134.0', help = '--profile <PROFILE>') {
  const home = mkdtempSync(join(tmpdir(), 'codex-profiles-')); dirs.push(home);
  const bin = join(home, 'codex');
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n--version) echo 'codex-cli ${version}';;\n--help) echo '${help}';;\n*) exit 91;;\nesac\n`, { mode: 0o700 });
  vi.stubEnv('CODEX_HOME', home);
  const cfg: ProfileLaunch = { cliId: 'codex', cliRuntime: { executable: bin } };
  return { home, cfg };
}
describe('Codex profiles: bounded, target-local and non-executing scan', () => {
  it('uses only independent files on 0.134+, not legacy tables or recursive directories', async () => {
    const { home, cfg } = fixture();
    writeFileSync(join(home, 'config.toml'), '[profiles.legacy]\nmodel="old"');
    writeFileSync(join(home, 'withhooks.config.toml'), 'model="configured"');
    mkdirSync(join(home, 'nested'));
    writeFileSync(join(home, 'nested', 'hidden.config.toml'), 'model="hidden"');
    expect(await scanCodexProfiles(cfg)).toMatchObject({ status: 'ok', format: 'files', version: '0.134.0', source: home, candidates: [{ name: 'withhooks', available: true }] });
    expect(await validateCodexProfile(cfg, 'withhooks')).toBe(home);
  });
  it('parses only legacy tables when the actual older CLI confirms --profile support', async () => {
    const { home, cfg } = fixture('0.133.0');
    writeFileSync(join(home, 'config.toml'), '[profiles."with-hooks"]\nmodel="x"\n[profiles.nested.tools]\nenabled=true');
    writeFileSync(join(home, 'ignored.config.toml'), 'model="x"');
    expect((await scanCodexProfiles(cfg)).candidates).toEqual([{ name: 'nested', available: true }, { name: 'with-hooks', available: true }]);
  });
  it.each([['unknown', '--profile', 'version_unknown'], ['0.134.0-custom', '--profile', 'version_unknown'], ['0.133.0', '--model', 'parameter_unsupported']])('fails closed for %s / %s', async (version, help, error) => {
    expect(await scanCodexProfiles(fixture(version, help).cfg)).toMatchObject({ status: 'unsupported', error });
  });
  it('keeps bad TOML and symlinks unavailable without exposing configuration contents', async () => {
    const { home, cfg } = fixture();
    writeFileSync(join(home, 'bad.config.toml'), 'credential="SECRET_UNTERMINATED');
    symlinkSync('/etc/passwd', join(home, 'escape.config.toml'));
    const catalog = await scanCodexProfiles(cfg);
    expect(catalog.candidates).toEqual([{ name: 'bad', available: false, error: 'invalid_toml' }, { name: 'escape', available: false, error: 'unsafe_file' }]);
    expect(JSON.stringify(catalog)).not.toContain('SECRET');
    await expect(validateCodexProfile(cfg, 'bad')).rejects.toThrow('invalid_toml');
  });
  it('revalidates removed/replaced files and bounded sizes', async () => {
    const { home, cfg } = fixture(); const path = join(home, 'chosen.config.toml');
    writeFileSync(path, 'model="x"');
    await validateCodexProfile(cfg, 'chosen');
    rmSync(path);
    await expect(validateCodexProfile(cfg, 'chosen')).rejects.toThrow('not_found');
    writeFileSync(path, 'x'.repeat(256 * 1024 + 1));
    await expect(validateCodexProfile(cfg, 'chosen')).rejects.toThrow('file_too_large');
  });
  it.each(['../secret', '/secret', 'a/b', 'a b', '-p x', 'x.config.toml', 'x\n', 'x'.repeat(129)])('rejects invalid name %j', name => {
    expect(() => normalizeCodexProfile(name)).toThrow('invalid_name');
  });
  it('distinguishes empty, missing directory and denied access', async () => {
    const { home, cfg } = fixture();
    expect((await scanCodexProfiles(cfg)).status).toBe('empty');
    expect(await scanCodexProfiles(cfg, join(home, 'missing'))).toMatchObject({ status: 'scan_failed', error: 'not_found' });
    const { chmodSync } = await import('node:fs');
    mkdirSync(join(home, 'private')); chmodSync(join(home, 'private'), 0);
    try { expect((await scanCodexProfiles(cfg, join(home, 'private'))).status).toBe('unreadable'); }
    finally { chmodSync(join(home, 'private'), 0o700); }
  });
  it('keeps deterministic per-Bot instance homes separate from daemon home', async () => {
    const { cfg, home } = fixture();
    const a = join(home, 'a'); const b = join(home, 'b'); mkdirSync(a); mkdirSync(b);
    writeFileSync(join(a, 'first.config.toml'), 'model="a"'); writeFileSync(join(b, 'second.config.toml'), 'model="b"');
    const bot = (codexHome: string): ProfileLaunch => ({ ...cfg, codexInstancePool: { enabled: false, defaultInstanceId: 'fixed', scope: 'ordinary-feishu', strategy: 'random', instances: [{ id: 'fixed', codexHome }] } });
    const [one, two] = await Promise.all([scanCodexProfiles(bot(a)), scanCodexProfiles(bot(b))]);
    expect(one.candidates.map(p => p.name)).toEqual(['first']); expect(two.candidates.map(p => p.name)).toEqual(['second']);
    await expect(validateCodexProfile(bot(b), 'first')).rejects.toThrow('not_found');
    expect(resolveCodexProfileHome(bot(a))).toBe(a);
  });
  it('rejects RPC explicitly without changing eligibility or selecting another backend', async () => {
    expect(await scanCodexProfiles({ cliId: 'codex', backendType: 'tmux', codexRpcInput: true })).toMatchObject({ status: 'unsupported', error: 'unsupported_rpc' });
  });
  it.each([{ wrapperCli: 'do-not-execute --hooks' }, { sandbox: true }, { readIsolation: true }, { codexAuthSync: 'isolated' }, { cliId: 'claude-code' }, { cliPathOverride: '/arbitrary/wrapper' }, { startupCommands: ['export CODEX_HOME=/other'] }])('refuses unsupported launch without probing %j', async overrides => {
    const catalog = await scanCodexProfiles({ cliId: 'codex', ...overrides } as ProfileLaunch);
    expect(catalog).toMatchObject({ status: 'unsupported', error: 'unsupported_launch', candidates: [] });
  });
});

describe('Codex profile gates: config layer is env-independent; runtime gate owns BOTMUX_SANDBOX', () => {
  const profileConfigText = () => JSON.stringify([{
    larkAppId: 'app', larkAppSecret: 's', cliId: 'codex', codexProfile: 'selected',
  }]);
  it.each(['unset', '', '0', '1', 'oncall', 'scratch'] as const)('parser accepts the identical profile config under BOTMUX_SANDBOX=%j', value => {
    if (value === 'unset') delete process.env.BOTMUX_SANDBOX;
    else vi.stubEnv('BOTMUX_SANDBOX', value);
    const parsed = parseBotConfigsFromText(profileConfigText());
    expect(parsed[0]!.codexProfile).toBe('selected');
  });
  it('config-layer gate never reads BOTMUX_SANDBOX even when it is force-enabled', () => {
    vi.stubEnv('BOTMUX_SANDBOX', 'oncall');
    expect(() => assertCodexProfileConfig({ cliId: 'codex' })).not.toThrow();
  });
  it('runtime gate refuses every active sandbox value before probing', async () => {
    const { cfg } = fixture();
    for (const value of ['1', 'oncall', 'scratch'] as const) {
      vi.stubEnv('BOTMUX_SANDBOX', value);
      await expect(scanCodexProfiles(cfg)).resolves.toMatchObject({ status: 'unsupported', error: 'unsupported_launch', candidates: [] });
    }
  });
  it('runtime gate allows unset and 0 (scan proceeds to the CLI probe)', async () => {
    for (const value of ['unset', '0'] as const) {
      const { cfg } = fixture();
      if (value === 'unset') delete process.env.BOTMUX_SANDBOX;
      else vi.stubEnv('BOTMUX_SANDBOX', value);
      // Empty temp CODEX_HOME: capability probes pass, status is empty (not blocked).
      await expect(scanCodexProfiles(cfg)).resolves.toMatchObject({ status: 'empty' });
    }
  });
  it('fails closed on an unrecognised BOTMUX_SANDBOX value', () => {
    vi.stubEnv('BOTMUX_SANDBOX', 'bogus');
    expect(() => assertCodexProfileRuntime({ cliId: 'codex' })).toThrow();
  });
});
