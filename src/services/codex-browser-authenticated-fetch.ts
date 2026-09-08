import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { materializeBrowserFetchService } from './codex-browser-fetch-service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Json = Record<string, any>;
interface Options {
  readConfig: () => Promise<Json>;
  requestMeta: () => Record<string, string>;
  codexBin?: string;
}

interface RuntimeConfig { command: string; args?: string[]; env?: Record<string, string> }

/** The desktop app rewrites its MCP configuration as tool availability changes.
 * Absence of an MCP registration does not mean the bundled runtime is absent. */
export function resolveBrowserFetchRuntime(config: Json, candidates?: string[]): RuntimeConfig {
  const configured = config.mcp_servers?.node_repl;
  if (configured && typeof configured.command === 'string' && isAbsolute(configured.command)
    && existsSync(configured.command)) return configured;

  const override = process.env.BOTMUX_CODEX_NODE_REPL_PATH?.trim();
  const paths = candidates ?? (override ? [override] : [
    '/usr/lib/chatgpt/resources/cua_node/bin/node_repl',
    '/opt/ChatGPT/resources/cua_node/bin/node_repl',
    '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl',
    '/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl'),
    join(homedir(), 'Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl'),
  ]);
  for (const command of paths) {
    if (!isAbsolute(command) || !existsSync(command)) continue;
    const node = join(dirname(command), process.platform === 'win32' ? 'node.exe' : 'node');
    if (!existsSync(node)) continue;
    return { command, args: [], env: { NODE_REPL_NODE_PATH: node } };
  }
  throw new Error('Codex browser authenticated runtime was not found; install the Codex desktop runtime or set BOTMUX_CODEX_NODE_REPL_PATH to its node_repl executable');
}

/** Use the same authenticated fetch implementation as the installed browser
 * plugin. Plain Node fetch cannot substitute for the Codex trusted runtime:
 * identity, site-status and rollout requests need its authentication policy. */
export class CodexBrowserAuthenticatedFetch {
  private client?: Client;
  private transport?: StdioClientTransport;
  private starting?: Promise<Client>;
  private closed = false;
  private disposeService?: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: Options) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = Buffer.from(await request.arrayBuffer());
    const payload = {
      method: 'fetch',
      params: {
        url: request.url,
        method: request.method,
        headers: [...request.headers.entries()],
        ...(body.length ? { body: body.toString('base64') } : {}),
      },
    };
    const client = await this.getClient();
    request.signal.throwIfAborted();
    const run = async () => {
      request.signal.throwIfAborted();
      if (this.closed) throw new Error('Codex browser authenticated runtime is closed');
      return client.callTool({
        name: 'js',
        arguments: {
          code: `nodeRepl.write(JSON.stringify(await nodeRepl.rpc("botmux_browser_fetch", ${JSON.stringify(payload)})));`,
          title: 'Botmux browser authenticated request',
          timeout_ms: 35_000,
        },
        _meta: this.options.requestMeta(),
      }, undefined, { timeout: 40_000, signal: request.signal });
    };
    // A single runtime owns one JS execution at a time. Browser initialization
    // starts identity and rollout fetches concurrently, so serialize only this
    // transport while preserving the callers' individual abort signals.
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    const result = await pending;
    const text = Array.isArray(result.content)
      ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      : '';
    // Never fall back to an unauthenticated request or include a response body
    // in a model-visible error; identity responses can contain private data.
    if (result.isError) throw new Error('Codex browser authenticated request failed; check the Codex login and runtime connection');
    let response: Json;
    try { response = JSON.parse(text); }
    catch { throw new Error('Codex browser authenticated runtime returned an invalid response'); }
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599
      || !Array.isArray(response.headers) || typeof response.body !== 'string') {
      throw new Error('Codex browser authenticated runtime returned an invalid response');
    }
    return new Response([204, 205, 304].includes(response.status) ? null : Buffer.from(response.body, 'base64'), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  private async getClient(): Promise<Client> {
    if (this.closed) throw new Error('Codex browser authenticated runtime is closed');
    if (this.client) return this.client;
    const starting = this.starting ??= this.start();
    try { return await starting; }
    catch (error) {
      if (this.starting === starting) this.starting = undefined;
      throw error;
    }
  }

  private async start(): Promise<Client> {
    const result = await this.options.readConfig();
    const runtime = resolveBrowserFetchRuntime(result.config ?? {});
    if (this.closed) throw new Error('Codex browser authenticated runtime is closed');
    const serviceModule = materializeBrowserFetchService();
    const service = serviceModule.path;
    this.disposeService = serviceModule.dispose;
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
    try {
      const env = { ...getDefaultEnvironment() };
      for (const [key, value] of Object.entries(runtime.env ?? {})) {
        if (typeof value === 'string') env[key] = value;
      }
      env.CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
      if (this.options.codexBin) env.CODEX_CLI_PATH = this.options.codexBin;
      // Scope the extra trusted code entry to this single transport module. Do
      // not grant trust to the checkout, working directory, or model input.
      env.NODE_REPL_TRUSTED_CODE_PATHS = [env.NODE_REPL_TRUSTED_CODE_PATHS, service].filter(Boolean).join(delimiter);
      env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({ botmux_browser_fetch: service });
      transport = new StdioClientTransport({
        command: runtime.command,
        args: Array.isArray(runtime.args) ? runtime.args : [],
        env,
        stderr: 'pipe',
      });
      // Drain diagnostics without forwarding credentials or server bodies into
      // a Lark transcript. Errors are reported via the structured MCP response.
      transport.stderr?.on('data', () => {});
      client = new Client({ name: 'botmux-browser-fetch', version: '1.0.0' }, { capabilities: {} });
      const connectedClient = client;
      client.onclose = () => {
        serviceModule.dispose();
        if (this.client === connectedClient) {
          this.client = undefined;
          this.starting = undefined;
          this.transport = undefined;
        }
      };
      this.transport = transport;
      await client.connect(transport, { timeout: 10_000 });
      if (this.closed) throw new Error('Codex browser authenticated runtime is closed');
      this.client = client;
      return client;
    } catch (error) {
      await client?.close().catch(() => {});
      serviceModule.dispose();
      if (this.transport === transport) this.transport = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.transport?.close(); }
    finally {
      this.disposeService?.();
      this.disposeService = undefined;
      this.client = undefined;
      this.transport = undefined;
    }
  }
}
