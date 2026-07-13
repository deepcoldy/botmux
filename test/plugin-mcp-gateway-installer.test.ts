import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureGatewayEntry, inspectGatewayEntry, removeGatewayEntry } from '../src/core/plugins/mcp/gateway-installer.js';

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
    expect(text.match(/\[mcp_servers\.botmux\]/g)).toHaveLength(1);
    expect(text).not.toContain('botmux plugin demo');
    expect(text).not.toContain('legacy-without-leading-marker');

    expect(removeGatewayEntry(adapter).state).toBe('removed');
    expect(inspectGatewayEntry(adapter).state).toBe('absent');
    expect(readFileSync(path, 'utf8')).toContain('[mcp_servers.keep]');
    expect(readFileSync(path, 'utf8')).not.toContain('mcp_servers.botmux');
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
      env: { BOTMUX_MCP_GATEWAY: '1' },
    });

    expect(removeGatewayEntry(adapter).state).toBe('removed');
    const removed = JSON.parse(readFileSync(path, 'utf8'));
    expect(removed.mcpServers).toEqual({ keep: { command: 'keep' } });
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
