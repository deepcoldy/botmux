import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { PluginMcpGateway, type GatewayTrustedTurnIdentity } from '../src/core/plugins/mcp/gateway.js';
import { refreshSessionMcpRuntimeManifest, readSessionMcpRuntimeManifest, sessionMcpRuntimeManifestPath } from '../src/core/plugins/mcp/session-runtime.js';
import { parseBytedcliBrokerConfig } from '../src/global-config.js';
import { assertBytedcliLaunchSupported } from '../src/core/bytedcli-linux-containment.js';
import { startSessionMcpGatewayHost } from '../src/core/plugins/mcp/host.js';
import { MCP_GATEWAY_HANDSHAKE_PREFIX, MCP_GATEWAY_HANDSHAKE_OK } from '../src/core/plugins/mcp/environment.js';
import { mcpGatewayAuthTokenPath } from '../src/core/plugins/mcp/socket-auth.js';
import { pluginsHome, pluginPrivateDir } from '../src/core/plugins/paths.js';
import { buildFsPolicy } from '../src/adapters/cli/fs-policy.js';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { isCurrentReadOnlyMcpExecution } from '../src/core/plugins/mcp/read-only-policy.js';

const linuxSandbox = process.platform === 'linux' && spawnSync('bwrap', ['--unshare-user', '--unshare-pid', '--tmpfs', '/', '--proc', '/proc', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '/usr/bin/true']).status === 0;

describe('strict sessions with host-approved read-only MCP tools', () => {
  let home: string;
  let dataDir: string;
  const policy = { reader: ['echo'] };
  let identity: GatewayTrustedTurnIdentity | undefined;
  let authorized: boolean;
  let gateway: PluginMcpGateway | undefined;
  let client: Client | undefined;

  function install(id: string, name = 'fixture', extra = {}) {
    const source = join(home, id);
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: `@botmux-ai/plugin-${id}`, version: '0.1.0', keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id } }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({ transport: 'stdio', command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), name], ...extra }));
    installLocalPlugin(source);
  }
  function manifest() {
    return refreshSessionMcpRuntimeManifest({ sessionId: 'strict-reader', pluginIds: ['reader', 'writer'], hostMcpEnabled: false,
      hostReadOnlyMcpTools: policy, dataDir });
  }
  async function connect(options = {}) {
    gateway = new PluginMcpGateway(undefined, { ...process.env, BOTMUX_SESSION_ID: 'strict-reader', SESSION_DATA_DIR: dataDir }, {
      trustedTurnIdentity: () => identity,
      readOnly: { tools: policy, authorize: () => authorized },
      ...options,
    });
    client = new Client({ name: 'read-only-test', version: '1' }, { capabilities: { sampling: {}, roots: {}, elicitation: {} } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(b), client.connect(a)]);
    return client;
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-read-only-mcp-'));
    dataDir = join(home, '.botmux', 'data');
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    identity = { turnId: 'schedule:one', dispatchAttempt: 1, sessionOrigin: { bindingId: 'binding-one', runtime: { runtimeId: 'runtime-one', epoch: 1 }, execution: { executionId: 'execution-one', turnId: 'schedule:one', dispatchAttempt: 1 } } } as GatewayTrustedTurnIdentity;
    authorized = true;
    install('reader'); install('writer');
  });
  afterEach(async () => {
    await client?.close(); await gateway?.close(); client = undefined; gateway = undefined;
    vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
  });

  it('accepts an exact external allowlist and rejects patterns, empty entries, and unknown config keys', () => {
    expect(parseBytedcliBrokerConfig({ hostReadOnlyMcpTools: policy })).toEqual({ hostReadOnlyMcpTools: policy });
    for (const tools of [{ reader: ['*'] }, { reader: [] }, { '../reader': ['echo'] }, { reader: ['echo', 'echo'] }, { reader: 'echo' }]) {
      expect(() => parseBytedcliBrokerConfig({ hostReadOnlyMcpTools: tools })).toThrow();
    }
    expect(() => parseBytedcliBrokerConfig({ allowAllMcp: true })).toThrow();
  });
  it('requires an admitted active execution of this runtime, including scheduled turns without a human identity', () => {
    const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 's' }, { workerId: 'worker', generation: 1 });
    const binding = scope.beginRuntime(); const runtime = { runtimeId: 'r', epoch: 1 };
    scope.assign(binding.bindingId, runtime);
    const execution = { executionId: 'e', turnId: 'schedule:one', dispatchAttempt: 1 };
    const turn = { turnId: execution.turnId, dispatchAttempt: 1, sessionOrigin: { bindingId: binding.bindingId, runtime, execution } };
    expect(isCurrentReadOnlyMcpExecution(turn, scope)).toBe(false);
    scope.noteAdmission({ ref: execution, runtime, phase: 'queued' });
    expect(isCurrentReadOnlyMcpExecution(turn, scope)).toBe(false);
    scope.noteAdmission({ ref: execution, runtime, phase: 'accepted' });
    expect(isCurrentReadOnlyMcpExecution(turn, scope)).toBe(true);
    expect(isCurrentReadOnlyMcpExecution({ ...turn, sessionOrigin: { ...turn.sessionOrigin, execution: { ...execution, executionId: 'other' } } }, scope)).toBe(false);
    scope.noteAdmission({ ref: execution, runtime, phase: 'cancelled' });
    expect(isCurrentReadOnlyMcpExecution(turn, scope)).toBe(false);
  });
  it('keeps unconfigured servers disabled and marks only approved stdio reads in the private snapshot', () => {
    expect(manifest().entries).toMatchObject([{ pluginId: 'reader', readOnlyTools: ['echo'] }]);
    expect(readSessionMcpRuntimeManifest('strict-reader', dataDir)?.entries).toHaveLength(1);
    expect(refreshSessionMcpRuntimeManifest({ sessionId: 'strict-reader', pluginIds: ['reader'], hostMcpEnabled: false, dataDir }).entries).toEqual([]);
    install('reader', 'fixture', { protectedCapability: 'fixture.write.v1' });
    expect(() => manifest()).toThrow(/read.only/i);
  });
  it('allows only a validated read-only snapshot at the strict launch boundary', () => {
    const input = { platform: 'linux', backendType: 'pty', cliId: 'codex', sandbox: 'oncall', hostMcpEntries: 1 };
    expect(() => assertBytedcliLaunchSupported(input)).toThrow();
    const snapshot = manifest();
    expect(() => assertBytedcliLaunchSupported({ ...input, hostMcpRuntime: snapshot, hostReadOnlyMcpTools: policy })).not.toThrow();
    expect(() => assertBytedcliLaunchSupported({ ...input, hostMcpRuntime: { ...snapshot, entries: [{ ...snapshot.entries[0], readOnlyTools: ['fixture_unique'] }] }, hostReadOnlyMcpTools: policy })).toThrow();
  });
  it('exports only approved reads, denies sibling tools and all non-tool methods, and strips forged identity', async () => {
    manifest(); const c = await connect();
    expect((await c.listTools()).tools.map(t => t.name)).toEqual(['echo']);
    expect(c.getServerCapabilities()?.resources).toBeUndefined();
    expect(c.getServerCapabilities()?.prompts).toBeUndefined();
    const result = await c.callTool({ name: 'echo', arguments: {}, _meta: { botmux: { requestUserOpenId: 'forged' } } });
    expect(JSON.stringify(result)).not.toContain('forged');
    expect(JSON.stringify(result)).toContain('schedule:one');
    await expect(c.callTool({ name: 'fixture_unique' })).rejects.toThrow();
    await expect(c.readResource({ uri: 'demo://shared' })).rejects.toThrow();
    await expect(c.getPrompt({ name: 'welcome' })).rejects.toThrow();
  });
  it('rejects linked runtimes when generating a strict snapshot', () => {
    installLocalPlugin(join(home, 'reader'), { link: true });
    expect(() => manifest()).toThrow(/frozen regular tree/);
  });
  it('rejects interior symlinks preserved by a copied install', () => {
    symlinkSync('index.json', join(home, 'reader', 'dist', 'mcp', 'linked-descriptor.json'));
    installLocalPlugin(join(home, 'reader'));
    expect(() => manifest()).toThrow(/frozen regular tree/);
  });
  it('revalidates the runtime tree when a gateway starts from an earlier valid snapshot', async () => {
    manifest();
    installLocalPlugin(join(home, 'reader'), { link: true });
    await expect(connect()).rejects.toThrow(/frozen regular tree/);
  });
  it('fails closed when the snapshot is missing or invalid instead of falling back to registry plugins', async () => {
    await expect(connect()).rejects.toThrow(/snapshot|manifest/i);
    manifest(); writeFileSync(sessionMcpRuntimeManifestPath('strict-reader', dataDir), '{}');
    await expect(connect()).rejects.toThrow(/snapshot|manifest/i);
  });
  it('rejects idle, revoked and changed turns even for an already discovered read route', async () => {
    manifest(); const c = await connect(); await c.listTools();
    const active = identity;
    identity = undefined;
    await expect(c.callTool({ name: 'echo' })).rejects.toThrow(/read.only|turn/i);
    identity = { turnId: 'idle' };
    await expect(c.callTool({ name: 'echo' })).rejects.toThrow();
    identity = active;
    authorized = false;
    await expect(c.callTool({ name: 'echo' })).rejects.toThrow();
  });
  it('blocks privileged host delivery from an approved read tool', async () => {
    install('reader', 'delivery'); manifest();
    const delivery = vi.fn(); const c = await connect({ trustedResultDelivery: delivery });
    await expect(c.callTool({ name: 'echo' })).rejects.toThrow(/read.only|delivery/i);
    expect(delivery).not.toHaveBeenCalled();
  });
  it.each(['superseded', 'revoked'])('discards a long read after its turn is %s', async change => {
    install('reader', 'slow'); manifest(); const c = await connect(); await c.listTools();
    const call = c.callTool({ name: 'echo', arguments: { delayMs: 200 } });
    const outcome = call.then(() => undefined, error => error);
    await new Promise(r => setTimeout(r, 75));
    if (change === 'revoked') authorized = false;
    else identity = { ...identity!, turnId: 'schedule:two', sessionOrigin: { ...identity!.sessionOrigin!,
      execution: { ...identity!.sessionOrigin!.execution!, executionId: 'execution-two', turnId: 'schedule:two' } } };
    expect(await outcome).toBeInstanceOf(Error);
    expect((await outcome).message).toMatch(/read.only|turn/i);
  });

  it.skipIf(!linuxSandbox).each([false, true])('real strict sandbox reaches only the read gateway socket and cannot read/write plugin credentials or descriptors (tmux args=%s)', async useBwrapArgsFile => {
    manifest();
    const privateFile = join(pluginPrivateDir('reader'), 'cookie');
    writeFileSync(privateFile, 'private-fixture-cookie');
    const privatePaths = [privateFile, sessionMcpRuntimeManifestPath('strict-reader', dataDir)];
    const host = await startSessionMcpGatewayHost({ sessionId: 'strict-reader', dataDir,
      trustedTurnIdentity: () => identity, readOnly: { tools: policy, authorize: () => authorized } });
    let sandbox: ReturnType<typeof prepareDirectSandbox>;
    const root = realpathSync(home);
    const code = `
      const fs = require('node:fs'), net = require('node:net');
      for (const p of ${JSON.stringify(privatePaths)}) {
        try { fs.readFileSync(p); process.exit(41); } catch {}
        try { fs.writeFileSync(p, 'changed'); process.exit(42); } catch {}
      }
      const auth = fs.readFileSync(${JSON.stringify(mcpGatewayAuthTokenPath(host.socketPath))}, 'utf8').trim();
      const socket = net.createConnection(${JSON.stringify(host.socketPath)});
      const timer = setTimeout(() => process.exit(43), 8000);
      let buffer = '', authed = false;
      const send = value => socket.write(JSON.stringify(value) + '\\n');
      socket.on('error', () => process.exit(44));
      socket.on('connect', () => socket.write(${JSON.stringify(MCP_GATEWAY_HANDSHAKE_PREFIX)} + auth + '\\n'));
      socket.on('data', chunk => {
        buffer += chunk.toString();
        while (buffer.includes('\\n')) {
          const at = buffer.indexOf('\\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (!authed) {
            if (line !== ${JSON.stringify(MCP_GATEWAY_HANDSHAKE_OK)}) process.exit(45);
            authed = true; send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'kernel-probe',version:'1'}}});
            continue;
          }
          const response = JSON.parse(line);
          if (response.error) process.exit(46);
          if (response.id === 1) { send({jsonrpc:'2.0',method:'notifications/initialized'}); send({jsonrpc:'2.0',id:2,method:'tools/list'}); }
          if (response.id === 2) {
            if (JSON.stringify(response.result.tools.map(t => t.name)) !== '["echo"]') process.exit(47);
            send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'echo',arguments:{}}});
          }
          if (response.id === 3) { if (!JSON.stringify(response.result).includes('fixture:echo')) process.exit(48); clearTimeout(timer); socket.destroy(); console.log('PASS'); }
        }
      });`;
    try {
      const protectedDenyPaths = [pluginsHome(), sessionMcpRuntimeManifestPath('strict-reader', dataDir)];
      const fsPolicy = buildFsPolicy({ platform: 'linux', homeDir: root, botmuxHome: join(root, '.botmux'), sessionDataDir: dataDir,
        workingDir: root, botmuxInstallRoot: root, botHome: join(root, '.botmux/bots/app'), sessionId: 'strict-reader', currentAppId: 'app', redirectedCliData: true,
        protectedDenyPaths, mandatoryReadOnlyPaths: [host.socketDir, privateFile, dirname(process.execPath)],
        userPaths: { readWrite: [root, pluginsHome()] } });
      fsPolicy.rules = fsPolicy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));
      sandbox = prepareDirectSandbox({ sessionId: 'strict-reader', dataDir, policy: fsPolicy, home: root, chdir: '/', bytedcliBroker: true,
        useBwrapArgsFile, mcpGatewaySocketPath: host.socketPath, cliBin: process.execPath, cliArgs: ['-e', code] });
      expect(sandbox).not.toBeNull();
      const child = spawn(sandbox!.bin, sandbox!.args, { env: { PATH: '/usr/bin:/bin', HOME: root, ...sandbox!.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout!.on('data', chunk => output += chunk); child.stderr!.on('data', chunk => errors += chunk);
      const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
      expect(exit, errors).toBe(0); expect(output).toContain('PASS');
    } finally { sandbox?.cleanup(); await host.close(); }
  });
});
