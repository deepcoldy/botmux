import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliConfigDirEnvKey, cliSupportsConfigDir, normalizeCliConfigDir } from '../src/core/cli-config-dir.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

describe('normalizeCliConfigDir', () => {
  it('treats missing / blank as unset and trims a trailing slash', () => {
    expect(normalizeCliConfigDir(undefined)).toBeUndefined();
    expect(normalizeCliConfigDir(null)).toBeUndefined();
    expect(normalizeCliConfigDir('   ')).toBeUndefined();
    expect(normalizeCliConfigDir(' ~/.claude-api/ ')).toBe('~/.claude-api');
    expect(normalizeCliConfigDir('/opt/claude-profile')).toBe('/opt/claude-profile');
    expect(normalizeCliConfigDir('~')).toBe('~');
  });

  it('rejects values that cannot name a profile dir', () => {
    expect(() => normalizeCliConfigDir('relative/dir')).toThrow(/absolute path or start with ~\//);
    expect(() => normalizeCliConfigDir('~other/dir')).toThrow();
    expect(() => normalizeCliConfigDir(42)).toThrow(/string/);
    expect(() => normalizeCliConfigDir('/a\0b')).toThrow(/NUL/);
  });

  it('is limited to Claude Code for now', () => {
    expect(cliSupportsConfigDir('claude-code')).toBe(true);
    expect(cliSupportsConfigDir('codex')).toBe(false);
    expect(cliSupportsConfigDir('relay')).toBe(false);
    expect(cliConfigDirEnvKey('claude-code')).toBe('CLAUDE_CONFIG_DIR');
  });
});

describe('Claude Code adapter with a config profile', () => {
  const profile = join(homedir(), '.claude-api');

  it('moves every data-root-derived path into the profile', () => {
    const adapter = createClaudeCodeAdapter(undefined, '~/.claude-api');
    expect(adapter.claudeDataDir).toBe(profile);
    expect(adapter.claudeStateJsonPath).toBe(join(profile, '.claude.json'));
    expect(adapter.spawnEnv).toEqual({ CLAUDE_CONFIG_DIR: profile });
    expect(adapter.hookInstall?.configPath).toBe(join(profile, 'settings.json'));
    expect(adapter.mcpGateway?.configPath).toBe(join(profile, '.claude.json'));
    expect(adapter.authPaths).toEqual([join(profile, '.credentials.json')]);
  });

  it('prints a resume command that reopens the same profile', () => {
    const adapter = createClaudeCodeAdapter(undefined, '~/.claude-api');
    expect(adapter.buildResumeCommand?.({ sessionId: 's1', cliSessionId: 'abc' } as any))
      .toBe(`CLAUDE_CONFIG_DIR='${profile}' claude --resume abc`);
  });

  it('leaves the default adapter byte-for-byte unchanged', () => {
    const adapter = createClaudeCodeAdapter();
    expect(adapter.claudeDataDir).toBe(join(homedir(), '.claude'));
    expect(adapter.claudeStateJsonPath).toBe(join(homedir(), '.claude.json'));
    expect(adapter.spawnEnv).toBeUndefined();
    expect(adapter.buildResumeCommand?.({ sessionId: 's1', cliSessionId: 'abc' } as any)).toBe('claude --resume abc');
  });

  it('is applied by the registry only for CLIs that support it', () => {
    expect(createCliAdapterSync('claude-code', undefined, { configDir: '~/.claude-api' }).claudeDataDir).toBe(profile);
    expect(createCliAdapterSync('claude-code', undefined, { configDir: '' }).claudeDataDir).toBe(join(homedir(), '.claude'));
    const relay = createCliAdapterSync('relay', undefined, { configDir: '~/.claude-api' });
    expect(relay.spawnEnv?.CLAUDE_CONFIG_DIR).not.toBe(profile);
  });
});

describe('bots.json cliConfigDir', () => {
  const entry = (extra: Record<string, unknown>) => JSON.stringify([{
    larkAppId: 'cli_profile_bot',
    larkAppSecret: 'secret',
    allowedUsers: ['tester@example.com'],
    ...extra,
  }]);

  it('keeps a valid profile for claude-code', () => {
    const [bot] = parseBotConfigsFromText(entry({ cliId: 'claude-code', cliConfigDir: '~/.claude-api/' }));
    expect(bot!.cliConfigDir).toBe('~/.claude-api');
  });

  it('drops it for a CLI without profile support, like other CLI-specific fields', () => {
    const [bot] = parseBotConfigsFromText(entry({ cliId: 'codex', cliConfigDir: '~/.claude-api' }));
    expect(bot!.cliConfigDir).toBeUndefined();
  });

  it('fails closed on a malformed value instead of silently using ~/.claude', () => {
    expect(() => parseBotConfigsFromText(entry({ cliId: 'claude-code', cliConfigDir: 'relative' })))
      .toThrow(/Bot config \[0\]: cliConfigDir must be an absolute path/);
  });
});

describe('profile wiring through spawn and sandbox provisioning', () => {
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const pool = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

  it('creates the spawn adapter with the frozen profile and ships it on init', () => {
    expect(worker).toContain('cliAdapter = createCliAdapterSync(effectiveCliId, cfg.cliPathOverride, { configDir: cfg.cliConfigDir });');
    expect(pool).toContain('cliConfigDir: agentCfg.cliConfigDir,');
    expect(pool).toContain('ensureCliEnv(agentCfg.cliId, agentCfg.cliPathOverride, { configDir: agentCfg.cliConfigDir });');
  });

  it('installs hooks once per (cli, profile), not once per cli', () => {
    expect(pool).toMatch(/const installKey = cliSupportsConfigDir\(cliId\) && opts\?\.configDir \? `\$\{cliId\}\\0\$\{opts\.configDir\}` : cliId;/);
    expect(pool).not.toContain('skillsInstalledCliIds.has(cliId)');
  });

  it('under the sandbox, seeds BOT_HOME from the profile instead of the global ~/.claude', () => {
    const capture = worker.indexOf('const claudeProfileDir = isClaudeFam && cfg.cliConfigDir ? claudeDataDir : undefined;');
    const redirect = worker.indexOf("if (isClaudeFam) claudeDataDir = join(isolationBotHome, 'claude');", capture);
    expect(capture).toBeGreaterThan(-1);
    expect(redirect).toBeGreaterThan(capture);
    expect(worker).toContain("inheritClaudeEnvFrom: join(claudeProfileDir ?? join(homedir(), '.claude'), 'settings.json'),");
    expect(worker).toContain("claudeProfileDir ? join(claudeProfileDir, '.claude.json') : undefined,");
  });
});
