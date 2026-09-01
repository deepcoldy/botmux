import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareDirectSandbox, probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import { buildFsPolicy } from '../src/adapters/cli/fs-policy.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { ensureGatewayEntry } from '../src/core/plugins/mcp/gateway-installer.js';
import {
  MCP_GATEWAY_DATA_DIR_ENV,
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SESSION_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../src/core/plugins/mcp/environment.js';
import {
  startSessionMcpGatewayHost,
  type SessionMcpGatewayHost,
} from '../src/core/plugins/mcp/host.js';
import { pluginMcpPrivatePath } from '../src/core/plugins/paths.js';
import {
  refreshSessionMcpRuntimeManifest,
  sessionMcpRuntimeManifestPath,
} from '../src/core/plugins/mcp/session-runtime.js';

const builtCli = resolve('dist/cli.js');

// bwrap being installed is not enough: unprivileged user-namespace creation is
// disabled on many CI runners (GitHub Actions), where bwrap dies with
// "setting up uid map: Permission denied". Gate on the SAME runtime probe the
// worker uses so these real-sandbox specs skip (not fail) where the kernel
// won't let bwrap establish namespaces, while still running on capable hosts.
const bwrapUsable = probeHostCredentialIsolationMechanism().mechanism === 'bwrap';

function codexForwardedEnvKeys(configPath: string): string[] {
  const match = readFileSync(configPath, 'utf8').match(/^env_vars = (\[[^\n]+])$/m);
  if (!match) throw new Error('generated Codex Gateway entry has no env_vars');
  return JSON.parse(match[1]) as string[];
}

describe.skipIf(process.platform !== 'linux' || !existsSync(builtCli) || !bwrapUsable)('plugin MCP Gateway sandbox integration', () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-mcp-sandbox-'));
    home = join(root, 'home');
    dataDir = join(home, '.botmux', 'data');
    project = join(root, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['default', 'custom'] as const)(
    'relays a session MCP through the trusted host without exposing descriptors in bwrap (%s data dir)',
    async (dataDirMode) => {
      if (dataDirMode === 'custom') {
        dataDir = join(root, 'custom-botmux-home', 'data');
        mkdirSync(dataDir, { recursive: true });
        vi.stubEnv('SESSION_DATA_DIR', dataDir);
      }
      const sessionId = `mcp-sandbox-${Math.random().toString(36).slice(2)}`;
      const siblingSessionId = `${sessionId}-sibling`;
      const pluginId = 'plugin-a';
      const source = join(root, 'plugin-source');
      const fixture = resolve('test/fixtures/plugin-mcp-server.mjs');
      mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
      writeFileSync(join(source, 'package.json'), JSON.stringify({
        name: '@botmux-ai/plugin-plugin-a',
        version: '0.1.0',
        type: 'module',
        keywords: ['botmux-plugin'],
        botmux: { schemaVersion: 1, id: pluginId },
      }));
      writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
        transport: 'stdio',
        command: [process.execPath, fixture, 'alpha'],
        env: { PRIVATE_MCP_TOKEN: 'host-only-token' },
      }));
      installLocalPlugin(source);

      refreshSessionMcpRuntimeManifest({
        sessionId: siblingSessionId,
        pluginIds: [pluginId],
        dataDir,
      });
      refreshSessionMcpRuntimeManifest({
        sessionId,
        pluginIds: [pluginId],
        dataDir,
      });

      const gatewayBin = join(home, '.botmux', 'bin', 'botmux');
      const codexConfig = join(root, 'codex-config.toml');
      mkdirSync(join(home, '.botmux', 'bin'), { recursive: true });
      writeFileSync(gatewayBin, '#!/bin/sh\nexit 99\n');
      chmodSync(gatewayBin, 0o755);
      const installReport = ensureGatewayEntry({
        id: 'codex',
        mcpGateway: { format: 'codex-toml', configPath: codexConfig },
      }, {
        command: gatewayBin,
        args: ['mcp', 'serve'],
      });
      expect(installReport.state).toBe('installed');
      const forwardedKeys = codexForwardedEnvKeys(codexConfig);

      let gatewayHost: SessionMcpGatewayHost | null = null;
      let sandbox: ReturnType<typeof prepareDirectSandbox> = null;
      let client: Client | null = null;
      let transport: StdioClientTransport | null = null;
      try {
        gatewayHost = await startSessionMcpGatewayHost({ sessionId, dataDir });
        const hostOnlyPaths = [
          sessionMcpRuntimeManifestPath(sessionId, dataDir),
          sessionMcpRuntimeManifestPath(siblingSessionId, dataDir),
          pluginMcpPrivatePath(pluginId),
          join(home, '.botmux', 'plugins', pluginId, 'dist', 'mcp', 'index.json'),
        ];
        const botmuxHome = join(dataDir, '..');
        const botHome = join(botmuxHome, 'bots', 'cli_test');
        const outbox = join(dataDir, 'sandboxes', sessionId, 'outbox');
        mkdirSync(botHome, { recursive: true });
        mkdirSync(outbox, { recursive: true });
        const policy = buildFsPolicy({
          platform: 'linux',
          homeDir: home,
          botmuxHome,
          sessionDataDir: dataDir,
          workingDir: project,
          currentAppId: 'cli_test',
          botHome,
          redirectedCliData: true,
          execPaths: [dirname(process.execPath)],
          botmuxInstallRoot: resolve('.'),
          outbox,
          mandatoryDenyPaths: hostOnlyPaths,
        });
        policy.rules = policy.rules.filter(rule =>
          rule.access === 'deny' || existsSync(rule.path));
        sandbox = prepareDirectSandbox({
          sessionId,
          dataDir,
          policy,
          chdir: project,
          home,
          cliBin: gatewayBin,
          cliArgs: ['mcp', 'serve'],
          trustedBotmuxCommandPaths: [gatewayBin],
          mcpGatewaySocketPath: gatewayHost.socketPath,
        });
        if (!sandbox) return; // Required Linux sandbox runtime is unavailable.

        const commandIndex = sandbox.args.lastIndexOf('--');
        expect(commandIndex).toBeGreaterThanOrEqual(0);
        const probe = spawnSync(
          sandbox.bin,
          [
            ...sandbox.args.slice(0, commandIndex + 1),
            '/bin/sh',
            '-c',
            'for path do test ! -r "$path" || { printf "readable:%s\\n" "$path" >&2; exit 78; }; done',
            'verify-host-only-mcp-state',
            ...hostOnlyPaths,
          ],
          {
            cwd: project,
            env: { ...process.env, ...sandbox.env },
            encoding: 'utf8',
            timeout: 10_000,
          },
        );
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);

        const parentGatewayEnv: Record<string, string> = {
          [MCP_GATEWAY_SESSION_ENV]: sessionId,
          [MCP_GATEWAY_DATA_DIR_ENV]: dataDir,
          [MCP_GATEWAY_SOCKET_ENV]: gatewayHost.socketPath,
          [MCP_GATEWAY_REQUIRED_ENV]: '1',
        };
        const nativeLauncherEnv = Object.fromEntries(
          forwardedKeys.flatMap(key => parentGatewayEnv[key] === undefined ? [] : [[key, parentGatewayEnv[key]]]),
        );
        expect(nativeLauncherEnv).toEqual(parentGatewayEnv);

        transport = new StdioClientTransport({
          command: sandbox.bin,
          args: sandbox.args,
          cwd: project,
          env: {
            HOME: home,
            USERPROFILE: home,
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...nativeLauncherEnv,
            ...sandbox.env,
          },
          stderr: 'pipe',
        });
        client = new Client({ name: 'sandbox-gateway-test', version: '1.0.0' });
        await client.connect(transport);

        expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['alpha_unique', 'echo']);
        const result = await client.callTool({ name: 'echo', arguments: { value: 1 } });
        const echoed = (result.content[0] as { text: string }).text;
        // #917 fixture 回显 `_meta`，不再与 session 字段连成一段。
        expect(echoed).toContain('alpha:echo:{"value":1}');
        expect(echoed).toContain(`session=${sessionId}:token=host-only-token`);
      } finally {
        if (client) await client.close().catch(() => undefined);
        else if (transport) await transport.close().catch(() => undefined);
        if (gatewayHost) await gatewayHost.close().catch(() => undefined);
        if (sandbox) sandbox.cleanup();
      }
    },
    30_000,
  );

  // Regression: the sandbox PATH must resolve bare `node` even when the host's
  // lexical $PATH points ONLY at symlink-form dirs that don't exist in the fresh
  // root (shared drive / ~/.local/bin symlink / fnm / nvm). Before the fix the
  // trusted `botmux` shim's `exec node` failed `not found` → MCP gateway exited
  // → Connection closed. The fix prepends dirname(realpath(process.execPath)).
  it('resolves bare `node` under a hostile symlink-form host PATH (canonical exec dir prepended)', () => {
    const botmuxHome = join(dataDir, '..');
    const botHome = join(botmuxHome, 'bots', 'cli_test');
    const outbox = join(dataDir, 'sandboxes', 'sid-path', 'outbox');
    mkdirSync(botHome, { recursive: true });
    mkdirSync(outbox, { recursive: true });
    const policy = buildFsPolicy({
      platform: 'linux', homeDir: home, botmuxHome, sessionDataDir: dataDir,
      workingDir: project, currentAppId: 'cli_test', botHome, redirectedCliData: true,
      execPaths: [dirname(process.execPath)], botmuxInstallRoot: resolve('.'), outbox,
    });
    policy.rules = policy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));

    // A PATH that leaves bare `node` unresolvable in the fresh root: a
    // nonexistent symlink-form dir + the fixed system dirs (which have bwrap but
    // NOT this test runner's node — its canonical dir is under ~/.local/share).
    // Keep /usr/bin & /bin so ensureSandboxDeps still finds bwrap on the host.
    vi.stubEnv('PATH', '/home/nonexistent/.local/bin:/usr/bin:/bin');
    const sandbox = prepareDirectSandbox({
      sessionId: 'sid-path', dataDir, policy, chdir: project, home,
      cliBin: process.execPath, cliArgs: [],
    });
    if (!sandbox) return; // sandbox runtime unavailable
    try {
      const canonicalNodeDir = dirname(require('node:fs').realpathSync(process.execPath));
      // PATH prepends the canonical node dir (shim dir stays first)
      const dirs = sandbox.env.PATH.split(':');
      expect(dirs[0]).toBe('/run/sbxbin');
      expect(dirs).toContain(canonicalNodeDir);
      expect(dirs.indexOf(canonicalNodeDir)).toBeLessThan(dirs.indexOf('/home/nonexistent/.local/bin'));
      // and bare `node` actually runs inside the real sandbox
      const commandIndex = sandbox.args.lastIndexOf('--');
      const probe = spawnSync(sandbox.bin, [
        ...sandbox.args.slice(0, commandIndex + 1),
        '/bin/sh', '-c', 'command -v node >/dev/null && node -e "process.exit(0)"',
      ], { cwd: project, env: { ...process.env, ...sandbox.env }, encoding: 'utf8', timeout: 10_000 });
      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
    } finally {
      sandbox.cleanup();
    }
  });
});
