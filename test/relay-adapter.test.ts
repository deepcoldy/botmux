/**
 * relay-adapter.test.ts
 *
 * Relay CLI is the current release name of the
 * Seed fork — a Claude Code fork that reuses the entire Claude-family adapter,
 * only relocating its data root and renaming the binary. Relay 3.x defaults that
 * data root to `~/.relay` (honoring `RELAY_CONFIG_DIR`), NOT the legacy
 * `<pkg>/.claude-runtime` — botmux pins CLAUDE_CONFIG_DIR so Relay's own
 * auto-migration never fires, hence we must point at `~/.relay` ourselves. These
 * tests lock in that derivation, CLAUDE_CONFIG_DIR injection, the `.claude.json`
 * location, the `relay --resume` handoff, and that it inherits Claude's bridge
 * machinery (claudeDataDir / hook / type-ahead) verbatim.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

// resolveCommand() shells out to probe for the binary; mock it so an absolute
// pathOverride is returned as-is (resolveCommand short-circuits absolute paths
// before probing anyway).
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ stdout: '', status: 0 })),
}));

import { createRelayAdapter, deriveRelayDataDir } from '../src/adapters/cli/relay.js';

describe('deriveRelayDataDir', () => {
  afterEach(() => { delete process.env.RELAY_CONFIG_DIR; });

  it('defaults to ~/.relay (Relay 3.x default config dir, NOT the legacy .claude-runtime)', () => {
    delete process.env.RELAY_CONFIG_DIR;
    expect(deriveRelayDataDir()).toBe(join(homedir(), '.relay'));
  });

  it('honors RELAY_CONFIG_DIR override (matches a bare relay)', () => {
    process.env.RELAY_CONFIG_DIR = '/custom/relay/cfg';
    expect(deriveRelayDataDir()).toBe('/custom/relay/cfg');
  });
});

describe('createRelayAdapter', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-adapter-')));
  const pkg = join(root, 'pkg', 'claude-code');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'cli.js'), '// relay');
  const bin = join(pkg, 'dist', 'cli.js'); // absolute → resolveCommand returns as-is
  const expectedDataDir = join(homedir(), '.relay');
  const adapter = createRelayAdapter(bin);

  it('has id "relay"', () => {
    expect(adapter.id).toBe('relay');
  });

  it('exposes claudeDataDir at ~/.relay (Relay 3.x default)', () => {
    expect(adapter.claudeDataDir).toBe(expectedDataDir);
  });

  it('keeps .claude.json inside the data root (CLAUDE_CONFIG_DIR layout, not ~/.claude.json)', () => {
    expect(adapter.claudeStateJsonPath).toBe(join(expectedDataDir, '.claude.json'));
  });

  it('pins CLAUDE_CONFIG_DIR to the data root so the bridge watches where relay writes', () => {
    expect(adapter.spawnEnv).toEqual({ CLAUDE_CONFIG_DIR: expectedDataDir });
  });

  it('hookInstall targets the data root settings.json (isolated from ~/.claude)', () => {
    expect(adapter.hookInstall).toMatchObject({
      configPath: join(expectedDataDir, 'settings.json'),
      format: 'claude-settings',
    });
    expect(adapter.hookInstall?.sessionStartCommand).toMatch(/session-ready$/);
  });

  it('keeps bytedcli auth AND the SuperRelay token file real inside the file sandbox', () => {
    expect(adapter.authPaths).toEqual([
      '~/.local/share/bytedcli',
      join(expectedDataDir, 'byted-cloud-auth.json'),
    ]);
  });

  it('prints a `relay --resume` handoff, preferring the CLI-native session id', () => {
    expect(adapter.buildResumeCommand?.({ sessionId: 'botmux-sid', cliSessionId: 'cli-sid' }))
      .toBe('relay --resume cli-sid');
    expect(adapter.buildResumeCommand?.({ sessionId: 'botmux-sid' }))
      .toBe('relay --resume botmux-sid');
  });

  it('inherits Claude-family behavior (type-ahead, hook-driven asks, no model curation)', () => {
    expect(adapter.supportsTypeAhead).toBe(true);
    expect(adapter.asksViaHook).toBe(true);
    expect(adapter.injectsSessionContext).toBe(true);
    expect(adapter.modelChoices).toBeUndefined(); // gateway-defined, not Anthropic aliases
  });

  it('buildArgs uses --session-id for fresh and --resume for resume (Claude protocol)', () => {
    const fresh = adapter.buildArgs({ sessionId: 'abc', resume: false });
    expect(fresh).toContain('--session-id');
    expect(fresh).toContain('abc');
    const resumed = adapter.buildArgs({ sessionId: 'abc', resume: true, resumeSessionId: 'xyz' });
    expect(resumed).toContain('--resume');
    expect(resumed).toContain('xyz');
  });

  it('keeps the data root out of ~/.claude (no pollution of the user config)', () => {
    expect(adapter.claudeDataDir).not.toBe(join(homedir(), '.claude'));
    expect(dirname(adapter.claudeStateJsonPath!)).toBe(expectedDataDir);
  });
});
