import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CliAdapter, CliId } from '../src/adapters/cli/types.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { prepareCliPluginGeneration } from '../src/core/plugins/cli-generation.js';
import { collectPluginCliCommands, createConfigApi } from '../src/core/plugins/runtime.js';
import { readSessionMcpRuntimeManifest } from '../src/core/plugins/mcp/session-runtime.js';

const example = resolve('examples/openviking-memory');
execFileSync(process.execPath, [join(example, 'build-plugin.mjs')]);

describe('shared OpenViking example delivery', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-shared-memory-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux/data'));
    installLocalPlugin(join(example, 'plugin'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('installed but disabled contributes no memory prompt, CLI command or MCP server', async () => {
    for (const cliId of ['codex', 'claude-code', 'opencode', 'gemini'] as CliId[]) {
      const result = prepareCliPluginGeneration({
        sessionId: `off-${cliId}`, bot: { larkAppId: 'owner-bot' }, global: { plugins: [] },
        cliId, adapter: { id: cliId } as CliAdapter, workingDir: home,
        dataDir: join(home, '.botmux/data'), prompt: 'Current task',
      });
      expect(result.prompt).toBe('Current task');
      expect(result.skillCatalog).toBeUndefined();
      expect(result.pluginManifest.pluginIds).toEqual([]);
      expect(readSessionMcpRuntimeManifest(`off-${cliId}`, join(home, '.botmux/data'))?.entries).toEqual([]);
    }
  });

  it('one plugin supplies the same memory skill and CLI to different Agent adapters', async () => {
    for (const cliId of ['codex', 'claude-code', 'opencode', 'gemini'] as CliId[]) {
      const result = prepareCliPluginGeneration({
        sessionId: `on-${cliId}`, bot: { larkAppId: 'owner-bot', plugins: ['openviking'] }, global: { plugins: [] },
        cliId, adapter: { id: cliId } as CliAdapter, workingDir: home,
        dataDir: join(home, '.botmux/data'), prompt: 'Use past project decisions',
      });
      expect(result.skillCatalog).toContain('openviking-memory');
      expect(result.skillCatalog).toContain('botmux skill show openviking-memory');
      expect(result.pluginManifest.pluginIds).toEqual(['openviking']);
    }
    expect((await collectPluginCliCommands(['openviking'])).map(command => command.name)).toEqual(['openviking']);
  });

  it('non-Codex plugin commands reuse the shared user and project and reject identity overrides', async () => {
    const config = join(home, 'ovcli.conf');
    writeFileSync(config, JSON.stringify({ url: 'http://127.0.0.1:1933', user: 'shared-owner' }));
    createConfigApi('openviking').replace({ bots: { 'claude-bot': { clientConfig: config } } });
    vi.stubEnv('BOTMUX_LARK_APP_ID', 'claude-bot');
    const [command] = await collectPluginCliCommands(['openviking']);
    const context = { runtime: 'cli' as const, pluginId: 'openviking', pluginDir: join(home, '.botmux/plugins/openviking/dist'),
      packageName: 'botmux-plugin-openviking-memory-example', version: '0.1.0', manifest: { schemaVersion: 1 as const, id: 'openviking' } };
    const result = await command.run({ ...context, args: ['identity'] });
    expect(JSON.parse(String(result)).user).toBe('shared-owner');
    await expect(command.run({ ...context, args: ['--config', '/other-user.conf', 'identity'] })).rejects.toThrow('fixes config');
    await expect(command.run({ ...context, args: ['--cwd', '/other-project', 'identity'] })).rejects.toThrow('fixes cwd');
  });
});
