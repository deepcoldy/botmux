import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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
  sessionMcpGatewaySocketDir,
  sessionMcpGatewaySocketPath,
  startSessionMcpGatewayHost,
} from '../src/core/plugins/mcp/host.js';
import {
  MCP_GATEWAY_RELAY_PROTOCOL_VERSION,
  mcpGatewayPaneReattachSafe,
  readMcpGatewayLaunchRecord,
  clearMcpGatewayLaunchRecord,
  writeMcpGatewayLaunchRecord,
} from '../src/core/plugins/mcp/launch-record.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../src/core/plugins/mcp/environment.js';
import { mcpGatewayAuthTokenPath } from '../src/core/plugins/mcp/socket-auth.js';
import { buildSeatbeltProfile } from '../src/adapters/cli/read-isolation.js';
import { isBunRuntime, spawnSyncTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

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

  async function connectMcpServe(
    sessionId: string,
    options: { dataDir?: string; cwd?: string } = {},
  ): Promise<Client> {
    const env = mcpServeEnvironment(sessionId);
    if (options.dataDir !== undefined) env.SESSION_DATA_DIR = options.dataDir;
    // Node needs an ABSOLUTE tsx specifier here (not the shared prefix's bare
    // `tsx`): one case below runs with `cwd` outside the repo, where a bare
    // specifier cannot be resolved. Bun runs TypeScript natively, so no prefix.
    const tsxPrefix = isBunRuntime() ? [] : ['--import', import.meta.resolve('tsx')];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...tsxPrefix, resolve('src/cli.ts'), 'mcp', 'serve'],
      cwd: options.cwd ?? resolve('.'),
      env,
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

  it('injects host-owned per-turn trusted caller metadata and overrides caller supplied metadata', async () => {
    installFixturePlugin('plugin-a', 'alpha');
    const gateway = new PluginMcpGateway(
      ['plugin-a'],
      { ...process.env, BOTMUX_SESSION_ID: 'session-trusted' },
      {
        trustedTurnIdentity: () => ({
          caller: {
            requestUserOpenId: 'ou_trusted',
            requestUserUnionId: 'on_trusted',
            requestLarkAppId: 'cli_trusted',
            source: 'schedule_creator',
            taskId: 'task_123',
          },
          turnId: 'om_turn',
          dispatchAttempt: 2,
        }),
      },
    );
    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'echo',
      arguments: {},
      _meta: {
        botmuxTrustedCaller: {
          requestUserOpenId: 'ou_forged',
          requestUserUnionId: 'on_forged',
        },
        botmuxImpersonatedUnionId: 'on_sibling_forged',
        customTrace: 'keep-me',
      },
    } as any);
    const text = (result.content[0] as any).text;
    expect(text).toContain('"requestUserOpenId":"ou_trusted"');
    expect(text).toContain('"requestUserUnionId":"on_trusted"');
    expect(text).toContain('"requestLarkAppId":"cli_trusted"');
    expect(text).toContain('"source":"schedule_creator"');
    expect(text).toContain('"taskId":"task_123"');
    expect(text).toContain('"turnId":"om_turn"');
    expect(text).toContain('"dispatchAttempt":2');
    expect(text).toContain('"customTrace":"keep-me"');
    expect(text).not.toContain('ou_forged');
    expect(text).not.toContain('on_forged');
    expect(text).not.toContain('on_sibling_forged');

    await client.close();
    await gateway.close();
  });

  it('strips caller supplied trusted caller metadata when no host identity exists', async () => {
    installFixturePlugin('plugin-a', 'alpha');
    const gateway = new PluginMcpGateway(
      ['plugin-a'],
      { ...process.env, BOTMUX_SESSION_ID: 'session-untrusted' },
    );
    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'echo',
      arguments: {},
      _meta: {
        botmuxTrustedCaller: {
          requestUserOpenId: 'ou_forged',
          requestUserUnionId: 'on_forged',
        },
        botmuxImpersonatedUnionId: 'on_sibling_forged',
        customTrace: 'keep-me',
      },
    } as any);
    const text = (result.content[0] as any).text;
    expect(text).toContain('"customTrace":"keep-me"');
    expect(text).not.toContain('botmuxTrustedCaller');
    expect(text).not.toContain('ou_forged');
    expect(text).not.toContain('on_forged');
    expect(text).not.toContain('on_sibling_forged');

    await client.close();
    await gateway.close();
  });

  it('strips caller supplied trusted identity headers before adding host-owned values', () => {
    const untrustedGateway = new PluginMcpGateway(
      [],
      { ...process.env, BOTMUX_SESSION_ID: 'session-untrusted' },
    );
    const stripped = (untrustedGateway as any).httpHeaders(
      {
        'x-botmux-turn-id': 'om_forged',
        'x-keep': 'keep-me',
      },
      {
        'x-botmux-trusted-open-id': 'ou_forged',
        'x-botmux-dispatch-attempt': '9',
      },
    ) as Headers;
    expect(stripped.get('x-botmux-trusted-open-id')).toBeNull();
    expect(stripped.get('x-botmux-turn-id')).toBeNull();
    expect(stripped.get('x-botmux-dispatch-attempt')).toBeNull();
    expect(stripped.get('x-keep')).toBe('keep-me');

    const trustedGateway = new PluginMcpGateway(
      [],
      { ...process.env, BOTMUX_SESSION_ID: 'session-trusted' },
      {
        trustedTurnIdentity: () => ({
          caller: {
            requestUserOpenId: 'ou_trusted',
            requestUserUnionId: 'on_trusted',
            requestLarkAppId: 'cli_trusted',
            source: 'schedule_creator',
            taskId: 'task_123',
          },
          turnId: 'om_trusted',
          dispatchAttempt: 2,
        }),
      },
    );
    const trusted = (trustedGateway as any).httpHeaders(
      { 'x-botmux-trusted-union-id': 'on_forged' },
      { 'x-botmux-trusted-open-id': 'ou_forged' },
    ) as Headers;
    expect(trusted.get('x-botmux-trusted-open-id')).toBe('ou_trusted');
    expect(trusted.get('x-botmux-trusted-union-id')).toBe('on_trusted');
    expect(trusted.get('x-botmux-trusted-app-id')).toBe('cli_trusted');
    expect(trusted.get('x-botmux-turn-id')).toBe('om_trusted');
    expect(trusted.get('x-botmux-dispatch-attempt')).toBe('2');
    // Provenance stays on the local `_meta` path only: these headers reach every
    // HTTP-transport MCP server, so they must not start carrying it.
    expect(trusted.get('x-botmux-trusted-source')).toBeNull();
    expect(trusted.get('x-botmux-task-id')).toBeNull();
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

  it('treats an empty SESSION_DATA_DIR as missing instead of writing into cwd', async () => {
    const sessionId = 'mcp-serve-empty-data-dir';
    const diagnostics = join(home, '.botmux', 'data', 'mcp-gateway', `${sessionId}.json`);
    const cwdDiagnostics = join(home, 'mcp-gateway', `${sessionId}.json`);
    const client = await connectMcpServe(sessionId, { dataDir: '', cwd: home });
    try {
      expect((await client.listTools()).tools).toEqual([]);
      await vi.waitFor(() => expect(existsSync(diagnostics)).toBe(true));
      expect(existsSync(cwdDiagnostics)).toBe(false);
    } finally {
      await client.close();
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
      command: tsRunnerPrefix().command,
      args: [...tsRunnerPrefix().prefixArgs, resolve('src/cli.ts'), 'mcp', 'serve'],
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

  it('relay survives a Gateway host replacement: reconnects, replays initialize, flushes buffered requests', async () => {
    const sessionId = 'relay-reconnect-across-hosts';
    const customDataDir = join(home, 'custom-botmux', 'data');
    vi.stubEnv('SESSION_DATA_DIR', customDataDir);
    installFixturePlugin('plugin-a', 'alpha');
    refreshSessionMcpRuntimeManifest({
      sessionId,
      pluginIds: ['plugin-a'],
      dataDir: customDataDir,
    });
    const host1 = await startSessionMcpGatewayHost({ sessionId, dataDir: customDataDir });
    const transport = new StdioClientTransport({
      command: tsRunnerPrefix().command,
      args: [...tsRunnerPrefix().prefixArgs, resolve('src/cli.ts'), 'mcp', 'serve'],
      cwd: resolve('.'),
      env: {
        ...mcpServeEnvironment(sessionId),
        SESSION_DATA_DIR: customDataDir,
        [MCP_GATEWAY_SOCKET_ENV]: host1.socketPath,
        [MCP_GATEWAY_REQUIRED_ENV]: '1',
        BOTMUX_MCP_RELAY_BACKOFF_MS: '50',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'relay-reconnect-test', version: '1.0.0' });
    let host2: Awaited<ReturnType<typeof startSessionMcpGatewayHost>> | undefined;
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['alpha_unique', 'echo']);

      // Kill the host the way a daemon restart does. The relay (and the MCP
      // client on top of it) stays alive inside the "pane".
      await host1.close();
      // Give the relay a moment to observe the disconnect so the next request
      // is deterministically buffered rather than racing the close event.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 150));

      // Issue a request during the outage — it must buffer, not fail.
      const pendingCall = client.callTool({ name: 'echo', arguments: {} });

      // Replacement worker: same session → same deterministic socket path.
      host2 = await startSessionMcpGatewayHost({ sessionId, dataDir: customDataDir });
      expect(host2.socketPath).toBe(host1.socketPath);

      // The relay reconnects, replays initialize/initialized on the fresh
      // Gateway connection (the client never re-initializes), then flushes the
      // buffered call.
      const result = await pendingCall;
      expect((result.content[0] as { text: string }).text).toContain(`session=${sessionId}`);

      // Steady-state after the swap keeps working.
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['alpha_unique', 'echo']);
    } finally {
      await client.close().catch(() => undefined);
      await host2?.close();
    }
  }, 30_000);

  it('decides pane reattach from the persisted Gateway launch record', () => {
    const dataDir = join(home, 'custom-botmux', 'data');
    const sessionId = 'launch-record-session';
    const expected = sessionMcpGatewaySocketPath(sessionId, dataDir);

    // No record (legacy pane or never launched with a gateway) → cold-resume.
    expect(mcpGatewayPaneReattachSafe(readMcpGatewayLaunchRecord(dataDir, sessionId), expected)).toBe(false);

    // Matching record from a reconnect-capable relay → reattach.
    writeMcpGatewayLaunchRecord(dataDir, sessionId, expected);
    expect(mcpGatewayPaneReattachSafe(readMcpGatewayLaunchRecord(dataDir, sessionId), expected)).toBe(true);

    // Path mismatch (e.g. dataDir moved, or an mkdtemp-era path) → cold-resume.
    expect(mcpGatewayPaneReattachSafe(
      { version: MCP_GATEWAY_RELAY_PROTOCOL_VERSION, socketPath: '/tmp/bmcp-0-deadbeef-XYZ/g.sock' },
      expected,
    )).toBe(false);

    // Pre-reconnect relay protocol → cold-resume.
    expect(mcpGatewayPaneReattachSafe({ version: 1, socketPath: expected }, expected)).toBe(false);

    // Cleared record (generation launched without a gateway) → cold-resume.
    clearMcpGatewayLaunchRecord(dataDir, sessionId);
    expect(readMcpGatewayLaunchRecord(dataDir, sessionId)).toBeNull();
  });

  // ─── Worker reattach wiring (source lock) ──────────────────────────────────
  //
  // spawnCli is not exported (repo convention: source-lock tests, see
  // resume-fresh-policy.test.ts). These pin the P0 fix: the pane-reattach-safe
  // branch MUST re-serve the trusted Gateway host at the deterministic path so
  // the surviving pane's relay can reconnect. Without it (the shipped bug) the
  // reattach branch only logged, willReattachPersistent stayed true, and the
  // sole host starter (prepareCliPluginGenerationAndGateway) was gated out by
  // `if (!willReattachPersistent)` — the relay then reconnected forever to a
  // socket nothing binds.
  describe('reattach-safe branch re-serves the Gateway host (source lock)', () => {
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');

    it('exposes a host-only starter that does NOT refresh the plugin generation', () => {
      // The starter must be separate from prepareCliPluginGenerationAndGateway
      // (which calls refreshCliPluginGeneration) so a warm reattach keeps the
      // CLI's existing catalog untouched while still binding a fresh host.
      const start = workerSource.indexOf('async function startAndRecordSessionMcpGatewayHost');
      expect(start).toBeGreaterThan(-1);
      const block = workerSource.slice(start, start + 800);
      expect(block).toContain('startSessionMcpGatewayHost(');
      expect(block).toContain('writeMcpGatewayLaunchRecord(');
      // Host-only: must NOT re-run the catalog/plugin refresh on this path.
      expect(block).not.toContain('refreshCliPluginGeneration(');
      // Both host-start paths (fresh/resumed via prepare*, and the re-served
      // reattach host) route through this helper, so it MUST keep #917's
      // per-turn trusted-caller provider wired — otherwise a warm reattach (and
      // every spawn) would silently stop injecting the host-signed identity.
      // The worker-level wiring is not otherwise exercised by a runtime test.
      expect(block).toContain('trustedTurnIdentity: currentGatewayTrustedTurnIdentity');
    });

    it('starts the replacement host inside the paneRelayReattachSafe branch', () => {
      const start = workerSource.indexOf('if (paneRelayReattachSafe) {');
      expect(start).toBeGreaterThan(-1);
      // Scope strictly to the reattach-safe branch (ends at the legacy
      // cold-resume `else if`), so a host start anywhere else can't satisfy this.
      const branchEnd = workerSource.indexOf('} else if (paneProbe === \'exists\') {', start);
      expect(branchEnd).toBeGreaterThan(start);
      const branch = workerSource.slice(start, branchEnd);
      expect(branch).toContain('startAndRecordSessionMcpGatewayHost(');
      // Only when this fresh worker has no live host yet — never stomp a host an
      // in-worker restart already brought up.
      expect(branch).toContain('if (!sessionMcpGatewayHost)');
    });

    it('re-serving is awaited and guarded by the spawn-generation fence', () => {
      const start = workerSource.indexOf('if (paneRelayReattachSafe) {');
      const branchEnd = workerSource.indexOf('} else if (paneProbe === \'exists\') {', start);
      const branch = workerSource.slice(start, branchEnd);
      expect(branch).toContain('await startAndRecordSessionMcpGatewayHost(');
      // A concurrent restart must not let a superseded generation keep running.
      expect(branch).toContain('if (spawnGeneration !== cliSpawnGeneration) throw new CliSpawnSupersededError();');
    });
  });

  it('re-served reattach host binds the same deterministic path a stranded relay reconnects to', async () => {
    // End-to-end proof of the fix's mechanism: a relay left running after its
    // host dies (the daemon-restart pane) has an in-flight call HANG, and the
    // moment a replacement host is bound at the SAME deterministic path — which
    // is exactly what startAndRecordSessionMcpGatewayHost now does on the
    // reattach branch — that same in-flight call resolves.
    const sessionId = 'reattach-reserve-reconnect';
    const dataDir = join(home, 'custom-botmux', 'data');
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    installFixturePlugin('plugin-a', 'alpha');
    refreshSessionMcpRuntimeManifest({ sessionId, pluginIds: ['plugin-a'], dataDir });

    const host1 = await startSessionMcpGatewayHost({ sessionId, dataDir });
    // The worker persists this record when it launches the CLI generation.
    writeMcpGatewayLaunchRecord(dataDir, sessionId, host1.socketPath);

    const transport = new StdioClientTransport({
      command: tsRunnerPrefix().command,
      args: [...tsRunnerPrefix().prefixArgs, resolve('src/cli.ts'), 'mcp', 'serve'],
      cwd: resolve('.'),
      env: {
        ...mcpServeEnvironment(sessionId),
        SESSION_DATA_DIR: dataDir,
        [MCP_GATEWAY_SOCKET_ENV]: host1.socketPath,
        [MCP_GATEWAY_REQUIRED_ENV]: '1',
        BOTMUX_MCP_RELAY_BACKOFF_MS: '50',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'reattach-reserve-test', version: '1.0.0' });
    let host2: Awaited<ReturnType<typeof startSessionMcpGatewayHost>> | undefined;
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['alpha_unique', 'echo']);

      // The worker's reattach decision, evaluated from the persisted record.
      expect(mcpGatewayPaneReattachSafe(
        readMcpGatewayLaunchRecord(dataDir, sessionId),
        sessionMcpGatewaySocketPath(sessionId, dataDir),
      )).toBe(true);

      // Daemon restart kills the host; the pane's relay + client live on.
      await host1.close();
      await new Promise(r => setTimeout(r, 150));

      // A call during the outage must buffer, not fail.
      let settled = false;
      const pendingCall = client.callTool({ name: 'echo', arguments: {} })
        .then(res => { settled = true; return res; });
      const duringOutage = await Promise.race([
        pendingCall.then(() => 'resolved'),
        new Promise<string>(r => setTimeout(() => r('still-pending'), 1500)),
      ]);
      expect(duringOutage).toBe('still-pending');
      expect(settled).toBe(false);

      // The fix: re-serve the host at the SAME deterministic path (what
      // startAndRecordSessionMcpGatewayHost does on the reattach branch).
      host2 = await startSessionMcpGatewayHost({ sessionId, dataDir });
      expect(host2.socketPath).toBe(host1.socketPath);

      const result = await pendingCall;
      expect((result.content[0] as { text: string }).text).toContain(`session=${sessionId}`);
    } finally {
      await client.close().catch(() => undefined);
      await host2?.close();
    }
  }, 30_000);

  it('fails closed when a managed relay loses its worker-owned socket', () => {
    const run = spawnSyncTsScript(
      resolve('src/cli.ts'),
      ['mcp', 'serve'],
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
    const run = spawnSyncTsScript(
      resolve('src/cli.ts'),
      ['mcp', 'serve'],
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
    // On macOS keep this mock root directly under /tmp instead of the already
    // nested per-test HOME. Darwin supports at most 103 bytes for a Unix socket
    // path; nesting it under HOME produces an unsupported 118-byte fixture and
    // tests path length rather than the same-UID authentication boundary.
    const socketRoot = mkdtempSync(join(
      process.platform === 'darwin' ? '/tmp' : tmpdir(),
      'botmux-mcp-socket-root-',
    ));
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
      rmSync(socketRoot, { recursive: true, force: true });
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

  it('revokes the worker-owned socket path synchronously during shutdown but keeps the directory', async () => {
    const host = await startSessionMcpGatewayHost({
      sessionId: 'synchronous-socket-revoke',
      dataDir: join(home, 'custom-botmux', 'data'),
    });
    expect(existsSync(host.socketPath)).toBe(true);
    const closing = host.close();
    // The socket (the connectable capability) is gone synchronously; the
    // directory must SURVIVE so a sandboxed pane's bwrap bind mount (pinned to
    // the directory inode) still sees the replacement host's socket after a
    // worker restart.
    expect(existsSync(host.socketPath)).toBe(false);
    expect(existsSync(host.socketDir)).toBe(true);
    await closing;
  });

  it('re-serves the same deterministic socket path across host generations', async () => {
    const dataDir = join(home, 'custom-botmux', 'data');
    const host1 = await startSessionMcpGatewayHost({ sessionId: 'stable-path', dataDir });
    expect(host1.socketPath).toBe(sessionMcpGatewaySocketPath('stable-path', dataDir));
    const path1 = host1.socketPath;
    await host1.close();
    const host2 = await startSessionMcpGatewayHost({ sessionId: 'stable-path', dataDir });
    try {
      expect(host2.socketPath).toBe(path1);
      expect(existsSync(host2.socketPath)).toBe(true);
    } finally {
      await host2.close();
    }
  });

  it('fails closed when the deterministic socket dir is a planted symlink', async () => {
    const dataDir = join(home, 'custom-botmux', 'data');
    const plantedTarget = join(home, 'attacker-target');
    mkdirSync(plantedTarget, { recursive: true });
    const dir = sessionMcpGatewaySocketDir('symlink-squat', dataDir);
    symlinkSync(plantedTarget, dir);
    try {
      await expect(startSessionMcpGatewayHost({ sessionId: 'symlink-squat', dataDir }))
        .rejects.toThrow(/not a directory/);
    } finally {
      rmSync(dir, { force: true });
    }
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
