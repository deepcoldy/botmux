import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { snapshotBytedcliRuntimeTrees } from './bytedcli-runtime-integrity.js';
import { bytedcliMinimalEnv, BytedcliBrokerError, type BytedcliTrustedCli } from './bytedcli-broker-process.js';
import { isolateBytedcliInvocation } from './bytedcli-isolated-process.js';
import type { BytedcliHostApiRunner } from './bytedcli-skill-api-transport.js';
export function discoverSkillMcpRuntime(packageRoot: string | undefined, node: string): BytedcliTrustedCli | undefined {
  if (!packageRoot) return undefined;
  try {
    if (!isAbsolute(packageRoot) || !isAbsolute(node)) return undefined;
    const root = realpathSync(packageRoot), executable = realpathSync(node), entry = join(root, 'dist/index.js');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== '@byted/mcp-proxy' || manifest.version !== '1.3.21' || manifest.bin?.['mcp-proxy'] !== 'dist/index.js') return undefined;
    const frozen = snapshotBytedcliRuntimeTrees(entry, root, executable);
    return Object.freeze({ executable, prefixArgs: Object.freeze([entry]), path: dirname(executable), version: '0.199.0',
      protectedPaths: frozen.protectedPaths, stillCurrent: frozen.stillCurrent });
  } catch { return undefined; }
}
/** Fixed one-tool JSON-RPC protocol. The pinned proxy may discover its fixed server tools at startup; no caller-selected tools, downloads, profile/cookie
 * lookup, inherited env or general MCP execution. Reuses executor ownership. */
export function createSkillMcpRunner(runtime: BytedcliTrustedCli | undefined, network: Readonly<NodeJS.ProcessEnv>): BytedcliHostApiRunner {
  return async input => {
    if (!runtime || !runtime.stillCurrent() || !input.requestRoot || !input.home || !input.cwd) throw new BytedcliBrokerError('executor_unavailable');
    if (input.descriptor.id !== 'skill-api.oncall.knowledge.search' || input.lease.realm && input.lease.realm !== 'bytecloud') throw new BytedcliBrokerError('unsupported_operation');
    const invocation = isolateBytedcliInvocation({ executable: runtime.executable, argv: runtime.prefixArgs!, cwd: input.cwd,
      env: { ...bytedcliMinimalEnv(input.home, input.cwd, runtime.path, network), USER_JWT_TOKEN: input.lease.jwt,
        MCP_SERVER_PSM: 'bytedance.mcp.ecom_marketing_rd_platform', MCP_GATEWAY_REGION: 'CN',
        MCP_SERVER_TOOL_ALLOW_LIST: 'ecom_marketing_rd_platform_retrieval_knowledge', MCP_REQUEST_TIMEOUT_MS: '20000', LOG_LEVEL: 'error' },
      signal: input.signal, timeoutMs: 30000, outputLimitBytes: input.outputLimitBytes }, runtime, input.requestRoot);
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, [...invocation.argv], { cwd: invocation.cwd, env: { ...invocation.env }, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffered = '', size = 0, initialized = false, failure: Error | undefined, result: unknown;
      const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* reaped */ } child.stdin.destroy(); };
      const fail = (error: Error) => { failure ??= error; kill(); };
      const abort = () => fail(new BytedcliBrokerError('cancelled'));
      input.signal.addEventListener('abort', abort, { once: true }); if (input.signal.aborted) abort();
      const timer = setTimeout(() => fail(new BytedcliBrokerError('timeout')), 30000);
      const send = (body: unknown) => child.stdin.write(JSON.stringify(body) + '\n');
      child.once('spawn', () => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'botmux-managed-oncall', version: '1' } } }));
      const collect = (chunk: Buffer) => { size += chunk.length; if (size > input.outputLimitBytes || !input.reserveOutput(chunk.length)) fail(new BytedcliBrokerError('output_limit')); };
      child.stderr.on('data', collect); // Never return upstream logs (may include JWT).
      child.stdout.on('data', (chunk: Buffer) => {
        collect(chunk); if (failure) return; buffered += chunk.toString('utf8');
        for (;;) {
          const end = buffered.indexOf('\n'); if (end < 0) break;
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          let message: any; try { message = JSON.parse(line); } catch { fail(new BytedcliBrokerError('upstream_failed')); break; }
          if (message.error) { fail(new BytedcliBrokerError('upstream_failed')); break; }
          if (message.id === 1 && !initialized) {
            initialized = true;
            if (!runtime.stillCurrent()) { fail(new BytedcliBrokerError('executor_unavailable')); break; }
            send({ jsonrpc: '2.0', method: 'notifications/initialized' }); input.onDispatch();
            send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ecom_marketing_rd_platform_retrieval_knowledge', arguments: input.descriptor.body } });
          } else if (message.id === 2 && initialized) {
            if (message.result?.isError) { fail(new BytedcliBrokerError('upstream_failed')); break; }
            result = message.result; kill();
          }
        }
      });
      child.once('error', () => fail(new BytedcliBrokerError('executor_unavailable')));
      child.stdin.on('error', () => fail(new BytedcliBrokerError('upstream_failed')));
      child.once('close', () => {
        clearTimeout(timer); input.signal.removeEventListener('abort', abort);
        if (failure || result === undefined || !runtime.stillCurrent()) reject(failure ?? new BytedcliBrokerError('upstream_failed'));
        else resolve({ stdout: Buffer.from(JSON.stringify({ status: 'success', data: result }) + '\n'), stderr: Buffer.alloc(0), exitCode: 0 });
      });
    });
  };
}
