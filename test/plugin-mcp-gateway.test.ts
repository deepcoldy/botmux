import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { PluginMcpGateway } from '../src/core/plugins/mcp/gateway.js';

describe('plugin MCP Gateway', () => {
  let home: string;
  let fixture: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-mcp-gateway-'));
    fixture = resolve('test/fixtures/plugin-mcp-server.mjs');
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function installFixturePlugin(pluginId: string, fixtureName: string) {
    const source = join(home, `${pluginId}-src`);
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: `@botmux-ai/plugin-${pluginId}`,
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: pluginId },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [process.execPath, fixture, fixtureName],
    }));
    installLocalPlugin(source);
  }

  it('aggregates paginated lists, aliases collisions, and routes direct operations', async () => {
    installFixturePlugin('plugin-a', 'alpha');
    installFixturePlugin('plugin-b', 'beta');

    const gateway = new PluginMcpGateway(['plugin-a', 'plugin-b']);
    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'alpha_unique',
      'beta_unique',
      'plugin-a__echo',
      'plugin-b__echo',
    ]);
    const alphaCall = await client.callTool({ name: 'plugin-a__echo', arguments: { value: 1 } });
    const betaCall = await client.callTool({ name: 'plugin-b__echo', arguments: { value: 2 } });
    expect((alphaCall.content[0] as any).text).toContain('alpha:echo');
    expect((betaCall.content[0] as any).text).toContain('beta:echo');

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(prompt => prompt.name).sort()).toEqual(['plugin-a__welcome', 'plugin-b__welcome']);
    expect((await client.getPrompt({ name: 'plugin-b__welcome' })).description).toBe('beta:welcome');
    expect((await client.complete({
      ref: { type: 'ref/prompt', name: 'plugin-a__welcome' },
      argument: { name: 'value', value: 'go' },
    })).completion.values).toEqual(['alpha:go']);

    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(2);
    expect(resources.resources.every(resource => resource.uri.startsWith('botmux+'))).toBe(true);
    const first = resources.resources[0];
    const read = await client.readResource({ uri: first.uri });
    expect(read.contents[0].uri).toBe(first.uri);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates).toHaveLength(2);
    expect(templates.resourceTemplates.every(template => template.uriTemplate.startsWith('botmux+'))).toBe(true);

    await client.close();
    await gateway.close();
  });

  it('isolates a failed downstream server', async () => {
    const connectSpy = vi.spyOn(Client.prototype, 'connect');
    installFixturePlugin('plugin-a', 'alpha');
    installFixturePlugin('plugin-fail', 'fail');
    const gateway = new PluginMcpGateway(['plugin-a', 'plugin-fail']);
    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['alpha_unique', 'echo']);
    expect(connectSpy).toHaveBeenCalledWith(expect.anything(), { timeout: 10_000 });
    await client.close();
    await gateway.close();
  });
});
