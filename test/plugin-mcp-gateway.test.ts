import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  bindGatewayInputLifecycle,
  PluginMcpGateway,
  resolveGatewayEnvironment,
} from '../src/core/plugins/mcp/gateway.js';
import { refreshSessionMcpRuntimeManifest } from '../src/core/plugins/mcp/session-runtime.js';
import {
  sessionMcpGatewayPathRegex,
  startSessionMcpGatewayHost,
} from '../src/core/plugins/mcp/host.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../src/core/plugins/mcp/environment.js';
import { mcpGatewayAuthTokenPath } from '../src/core/plugins/mcp/socket-auth.js';
import { buildSeatbeltProfile } from '../src/adapters/cli/read-isolation.js';

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

  function installFixturePlugin(pluginId: string, fixtureName: string, env?: Record<string, string>) {
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
      ...(env ? { env } : {}),
    }));
    installLocalPlugin(source);
  }

  function mcpServeEnvironment(sessionId: string): Record<string, string> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.SESSION_DATA_DIR;
    return {
      ...env,
      HOME: home,
      USERPROFILE: home,
      BOTMUX_SESSION_ID: sessionId,
    };
  }

  async function connectMcpServe(sessionId: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/cli.ts'), 'mcp', 'serve'],
      cwd: resolve('.'),
      env: mcpServeEnvironment(sessionId),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'mcp-serve-test', version: '1.0.0' });
    await client.connect(transport);
    return client;
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

  it('uses one Botmux session id resolver for marker and isolated-env contexts', () => {
    const markerPid = 24680;
    const markerDataDir = join(home, 'custom-marker-data');
    const markerDir = join(markerDataDir, '.botmux-cli-pids');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, String(markerPid)), JSON.stringify({ sessionId: 'session-from-marker' }));

    const resolved = resolveGatewayEnvironment({ HOME: home, SESSION_DATA_DIR: markerDataDir }, markerPid);
    expect(resolved.BOTMUX_SESSION_ID).toBe('session-from-marker');
    rmSync(markerDir, { recursive: true, force: true });
    expect(resolveGatewayEnvironment({ BOTMUX_SESSION_ID: 'session-from-env' }, markerPid).BOTMUX_SESSION_ID)
      .toBe('session-from-env');
  });

  it('forwards the Botmux session to plugin MCP processes', async () => {
    installFixturePlugin('plugin-a', 'alpha');
    const gateway = new PluginMcpGateway(
      ['plugin-a'],
      { ...process.env, BOTMUX_SESSION_ID: 'session-downstream' },
    );
    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'echo', arguments: {} });
    expect((result.content[0] as any).text).toContain('session=session-downstream');

    await client.close();
    await gateway.close();
  });

  it('uses the session MCP runtime snapshot without reading the global plugin registry', async () => {
    installFixturePlugin('plugin-a', 'alpha');
    refreshSessionMcpRuntimeManifest({
      sessionId: 'snapshot-session',
      pluginIds: ['plugin-a'],
      dataDir: join(home, '.botmux', 'data'),
    });
    rmSync(join(home, '.botmux', 'plugins-registry.json'), { force: true });

    const gateway = new PluginMcpGateway(
      undefined,
      { ...process.env, BOTMUX_SESSION_ID: 'snapshot-session' },
    );
    const client = new Client({ name: 'gateway-snapshot-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);

    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['alpha_unique', 'echo']);

    await client.close();
    await gateway.close();
  });

  it('keeps MCP tools isolated between two bot sessions that enable different plugins', async () => {
    installFixturePlugin('plugin-a', 'alpha');
    const dataDir = join(home, '.botmux', 'data');
    refreshSessionMcpRuntimeManifest({
      sessionId: 'bot-a-session',
      pluginIds: ['plugin-a'],
      dataDir,
    });
    refreshSessionMcpRuntimeManifest({
      sessionId: 'bot-b-session',
      pluginIds: [],
      dataDir,
    });

    const listForSession = async (sessionId: string): Promise<string[]> => {
      const gateway = new PluginMcpGateway(
        undefined,
        { ...process.env, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId },
      );
      const client = new Client({ name: `gateway-${sessionId}`, version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);
      try {
        return (await client.listTools()).tools.map(tool => tool.name).sort();
      } finally {
        await client.close();
        await gateway.close();
      }
    };

    expect(await listForSession('bot-a-session')).toEqual(['alpha_unique', 'echo']);
    expect(await listForSession('bot-b-session')).toEqual([]);
  });

  it('keeps serving when diagnostics cannot be persisted', async () => {
    const blockedDataDir = join(home, 'not-a-directory');
    writeFileSync(blockedDataDir, 'blocked');
    vi.stubEnv('SESSION_DATA_DIR', blockedDataDir);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const gateway = new PluginMcpGateway([]);
    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);

    expect((await client.listTools()).tools).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[botmux-mcp] diagnostics write skipped:'));

    await client.close();
    await gateway.close();
  });

  it('uses ~/.botmux/data when mcp serve starts without SESSION_DATA_DIR', async () => {
    const sessionId = 'mcp-serve-default-data-dir';
    const diagnostics = join(home, '.botmux', 'data', 'mcp-gateway', `${sessionId}.json`);
    const client = await connectMcpServe(sessionId);
    try {
      expect((await client.listTools()).tools).toEqual([]);
      await vi.waitFor(() => expect(existsSync(diagnostics)).toBe(true));
      expect(JSON.parse(readFileSync(diagnostics, 'utf-8')).sessionId).toBe(sessionId);
    } finally {
      await client.close();
      rmSync(resolve('data', 'mcp-gateway', `${sessionId}.json`), { force: true });
    }
  });

  it('keeps the existing data-dir breadcrumb behavior for mcp serve', async () => {
    const sessionId = 'mcp-serve-custom-data-dir';
    const customDataDir = join(home, 'custom-data');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    mkdirSync(customDataDir, { recursive: true });
    writeFileSync(join(customDataDir, 'sessions.json'), '{}');
    writeFileSync(join(home, '.botmux', '.data-dir'), `${customDataDir}\n`);
    const diagnostics = join(customDataDir, 'mcp-gateway', `${sessionId}.json`);

    const client = await connectMcpServe(sessionId);
    try {
      expect((await client.listTools()).tools).toEqual([]);
      await vi.waitFor(() => expect(existsSync(diagnostics)).toBe(true));
    } finally {
      await client.close();
      rmSync(resolve('data', 'mcp-gateway', `${sessionId}.json`), { force: true });
    }
  });

  it('relays a custom-data-dir session through the trusted host without exposing its snapshot to mcp serve', async () => {
    const sessionId = 'trusted-host-custom-data-dir';
    const customDataDir = join(home, 'custom-botmux', 'data');
    vi.stubEnv('SESSION_DATA_DIR', customDataDir);
    installFixturePlugin('plugin-a', 'alpha', { PRIVATE_MCP_TOKEN: 'host-only-token' });
    refreshSessionMcpRuntimeManifest({
      sessionId,
      pluginIds: ['plugin-a'],
      dataDir: customDataDir,
    });
    const host = await startSessionMcpGatewayHost({ sessionId, dataDir: customDataDir });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/cli.ts'), 'mcp', 'serve'],
      cwd: resolve('.'),
      env: {
        ...mcpServeEnvironment(sessionId),
        SESSION_DATA_DIR: customDataDir,
        [MCP_GATEWAY_SOCKET_ENV]: host.socketPath,
        [MCP_GATEWAY_REQUIRED_ENV]: '1',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'trusted-host-relay-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['alpha_unique', 'echo']);
      const result = await client.callTool({ name: 'echo', arguments: {} });
      expect((result.content[0] as { text: string }).text).toContain(
        `session=${sessionId}:token=host-only-token`,
      );
    } finally {
      await client.close().catch(() => undefined);
      await host.close();
    }
  });

  it('fails closed when a managed relay loses its worker-owned socket', () => {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'mcp', 'serve'],
      {
        cwd: resolve('.'),
        env: {
          ...mcpServeEnvironment('missing-host-socket'),
          [MCP_GATEWAY_REQUIRED_ENV]: '1',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Botmux MCP Gateway host socket is unavailable');
  });

  it('fails closed when a managed relay has a socket but no authentication token', () => {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'mcp', 'serve'],
      {
        cwd: resolve('.'),
        env: {
          ...mcpServeEnvironment('missing-host-token'),
          [MCP_GATEWAY_SOCKET_ENV]: join(home, 'missing.sock'),
          [MCP_GATEWAY_REQUIRED_ENV]: '1',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Botmux MCP Gateway authentication token is unavailable');
  });

  it('rejects a same-UID sibling process that scans the Gateway socket directory', async () => {
    const socketRoot = join(home, 'socket-root');
    mkdirSync(socketRoot, { recursive: true });
    vi.stubEnv('TMPDIR', socketRoot);
    const host = await startSessionMcpGatewayHost({
      sessionId: 'same-uid-victim',
      dataDir: join(home, 'custom-botmux', 'data'),
    });
    expect(dirname(host.socketDir)).toBe(socketRoot);
    expect(statSync(mcpGatewayAuthTokenPath(host.socketPath)).mode & 0o777).toBe(0o600);

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
        const child = spawn(
          process.execPath,
          [resolve('test/fixtures/mcp-socket-attacker.mjs'), socketRoot],
          {
            cwd: resolve('.'),
            env: {
              HOME: home,
              PATH: process.env.PATH ?? '/usr/bin:/bin',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.once('error', rejectRun);
        child.once('close', code => resolveRun({ code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ scanned: 1, accepted: 0 });
    } finally {
      await host.close();
    }
  });

  it('denies all same-UID Gateway sockets before carving out the current macOS session', () => {
    const root = '/private/tmp';
    const ownDir = `${root}/bmcp-501-own-random`;
    const siblingDir = `${root}/bmcp-501-sibling-random`;
    const denyRegex = sessionMcpGatewayPathRegex(root, 501);
    expect(new RegExp(denyRegex).test(ownDir)).toBe(true);
    expect(new RegExp(denyRegex).test(siblingDir)).toBe(true);

    const profile = buildSeatbeltProfile([], [ownDir], [], [], [denyRegex], undefined, {
      denyWritePaths: [],
      denyWriteRegexes: [denyRegex],
      denyWriteLiterals: [],
    });
    const deny = `(deny file-read* (regex #"${denyRegex}"))`;
    const allow = `(allow file-read* (subpath "${ownDir}"))`;
    const writeDeny = `(deny file-write* (regex #"${denyRegex}"))`;
    expect(profile).toContain(deny);
    expect(profile).toContain(allow);
    expect(profile).toContain(writeDeny);
    expect(profile.indexOf(allow)).toBeGreaterThan(profile.indexOf(deny));
    expect(profile.indexOf(writeDeny)).toBeGreaterThan(profile.indexOf(allow));
  });

  it('revokes the worker-owned socket path synchronously during shutdown', async () => {
    const host = await startSessionMcpGatewayHost({
      sessionId: 'synchronous-socket-revoke',
      dataDir: join(home, 'custom-botmux', 'data'),
    });
    expect(existsSync(host.socketPath)).toBe(true);
    const closing = host.close();
    expect(existsSync(host.socketDir)).toBe(false);
    await closing;
  });

  it('closes the Gateway once when its MCP host stdin ends', async () => {
    const input = new PassThrough();
    const closeGateway = vi.fn(async () => undefined);
    const close = bindGatewayInputLifecycle(input, closeGateway);

    input.resume();
    input.end();
    await vi.waitFor(() => expect(closeGateway).toHaveBeenCalledTimes(1));

    input.destroy();
    await close();
    expect(closeGateway).toHaveBeenCalledTimes(1);
  });
});
