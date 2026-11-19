/** Isolated Codex title home: provider wiring only, fail closed on anything odd. */
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  provisionIsolatedTitleConfig,
  resolveSourceCodexHome,
  TITLE_CONFIG_INHERITED_KEYS,
} from '../src/services/codex-title-config.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Source CODEX_HOME + a throwaway target home. */
function homes(config?: string): { source: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-title-config-'));
  dirs.push(dir);
  const source = join(dir, 'source');
  const target = join(dir, 'target');
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  if (config !== undefined) writeFileSync(join(source, 'config.toml'), config);
  return { source, target };
}

describe('provisionIsolatedTitleConfig', () => {
  it('copies only model / model_provider / model_providers from a full user config', () => {
    const { source, target } = homes([
      'model = "house-model-1"',
      'model_reasoning_effort = "xhigh"',
      'model_provider = "housegw"',
      'approvals_reviewer = "user"',
      'notify = ["echo"]',
      'developer_instructions = "ignored"',
      '',
      '[projects."/root/secret"]',
      'trust_level = "trusted"',
      '',
      '[mcp_servers.dangerous]',
      'command = "false"',
      '',
      '[profiles.fast]',
      'model = "other"',
      '',
      '[model_providers.housegw]',
      'base_url = "https://gw.example/v1"',
      'wire_api = "responses"',
      'env_key = "HOUSE_API_KEY"',
      '',
      '[model_providers.housegw.http_headers]',
      '"x-gw-key" = "inline-secret"',
      '',
      '[features]',
      'hooks = true',
    ].join('\n'));

    const result = provisionIsolatedTitleConfig(source, target);

    expect(result).toEqual({ ok: true, inherited: ['model', 'model_provider', 'model_providers'] });
    const written = readFileSync(join(target, 'config.toml'), 'utf8');
    // Nothing outside the whitelist survives serialization — in particular the
    // user payload (hooks/projects/mcp/features) and the pinned-low reasoning.
    for (const forbidden of ['hooks', 'projects', 'mcp_servers', 'features', 'trust_level',
      'model_reasoning_effort', 'developer_instructions', 'notify']) {
      expect(written, `must not inherit ${forbidden}`).not.toContain(forbidden);
    }
    expect(written).toContain('housegw');
    expect(written).toContain('https://gw.example/v1');
    expect(written).toContain('HOUSE_API_KEY');
    expect(written).toContain('inline-secret');
    // Keep the exported list and the behaviour in lock-step.
    expect([...TITLE_CONFIG_INHERITED_KEYS]).toEqual(['model', 'model_provider', 'model_providers']);
    // The inherited table may carry inline http_headers credentials, so it gets
    // the same owner-only mode as the copied auth.json (defence in depth on top
    // of the 0700 scratch home).
    expect(statSync(join(target, 'config.toml')).mode & 0o777).toBe(0o600);
  });

  it('writes nothing when the source home has no config.toml', () => {
    const { source, target } = homes();
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: true, inherited: [] });
    expect(() => readFileSync(join(target, 'config.toml'))).toThrow();
  });

  it('writes nothing when a config.toml carries only non-whitelisted keys', () => {
    const { source, target } = homes('[features]\nhooks = true\n');
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: true, inherited: [] });
    expect(() => readFileSync(join(target, 'config.toml'))).toThrow();
  });

  it('refuses a symlinked config so a shared file cannot smuggle provider wiring in', () => {
    const { source, target } = homes();
    const real = join(source, 'real-config.toml');
    writeFileSync(real, 'model_provider = "x"\n');
    symlinkSync(real, join(source, 'config.toml'));
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: false, reason: 'config_unsafe_file' });
  });

  it('refuses an unparseable config instead of falling back to codex defaults', () => {
    const { source, target } = homes('model_provider = "unterminated\n[mcp_servers\n');
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: false, reason: 'config_invalid_toml' });
  });

  it('refuses a malformed provider section', () => {
    const { source, target } = homes('model_providers = "not-a-table"\n');
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: false, reason: 'config_invalid_toml' });
  });

  it('refuses a non-string model_provider', () => {
    const { source, target } = homes('model_provider = 42\n');
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: false, reason: 'config_invalid_toml' });
  });

  it('refuses an oversized config', () => {
    const { source, target } = homes(`model = "${'a'.repeat(300 * 1024)}"\n`);
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: false, reason: 'config_too_large' });
  });
});

describe('resolveSourceCodexHome', () => {
  it('uses the child env CODEX_HOME and falls back to <home>/.codex', () => {
    const { source } = homes();
    // Canonicalized: a symlinked CODEX_HOME must not be read through the link.
    expect(resolveSourceCodexHome({ CODEX_HOME: source }, '/nonexistent-home')).toBe(realpathSync(source));
    expect(resolveSourceCodexHome({}, '/nonexistent-home')).toBe(join('/nonexistent-home', '.codex'));
    expect(resolveSourceCodexHome(undefined, '/nonexistent-home')).toBe(join('/nonexistent-home', '.codex'));
  });
});

describe('hard-link guard (layered: O_NOFOLLOW covers symlinks, nlink covers hard links)', () => {
  it('refuses a hard-linked config so a shared inode cannot be swapped underneath', () => {
    const { source, target } = homes('model_provider = "x"\n');
    linkSync(join(source, 'config.toml'), join(source, 'second-name.toml'));
    expect(provisionIsolatedTitleConfig(source, target)).toEqual({ ok: false, reason: 'config_unsafe_file' });
  });
});
