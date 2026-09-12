import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { ensureGatewayEntry, inspectGatewayEntry, removeGatewayEntry } from '../src/core/plugins/mcp/gateway-installer.js';
import {
  MCP_GATEWAY_FORWARDED_ENV_KEYS,
  MCP_GATEWAY_OWNER_ENV,
} from '../src/core/plugins/mcp/environment.js';

describe('plugin MCP Gateway installer', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-gateway-installer-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_BIN_PATH', join(home, '.botmux', 'bin', 'botmux'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps one Codex gateway entry, preserves user servers, and removes legacy plugin blocks', () => {
    const path = join(home, '.codex', 'config.toml');
    const pluginHome = join(home, '.botmux', 'plugins', 'demo');
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(pluginHome, { recursive: true });
    writeFileSync(join(home, '.botmux', 'plugins-registry.json'), JSON.stringify({
      schemaVersion: 1,
      plugins: {
        demo: {
          id: 'demo',
          packageName: '@botmux-ai/plugin-demo',
          version: '0.1.0',
          source: { type: 'local', spec: '.' },
          manifest: { schemaVersion: 1, id: 'demo' },
          installedAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      },
    }));
    writeFileSync(join(pluginHome, 'materialized.json'), JSON.stringify({
      schemaVersion: 1,
      pluginId: 'demo',
      updatedAt: '2026-07-12T00:00:00.000Z',
      mcp: [{ cliId: 'codex', name: 'orphaned', path: 'mcp' }],
    }));
    writeFileSync(path, [
      '[mcp_servers.keep]',
      'command = "keep"',
      '',
      '# >>> botmux plugin demo',
      '[mcp_servers.demo]',
      'command = "legacy"',
      '# <<< botmux plugin demo',
      '',
      '[mcp_servers.orphaned]',
      'command = "legacy-without-leading-marker"',
      '',
    ].join('\n'));
    const adapter = { id: 'codex', mcpGateway: { format: 'codex-toml' as const, configPath: path } };

    expect(ensureGatewayEntry(adapter).state).toBe('installed');
    expect(ensureGatewayEntry(adapter).state).toBe('unchanged');
    expect(inspectGatewayEntry(adapter).state).toBe('configured');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('[mcp_servers.keep]');
    expect(text).toContain('[mcp_servers.botmux]');
    expect(text).toContain(`command = ${JSON.stringify(join(home, '.botmux', 'bin', 'botmux'))}`);
    expect(text).toContain(
      `env_vars = [${MCP_GATEWAY_FORWARDED_ENV_KEYS.map(value => JSON.stringify(value)).join(', ')}]`,
    );
    expect(text.match(/\[mcp_servers\.botmux\]/g)).toHaveLength(1);
    expect(text).not.toContain('botmux plugin demo');
    expect(text).not.toContain('legacy-without-leading-marker');

    expect(removeGatewayEntry(adapter).state).toBe('removed');
    expect(inspectGatewayEntry(adapter).state).toBe('absent');
    expect(readFileSync(path, 'utf8')).toContain('[mcp_servers.keep]');
    expect(readFileSync(path, 'utf8')).not.toContain('mcp_servers.botmux');
  });

  it.each(['\n', '\r\n'])('preserves tables inserted before the gateway end marker (%j)', (newline) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(dirname(path), { recursive: true });
    const adapter = { id: 'codex', mcpGateway: { format: 'codex-toml' as const, configPath: path } };
    const userTables = [
      '[hooks.state]',
      '[hooks.state."/tmp/hooks.json:session_start:0:0"]',
      'trusted_hash = "sha256:first"',
      '[hooks.state."/tmp/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:second"',
      '[projects."/tmp/work"]',
      'trust_level = "trusted"',
      '[mcp_servers.keep]',
      'command = "keep"',
    ].join('\n');
    const initial = [
      'model = "test-model"',
      '# >>> botmux mcp gateway',
      '[mcp_servers.botmux]',
      'command = "old-gateway"',
      '[mcp_servers.botmux.env]',
      'OWNED = "old"',
      userTables,
      '# <<< botmux mcp gateway',
      '',
    ].join('\n').replace(/\n/g, newline);

    writeFileSync(path, initial);
    expect(ensureGatewayEntry(adapter).state).toBe('installed');
    const updated = readFileSync(path, 'utf8');
    expect(updated).toContain(userTables);
    expect(updated).toContain('model = "test-model"');
    expect(updated).not.toContain('old-gateway');
    expect(updated).not.toContain('OWNED = "old"');
    expect(updated.indexOf('[hooks.state]')).toBeLessThan(updated.indexOf('# >>> botmux mcp gateway'));
    expect(ensureGatewayEntry(adapter).state).toBe('unchanged');

    // Removal must also preserve a file that has not gone through repair yet.
    writeFileSync(path, initial);
    expect(removeGatewayEntry(adapter).state).toBe('removed');
    const removed = readFileSync(path, 'utf8');
    expect(removed).toContain(userTables);
    expect(removed).not.toContain('mcp_servers.botmux');
    expect(removed).not.toContain('botmux mcp gateway');
    expect(removeGatewayEntry(adapter).state).toBe('absent');
  });

  it('merges and removes only the owned Claude gateway entry', () => {
    const path = join(home, '.claude.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { keep: { command: 'keep' } }, theme: 'dark' }));
    const adapter = { id: 'claude-code', mcpGateway: { format: 'claude-json' as const, configPath: path } };

    expect(ensureGatewayEntry(adapter).state).toBe('installed');
    const installed = JSON.parse(readFileSync(path, 'utf8'));
    expect(installed.theme).toBe('dark');
    expect(installed.mcpServers.keep.command).toBe('keep');
    expect(installed.mcpServers.botmux).toMatchObject({
      type: 'stdio',
      command: join(home, '.botmux', 'bin', 'botmux'),
      args: ['mcp', 'serve'],
      env: {
        [MCP_GATEWAY_OWNER_ENV]: '1',
        BOTMUX_SESSION_ID: '${BOTMUX_SESSION_ID:-}',
        SESSION_DATA_DIR: '${SESSION_DATA_DIR:-}',
        BOTMUX_MCP_GATEWAY_SOCKET: '${BOTMUX_MCP_GATEWAY_SOCKET:-}',
        BOTMUX_MCP_GATEWAY_REQUIRED: '${BOTMUX_MCP_GATEWAY_REQUIRED:-}',
      },
    });

    expect(removeGatewayEntry(adapter).state).toBe('removed');
    const removed = JSON.parse(readFileSync(path, 'utf8'));
    expect(removed.mcpServers).toEqual({ keep: { command: 'keep' } });
  });

  it('defaults the gateway command to the stable main wrapper even when the native hook gets a dedicated sibling', () => {
    vi.unstubAllEnvs();
    vi.stubEnv('HOME', home);
    const path = join(home, '.claude.json');
    const adapter = { id: 'claude-code', mcpGateway: { format: 'claude-json' as const, configPath: path } };

    expect(ensureGatewayEntry(adapter).state).toBe('installed');
    const installed = JSON.parse(readFileSync(path, 'utf8'));
    expect(installed.mcpServers.botmux.command).toBe(join(realpathSync(home), '.botmux', 'bin', 'botmux'));
    expect(installed.mcpServers.botmux.command).not.toContain('native-subagent-runtime-hook');
  });

  it('does not overwrite a malformed JSON config', () => {
    const path = join(home, '.claude.json');
    writeFileSync(path, '{broken');
    const adapter = { id: 'claude-code', mcpGateway: { format: 'claude-json' as const, configPath: path } };
    const report = ensureGatewayEntry(adapter);
    expect(report.state).toBe('adapter-required');
    expect(report.warning).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});
