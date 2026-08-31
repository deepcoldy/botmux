import { createHash } from 'node:crypto';
import { createConnection, type Socket as NetSocket } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  RootsListChangedNotificationSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  UnsubscribeRequestSchema,
  type ClientCapabilities,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveBotmuxDataDir } from '../../data-dir.js';
import { readGlobalConfig } from '../../../global-config.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { resolveSessionContext } from '../../session-marker.js';
import { normalizePluginIdList } from '../ids.js';
import { pluginHome, pluginRuntimeDir, resolvePluginPath } from '../paths.js';
import { readSessionPluginManifest } from '../session-manifest.js';
import {
  readSessionMcpRuntimeManifest,
  type SessionMcpRuntimeManifest,
} from './session-runtime.js';
import { readPluginMcpDescriptor } from './private-store.js';
import type { PluginMcpServer } from '../types.js';
import type { TrustedCaller } from '../../../types.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from './environment.js';
import { readMcpGatewayAuthToken, sendMcpGatewayHandshake } from './socket-auth.js';

const GATEWAY_VERSION = '1.0.0';
const DOWNSTREAM_INITIALIZE_TIMEOUT_MS = 10_000;

export function resolveGatewayEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  startPid: number = process.ppid,
): NodeJS.ProcessEnv {
  const sessionId = resolveSessionContext(
    gatewayDataDir(env),
    env.BOTMUX_SESSION_ID?.trim() || undefined,
    startPid,
  )?.sessionId.trim();
  return sessionId ? { ...env, BOTMUX_SESSION_ID: sessionId } : env;
}

interface GatewayDescriptor {
  key: string;
  routeName: string;
  pluginId: string;
  server: PluginMcpServer;
  pluginDir: string;
}

interface GatewayConnection extends GatewayDescriptor {
  client: Client;
  transport: Transport;
  capabilities: ServerCapabilities;
  uriPrefix: string;
}

interface NamedRoute {
  connection: GatewayConnection;
  originalName: string;
}

interface ResourceRoute {
  connection: GatewayConnection;
  originalUri: string;
  exposedUri: string;
  template?: UriTemplate;
}

export interface GatewayTrustedTurnIdentity {
  caller?: TrustedCaller;
  turnId?: string;
  dispatchAttempt?: number;
}

export type GatewayTrustedTurnIdentityProvider = () => GatewayTrustedTurnIdentity | undefined;

const BOTMUX_META_RESERVED_PREFIX = 'botmux';
const BOTMUX_TRUSTED_HEADER_PREFIX = 'x-botmux-trusted-';
const BOTMUX_TURN_HEADERS = [
  'x-botmux-turn-id',
  'x-botmux-dispatch-attempt',
] as const;

export interface McpGatewayDiagnostic {
  pluginId: string;
  serverName: string;
  status: 'connected' | 'failed';
  transport: PluginMcpServer['transport'];
  error?: string;
  tools?: number;
  prompts?: number;
  resources?: number;
}

export interface McpGatewayDiagnosticsFile {
  schemaVersion: 1;
  sessionId?: string;
  pluginIds: string[];
  generatedAt: string;
  servers: McpGatewayDiagnostic[];
}

interface GatewayInputLifecycle {
  readonly readableEnded?: boolean;
  readonly destroyed?: boolean;
  once(event: 'end' | 'close', listener: () => void): unknown;
}

export function bindGatewayInputLifecycle(
  input: GatewayInputLifecycle,
  closeGateway: () => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  const closeOnce = () => {
    closing ??= closeGateway();
    return closing;
  };
  const requestClose = () => { void closeOnce().catch(onError); };

  input.once('end', requestClose);
  input.once('close', requestClose);
  if (input.readableEnded || input.destroyed) queueMicrotask(requestClose);

  return closeOnce;
}

function gatewayPluginIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const sessionId = env.BOTMUX_SESSION_ID?.trim();
  if (sessionId) {
    const manifest = readSessionPluginManifest(sessionId, gatewayDataDir(env));
    if (manifest) return manifest.pluginIds;
  }
  return normalizePluginIdList(readGlobalConfig().plugins) ?? [];
}

function gatewayDataDir(env: NodeJS.ProcessEnv): string {
  return resolveBotmuxDataDir({ env });
}

function gatewayDescriptors(pluginIds: readonly string[]): GatewayDescriptor[] {
  const registry = readPluginRegistry();
  const descriptors: GatewayDescriptor[] = [];
  for (const pluginId of pluginIds) {
    const record = registry.plugins[pluginId];
    if (!record) continue;
    const contribution = record.contributions?.mcp;
    if (!contribution) continue;
    const server = readPluginMcpDescriptor(pluginId, contribution);
    descriptors.push({
      key: pluginId,
      pluginId,
      server,
      pluginDir: pluginRuntimeDir(pluginId),
      routeName: pluginId,
    });
  }
  return descriptors;
}

function snapshotGatewayDescriptors(snapshot: SessionMcpRuntimeManifest): GatewayDescriptor[] {
  return snapshot.entries.map(entry => ({
    key: entry.pluginId,
    routeName: entry.pluginId,
    pluginId: entry.pluginId,
    server: entry.server,
    pluginDir: entry.pluginDir,
  }));
}

function resolveGatewayRuntime(
  requestedPluginIds: string[] | undefined,
  env: NodeJS.ProcessEnv,
): { pluginIds: string[]; descriptors: GatewayDescriptor[] } {
  if (!requestedPluginIds) {
    const sessionId = env.BOTMUX_SESSION_ID?.trim();
    const snapshot = sessionId
      ? readSessionMcpRuntimeManifest(sessionId, gatewayDataDir(env))
      : null;
    if (snapshot) {
      return {
        pluginIds: snapshot.pluginIds,
        descriptors: snapshotGatewayDescriptors(snapshot),
      };
    }
  }
  const pluginIds = requestedPluginIds ?? gatewayPluginIds(env);
  return { pluginIds, descriptors: gatewayDescriptors(pluginIds) };
}

function diagnosticsPath(sessionId: string | undefined, dataDir: string): string {
  const safe = sessionId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)
    ? sessionId
    : 'standalone';
  return join(dataDir, 'mcp-gateway', `${safe}.json`);
}

function writeDiagnostics(file: McpGatewayDiagnosticsFile, dataDir: string): void {
  const path = diagnosticsPath(file.sessionId, dataDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

function resolveStdioCommand(descriptor: GatewayDescriptor): { command: string; args: string[] } {
  if (descriptor.server.transport !== 'stdio') throw new Error('not_stdio_server');
  const command = descriptor.server.command.map((part) => {
    if (!part.startsWith('./')) return part;
    const target = resolvePluginPath(descriptor.pluginDir, part, `mcp_command_${descriptor.server.name}`);
    if (!existsSync(target)) throw new Error(`plugin_mcp_command_path_not_found:${descriptor.server.name}:${part}`);
    return target;
  });
  return { command: command[0], args: command.slice(1) };
}

function uriPrefix(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return `botmux+${digest}:`;
}

function methodUnsupported(method: string): McpError {
  return new McpError(ErrorCode.MethodNotFound, `No enabled plugin MCP handles ${method}`);
}

async function allPages<T>(
  fetchPage: (cursor?: string) => Promise<Record<string, unknown>>,
  field: string,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await fetchPage(cursor);
    const values = page[field];
    if (Array.isArray(values)) out.push(...values as T[]);
    const next = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  } while (seen.size < 10_000);
  return out;
}

function allocateName(
  candidate: string,
  fallback: string,
  used: Set<string>,
): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  if (!used.has(fallback)) {
    used.add(fallback);
    return fallback;
  }
  let index = 2;
  while (used.has(`${fallback}__${index}`)) index += 1;
  const value = `${fallback}__${index}`;
  used.add(value);
  return value;
}

export class PluginMcpGateway {
  readonly server: Server;
  private readonly env: NodeJS.ProcessEnv;
  private readonly trustedTurnIdentity?: GatewayTrustedTurnIdentityProvider;
  private readonly pluginIds: string[];
  private readonly descriptors: GatewayDescriptor[];
  private readonly diagnostics: McpGatewayDiagnostic[] = [];
  private connections: GatewayConnection[] = [];
  private initializePromise?: Promise<void>;
  private toolRoutes = new Map<string, NamedRoute>();
  private promptRoutes = new Map<string, NamedRoute>();
  private resourceRoutes = new Map<string, ResourceRoute>();
  private resourceTemplateRoutes: ResourceRoute[] = [];

  constructor(
    pluginIds?: string[],
    env: NodeJS.ProcessEnv = process.env,
    opts: { trustedTurnIdentity?: GatewayTrustedTurnIdentityProvider } = {},
  ) {
    this.env = env;
    this.trustedTurnIdentity = opts.trustedTurnIdentity;
    const runtime = resolveGatewayRuntime(pluginIds, env);
    this.pluginIds = runtime.pluginIds;
    this.descriptors = runtime.descriptors;
    this.server = new Server(
      { name: 'botmux', version: GATEWAY_VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
          completions: {},
          logging: {},
        },
        instructions: 'Aggregates MCP servers contributed by the plugins enabled for this Botmux session.',
      },
    );
    this.registerHandlers();
    this.server.oninitialized = () => { void this.ensureInitialized(); };
    this.server.onclose = () => { void this.closeDownstreams(); };
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.closeDownstreams();
    await this.server.close();
  }

  private async closeDownstreams(): Promise<void> {
    if (this.initializePromise) await this.initializePromise.catch(() => undefined);
    await Promise.allSettled(this.connections.map(connection => connection.client.close()));
    this.connections = [];
  }

  private persistDiagnostics(): void {
    try {
      writeDiagnostics({
        schemaVersion: 1,
        sessionId: this.env.BOTMUX_SESSION_ID?.trim() || undefined,
        pluginIds: this.pluginIds,
        generatedAt: new Date().toISOString(),
        servers: this.diagnostics,
      }, gatewayDataDir(this.env));
    } catch (error) {
      process.stderr.write(
        `[botmux-mcp] diagnostics write skipped: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.initializeDownstreams();
    return this.initializePromise;
  }

  private async initializeDownstreams(): Promise<void> {
    const { tasks: _tasks, ...clientCapabilities } = this.server.getClientCapabilities() ?? {};
    const settled = await Promise.all(this.descriptors.map(descriptor => this.connectDownstream(descriptor, clientCapabilities)));
    this.connections = settled.filter((value): value is GatewayConnection => value !== null);
    this.persistDiagnostics();
  }

  private async connectDownstream(
    descriptor: GatewayDescriptor,
    clientCapabilities: ClientCapabilities,
  ): Promise<GatewayConnection | null> {
    let transport: Transport;
    try {
      if (descriptor.server.transport === 'stdio') {
        const resolved = resolveStdioCommand(descriptor);
        transport = new StdioClientTransport({
          command: resolved.command,
          args: resolved.args,
          cwd: descriptor.pluginDir,
          env: {
            ...getDefaultEnvironment(),
            ...descriptor.server.env,
            BOTMUX_PLUGIN_ID: descriptor.pluginId,
            BOTMUX_PLUGIN_DIR: descriptor.pluginDir,
            BOTMUX_PLUGIN_HOME: pluginHome(descriptor.pluginId),
            ...(this.env.BOTMUX_SESSION_ID ? { BOTMUX_SESSION_ID: this.env.BOTMUX_SESSION_ID } : {}),
          },
          stderr: 'inherit',
        });
      } else {
        const staticHeaders = descriptor.server.headers;
        transport = new StreamableHTTPClientTransport(new URL(descriptor.server.url), {
          requestInit: staticHeaders ? { headers: staticHeaders } : undefined,
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: this.httpHeaders(init?.headers, staticHeaders),
          }),
        });
      }

      const client = new Client(
        { name: `botmux/${descriptor.key}`, version: GATEWAY_VERSION },
        {
          capabilities: clientCapabilities,
          listChanged: {
            tools: { onChanged: async () => { this.toolRoutes.clear(); await this.server.sendToolListChanged(); } },
            prompts: { onChanged: async () => { this.promptRoutes.clear(); await this.server.sendPromptListChanged(); } },
            resources: {
              onChanged: async () => {
                this.resourceRoutes.clear();
                this.resourceTemplateRoutes = [];
                await this.server.sendResourceListChanged();
              },
            },
          },
        },
      );
      this.registerReverseHandlers(client, clientCapabilities);
      client.setNotificationHandler(LoggingMessageNotificationSchema, notification => this.server.sendLoggingMessage(notification.params));
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
        const mapped = this.mapDownstreamUri(descriptor.key, notification.params.uri);
        await this.server.sendResourceUpdated({ ...notification.params, uri: mapped });
      });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.toolRoutes.clear();
        await this.server.sendToolListChanged();
      });
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        this.promptRoutes.clear();
        await this.server.sendPromptListChanged();
      });
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        this.resourceRoutes.clear();
        this.resourceTemplateRoutes = [];
        await this.server.sendResourceListChanged();
      });
      await client.connect(transport, { timeout: DOWNSTREAM_INITIALIZE_TIMEOUT_MS });
      const connection: GatewayConnection = {
        ...descriptor,
        client,
        transport,
        capabilities: client.getServerCapabilities() ?? {},
        uriPrefix: uriPrefix(descriptor.key),
      };
      this.diagnostics.push({
        pluginId: descriptor.pluginId,
        serverName: descriptor.server.name,
        status: 'connected',
        transport: descriptor.server.transport,
      });
      return connection;
    } catch (err) {
      this.diagnostics.push({
        pluginId: descriptor.pluginId,
        serverName: descriptor.server.name,
        status: 'failed',
        transport: descriptor.server.transport,
        error: err instanceof Error ? err.message : String(err),
      });
      process.stderr.write(`[botmux-mcp] ${descriptor.key} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  }

  private registerReverseHandlers(client: Client, capabilities: ClientCapabilities): void {
    if (capabilities.sampling) {
      client.setRequestHandler(CreateMessageRequestSchema, request => this.server.createMessage(request.params));
    }
    if (capabilities.elicitation) {
      client.setRequestHandler(ElicitRequestSchema, request => this.server.elicitInput(request.params));
    }
    if (capabilities.roots) {
      client.setRequestHandler(ListRootsRequestSchema, request => this.server.listRoots(request.params));
    }
  }

  private requestOptions(request: { params?: { _meta?: { progressToken?: string | number } } }, extra: { signal: AbortSignal }) {
    const token = request.params?._meta?.progressToken;
    return {
      signal: extra.signal,
      resetTimeoutOnProgress: true,
      ...(token === undefined ? {} : {
        onprogress: (progress: { progress: number; total?: number; message?: string }) => {
          void this.server.notification({ method: 'notifications/progress', params: { progressToken: token, ...progress } });
        },
      }),
    };
  }

  private trustedTurnMeta(): Record<string, unknown> | undefined {
    const identity = this.trustedTurnIdentity?.();
    const caller = identity?.caller;
    if (!caller && !identity?.turnId) return undefined;
    return {
      ...(caller?.requestUserOpenId ? { requestUserOpenId: caller.requestUserOpenId } : {}),
      ...(caller?.requestUserUnionId ? { requestUserUnionId: caller.requestUserUnionId } : {}),
      ...(caller?.requestLarkAppId ? { requestLarkAppId: caller.requestLarkAppId } : {}),
      // Provenance travels with the identity so a plugin can tell "a human just
      // asked" from "a scheduled task is running as them". Deliberately NOT
      // mirrored into the `x-botmux-trusted-*` HTTP headers: those go to every
      // HTTP-transport MCP server, and widening what they carry widens what an
      // unrelated (possibly remote) plugin learns about the caller.
      ...(caller?.source ? { source: caller.source } : {}),
      ...(caller?.taskId ? { taskId: caller.taskId } : {}),
      ...(identity?.turnId ? { turnId: identity.turnId } : {}),
      ...(identity?.dispatchAttempt !== undefined ? { dispatchAttempt: identity.dispatchAttempt } : {}),
    };
  }

  private withTrustedTurnMeta<T extends { _meta?: Record<string, unknown> }>(params: T): T {
    const trusted = this.trustedTurnMeta();
    const cleanedMeta = Object.fromEntries(
      Object.entries(params._meta ?? {})
        .filter(([key]) => !key.toLowerCase().startsWith(BOTMUX_META_RESERVED_PREFIX)),
    );
    if (!trusted) {
      return Object.keys(cleanedMeta).length > 0
        ? { ...params, _meta: cleanedMeta }
        : { ...params, _meta: undefined };
    }
    return {
      ...params,
      _meta: {
        ...cleanedMeta,
        botmuxTrustedCaller: trusted,
      },
    };
  }

  private httpHeaders(
    initHeaders: HeadersInit | undefined,
    staticHeaders: Record<string, string> | undefined,
  ): Headers {
    const headers = new Headers(staticHeaders);
    if (initHeaders) {
      new Headers(initHeaders).forEach((value, key) => headers.set(key, value));
    }
    for (const key of Array.from(headers.keys())) {
      const lower = key.toLowerCase();
      if (lower.startsWith(BOTMUX_TRUSTED_HEADER_PREFIX) || (BOTMUX_TURN_HEADERS as readonly string[]).includes(lower)) {
        headers.delete(key);
      }
    }
    const trusted = this.trustedTurnMeta();
    if (trusted?.requestUserOpenId) headers.set('x-botmux-trusted-open-id', String(trusted.requestUserOpenId));
    if (trusted?.requestUserUnionId) headers.set('x-botmux-trusted-union-id', String(trusted.requestUserUnionId));
    if (trusted?.requestLarkAppId) headers.set('x-botmux-trusted-app-id', String(trusted.requestLarkAppId));
    if (trusted?.turnId) headers.set('x-botmux-turn-id', String(trusted.turnId));
    if (trusted?.dispatchAttempt !== undefined) headers.set('x-botmux-dispatch-attempt', String(trusted.dispatchAttempt));
    return headers;
  }

  private capable(capability: keyof ServerCapabilities): GatewayConnection[] {
    return this.connections.filter(connection => connection.capabilities[capability] !== undefined);
  }

  private async refreshTools(): Promise<any[]> {
    await this.ensureInitialized();
    const entries: Array<{ connection: GatewayConnection; tool: any }> = [];
    for (const connection of this.capable('tools')) {
      try {
        const tools = await allPages<any>(cursor => connection.client.listTools(cursor ? { cursor } : {}) as any, 'tools');
        entries.push(...tools.map(tool => ({ connection, tool })));
        const diagnostic = this.diagnostics.find(item => item.status === 'connected' && item.pluginId === connection.pluginId && item.serverName === connection.server.name);
        if (diagnostic) diagnostic.tools = tools.length;
      } catch (err) {
        process.stderr.write(`[botmux-mcp] ${connection.key} tools/list failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    const counts = new Map<string, number>();
    for (const { tool } of entries) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    const used = new Set<string>();
    this.toolRoutes.clear();
    const exposed = entries.map(({ connection, tool }) => {
      const candidate = counts.get(tool.name) === 1 ? tool.name : `${connection.routeName}__${tool.name}`;
      const name = allocateName(candidate, `${connection.pluginId}__${connection.server.name}__${tool.name}`, used);
      this.toolRoutes.set(name, { connection, originalName: tool.name });
      return name === tool.name ? tool : { ...tool, name };
    });
    this.persistDiagnostics();
    return exposed;
  }

  private async refreshPrompts(): Promise<any[]> {
    await this.ensureInitialized();
    const entries: Array<{ connection: GatewayConnection; prompt: any }> = [];
    for (const connection of this.capable('prompts')) {
      try {
        const prompts = await allPages<any>(cursor => connection.client.listPrompts(cursor ? { cursor } : {}) as any, 'prompts');
        entries.push(...prompts.map(prompt => ({ connection, prompt })));
        const diagnostic = this.diagnostics.find(item => item.status === 'connected' && item.pluginId === connection.pluginId && item.serverName === connection.server.name);
        if (diagnostic) diagnostic.prompts = prompts.length;
      } catch (err) {
        process.stderr.write(`[botmux-mcp] ${connection.key} prompts/list failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    const counts = new Map<string, number>();
    for (const { prompt } of entries) counts.set(prompt.name, (counts.get(prompt.name) ?? 0) + 1);
    const used = new Set<string>();
    this.promptRoutes.clear();
    return entries.map(({ connection, prompt }) => {
      const candidate = counts.get(prompt.name) === 1 ? prompt.name : `${connection.routeName}__${prompt.name}`;
      const name = allocateName(candidate, `${connection.pluginId}__${connection.server.name}__${prompt.name}`, used);
      this.promptRoutes.set(name, { connection, originalName: prompt.name });
      return name === prompt.name ? prompt : { ...prompt, name };
    });
  }

  private async refreshResources(): Promise<{ resources: any[]; resourceTemplates: any[] }> {
    await this.ensureInitialized();
    const resources: Array<{ connection: GatewayConnection; value: any }> = [];
    const templates: Array<{ connection: GatewayConnection; value: any }> = [];
    for (const connection of this.capable('resources')) {
      try {
        const listed = await allPages<any>(cursor => connection.client.listResources(cursor ? { cursor } : {}) as any, 'resources');
        const listedTemplates = await allPages<any>(cursor => connection.client.listResourceTemplates(cursor ? { cursor } : {}) as any, 'resourceTemplates');
        resources.push(...listed.map(value => ({ connection, value })));
        templates.push(...listedTemplates.map(value => ({ connection, value })));
        const diagnostic = this.diagnostics.find(item => item.status === 'connected' && item.pluginId === connection.pluginId && item.serverName === connection.server.name);
        if (diagnostic) diagnostic.resources = listed.length;
      } catch (err) {
        process.stderr.write(`[botmux-mcp] ${connection.key} resources/list failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    const uriCounts = new Map<string, number>();
    for (const { value } of resources) uriCounts.set(value.uri, (uriCounts.get(value.uri) ?? 0) + 1);
    const templateCounts = new Map<string, number>();
    for (const { value } of templates) templateCounts.set(value.uriTemplate, (templateCounts.get(value.uriTemplate) ?? 0) + 1);
    this.resourceRoutes.clear();
    this.resourceTemplateRoutes = [];
    const exposedResources = resources.map(({ connection, value }) => {
      const exposedUri = uriCounts.get(value.uri) === 1 ? value.uri : `${connection.uriPrefix}${value.uri}`;
      this.resourceRoutes.set(exposedUri, { connection, originalUri: value.uri, exposedUri });
      return exposedUri === value.uri ? value : { ...value, uri: exposedUri };
    });
    const exposedTemplates = templates.map(({ connection, value }) => {
      const exposedUri = templateCounts.get(value.uriTemplate) === 1
        ? value.uriTemplate
        : `${connection.uriPrefix}${value.uriTemplate}`;
      const route: ResourceRoute = {
        connection,
        originalUri: value.uriTemplate,
        exposedUri,
        template: new UriTemplate(exposedUri),
      };
      this.resourceTemplateRoutes.push(route);
      return exposedUri === value.uriTemplate ? value : { ...value, uriTemplate: exposedUri };
    });
    this.persistDiagnostics();
    return { resources: exposedResources, resourceTemplates: exposedTemplates };
  }

  private mapDownstreamUri(connectionKey: string, uri: string): string {
    const connection = this.connections.find(item => item.key === connectionKey);
    if (!connection) return uri;
    const collision = [...this.resourceRoutes.values()].some(route => route.originalUri === uri && route.connection.key !== connectionKey);
    return collision ? `${connection.uriPrefix}${uri}` : uri;
  }

  private async resolveResourceRoute(uri: string): Promise<ResourceRoute | undefined> {
    if (this.resourceRoutes.size === 0 && this.resourceTemplateRoutes.length === 0) await this.refreshResources();
    const exact = this.resourceRoutes.get(uri);
    if (exact) return exact;
    for (const route of this.resourceTemplateRoutes) {
      if (route.template?.match(uri)) {
        const originalUri = uri.startsWith(route.connection.uriPrefix)
          ? uri.slice(route.connection.uriPrefix.length)
          : uri;
        return { ...route, originalUri, exposedUri: uri };
      }
    }
    const prefixed = this.connections.find(connection => uri.startsWith(connection.uriPrefix));
    return prefixed
      ? { connection: prefixed, originalUri: uri.slice(prefixed.uriPrefix.length), exposedUri: uri }
      : undefined;
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.refreshTools() }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (this.toolRoutes.size === 0) await this.refreshTools();
      const route = this.toolRoutes.get(request.params.name);
      if (!route) throw methodUnsupported(`tools/call:${request.params.name}`);
      return route.connection.client.callTool(
        this.withTrustedTurnMeta({ ...request.params, name: route.originalName }),
        undefined,
        this.requestOptions(request, extra),
      );
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: await this.refreshPrompts() }));
    this.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      if (this.promptRoutes.size === 0) await this.refreshPrompts();
      const route = this.promptRoutes.get(request.params.name);
      if (!route) throw methodUnsupported(`prompts/get:${request.params.name}`);
      return route.connection.client.getPrompt(
        { ...request.params, name: route.originalName },
        this.requestOptions(request, extra),
      );
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const result = await this.refreshResources();
      return { resources: result.resources };
    });
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const result = await this.refreshResources();
      return { resourceTemplates: result.resourceTemplates };
    });
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const route = await this.resolveResourceRoute(request.params.uri);
      if (!route) throw methodUnsupported(`resources/read:${request.params.uri}`);
      const result = await route.connection.client.readResource(
        { ...request.params, uri: route.originalUri },
        this.requestOptions(request, extra),
      );
      return {
        ...result,
        contents: result.contents.map(content => ({
          ...content,
          uri: route.exposedUri === route.originalUri ? content.uri : `${route.connection.uriPrefix}${content.uri}`,
        })),
      };
    });
    this.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
      const route = await this.resolveResourceRoute(request.params.uri);
      if (!route) throw methodUnsupported(`resources/subscribe:${request.params.uri}`);
      return route.connection.client.subscribeResource(
        { ...request.params, uri: route.originalUri },
        this.requestOptions(request, extra),
      );
    });
    this.server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
      const route = await this.resolveResourceRoute(request.params.uri);
      if (!route) throw methodUnsupported(`resources/unsubscribe:${request.params.uri}`);
      return route.connection.client.unsubscribeResource(
        { ...request.params, uri: route.originalUri },
        this.requestOptions(request, extra),
      );
    });

    this.server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
      if (request.params.ref.type === 'ref/prompt') {
        if (this.promptRoutes.size === 0) await this.refreshPrompts();
        const route = this.promptRoutes.get(request.params.ref.name);
        if (!route) throw methodUnsupported(`completion/complete:${request.params.ref.name}`);
        return route.connection.client.complete(
          { ...request.params, ref: { ...request.params.ref, name: route.originalName } },
          this.requestOptions(request, extra),
        );
      }
      const route = await this.resolveResourceRoute(request.params.ref.uri);
      if (!route) throw methodUnsupported(`completion/complete:${request.params.ref.uri}`);
      return route.connection.client.complete(
        { ...request.params, ref: { ...request.params.ref, uri: route.originalUri } },
        this.requestOptions(request, extra),
      );
    });

    this.server.setRequestHandler(SetLevelRequestSchema, async (request, extra) => {
      await this.ensureInitialized();
      await Promise.allSettled(this.capable('logging').map(connection => (
        connection.client.setLoggingLevel(request.params.level, this.requestOptions(request, extra))
      )));
      return {};
    });

    this.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      await this.ensureInitialized();
      await Promise.allSettled(this.connections.map(connection => connection.client.sendRootsListChanged()));
    });
  }
}

export async function runMcpGateway(): Promise<void> {
  const env = resolveGatewayEnvironment();
  const socketPath = env[MCP_GATEWAY_SOCKET_ENV]?.trim();
  if (socketPath) {
    try {
      readMcpGatewayAuthToken(socketPath);
    } catch {
      throw new Error('Botmux MCP Gateway authentication token is unavailable; restart this Botmux session');
    }
    await runReconnectingMcpRelay(socketPath, { env });
    return;
  }
  if (env[MCP_GATEWAY_REQUIRED_ENV] === '1') {
    throw new Error('Botmux MCP Gateway host socket is unavailable; restart this Botmux session');
  }
  // A managed Botmux session without plugin MCP contributions needs a stable,
  // empty server for the globally installed CLI entry. Never inspect descriptor
  // files from this CLI-side process.
  const gateway = new PluginMcpGateway(env.BOTMUX_SESSION_ID ? [] : undefined, env);
  const transport = new StdioServerTransport();
  const connectPromise = gateway.connect(transport);
  const reportCloseError = (error: unknown) => {
    process.stderr.write(`[botmux-mcp] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  };
  const close = bindGatewayInputLifecycle(process.stdin, async () => {
    await connectPromise.catch(() => undefined);
    await gateway.close();
  }, reportCloseError);
  const requestClose = () => { void close().catch(reportCloseError); };
  process.once('SIGINT', requestClose);
  process.once('SIGTERM', requestClose);
  await connectPromise;
}

/** Single connection attempt: connect + authenticate. The caller owns the
 * socket lifecycle after this resolves. */
async function connectMcpGatewaySocket(socketPath: string): Promise<NetSocket> {
  // The token is re-read on EVERY attempt: the replacement host rotates it
  // (atomically) before listening, so a reconnecting relay must never pin the
  // token it read at process start.
  const authToken = readMcpGatewayAuthToken(socketPath);
  const socket = createConnection({ path: socketPath });
  socket.setNoDelay(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onInitialError);
        resolve();
      };
      const onInitialError = (error: Error) => {
        socket.off('connect', onConnect);
        reject(new Error(`Botmux MCP Gateway relay connection failed: ${error.message}`));
      };
      socket.once('connect', onConnect);
      socket.once('error', onInitialError);
    });
    await sendMcpGatewayHandshake(socket, authToken);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

interface RelayTuning {
  /** First-ever connect must succeed within this window (the host normally
   *  exists before the CLI spawns, so this only smooths startup races). */
  initialBudgetMs: number;
  /** After a disconnect the relay retries for this long before exiting. The
   *  default is UNBOUNDED: the CLI owns the relay's lifetime (stdin close →
   *  exit), the reattach decision in the worker assumes a surviving pane's
   *  relay is still alive, and a capped-backoff unix connect attempt every few
   *  seconds is free — whereas giving up would silently strand the pane's MCP
   *  client after a long daemon outage (most CLIs never restart a dead MCP
   *  server mid-session). Env override exists for tests. */
  reconnectBudgetMs: number;
  /** First retry delay; doubles per attempt, capped at maxBackoffMs. */
  backoffMs: number;
  maxBackoffMs: number;
}

function relayTuning(env: NodeJS.ProcessEnv): RelayTuning {
  const num = (key: string, fallback: number): number => {
    const parsed = Number(env[key]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const backoffMs = num('BOTMUX_MCP_RELAY_BACKOFF_MS', 250);
  return {
    initialBudgetMs: num('BOTMUX_MCP_RELAY_INITIAL_BUDGET_MS', 15_000),
    reconnectBudgetMs: num('BOTMUX_MCP_RELAY_RECONNECT_BUDGET_MS', Number.POSITIVE_INFINITY),
    backoffMs,
    maxBackoffMs: Math.max(backoffMs, num('BOTMUX_MCP_RELAY_MAX_BACKOFF_MS', 5_000)),
  };
}

/** Cap on client lines buffered while the Gateway is unreachable. MCP traffic
 *  is small JSON messages; hitting this means something is badly wrong and the
 *  relay should die visibly rather than balloon. */
const RELAY_OUTAGE_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

/** Newline-framed stdio relay from a CLI-native MCP launcher to the trusted
 * worker-side Gateway that SURVIVES host replacement. No plugin metadata or
 * credentials are loaded here.
 *
 * Why not a byte pipe: the worker-side Gateway host dies with the worker on
 * every daemon restart/upgrade, and the CLI process (in a persistent tmux/zmx
 * pane) lives on with this relay as its MCP server. A single-shot pipe forced
 * the worker to kill the surviving pane ("cold-resume") just to refresh the
 * MCP plumbing — interrupting whatever turn the CLI was executing. Instead the
 * relay:
 *   1. frames both directions as newline-delimited JSON (the MCP stdio
 *      framing), buffering client lines while the Gateway is unreachable;
 *   2. reconnects to the SAME deterministic socket path with backoff, re-reads
 *      the rotated auth token per attempt;
 *   3. replays the captured `initialize` request + `notifications/initialized`
 *      on the fresh Gateway connection (each host connection is a brand-new
 *      MCP server that expects the handshake), swallowing the replayed
 *      response iff the client already saw the original one — the client
 *      never re-initializes and must not receive a duplicate response id.
 * Requests in flight across a disconnect lose their responses; the client's
 * own MCP timeout surfaces those as failed tool calls, which is the honest
 * outcome. */
export async function runReconnectingMcpRelay(
  socketPath: string,
  opts: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const tuning = relayTuning(opts.env ?? process.env);

  let socket: NetSocket | null = null;
  let connected = false;
  let everConnected = false;
  let inputEnded = false;
  let settled = false;
  const destroySocket = (): void => { socket?.destroy(); };

  // Client → server lines held while the Gateway is unreachable (or while an
  // initialize replay is in flight, to preserve ordering).
  const pendingClientLines: string[] = [];
  let pendingBytes = 0;

  // Captured MCP handshake for replay onto fresh Gateway connections.
  let initializeLine: string | undefined;
  let initializeId: string | number | null | undefined;
  let initializeSentToServer = false;
  let initializeResponseForwarded = false;
  let initializedNotificationLine: string | undefined;

  // Replay-in-progress state for the current connection.
  let replayAwaitingResponse = false;

  let finish!: () => void;
  let fatal!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = () => { if (!settled) { settled = true; resolve(); } };
    fatal = (error: Error) => { if (!settled) { settled = true; reject(error); } };
  });

  const tryParse = (line: string): any => {
    try { return JSON.parse(line); } catch { return undefined; }
  };
  const idEquals = (a: unknown, b: unknown): boolean => a !== undefined && b !== undefined && a === b;

  const writeServerLine = (line: string): void => {
    socket?.write(`${line}\n`);
    const parsed = tryParse(line);
    if (parsed?.method === 'initialize' && idEquals(parsed.id, initializeId)) {
      initializeSentToServer = true;
    }
  };

  const bufferClientLine = (line: string): void => {
    pendingBytes += Buffer.byteLength(line) + 1;
    if (pendingBytes > RELAY_OUTAGE_BUFFER_MAX_BYTES) {
      fatal(new Error('Botmux MCP Gateway relay buffered too much during a Gateway outage'));
      return;
    }
    pendingClientLines.push(line);
  };

  const flushPendingClientLines = (): void => {
    while (pendingClientLines.length > 0 && connected && !replayAwaitingResponse) {
      const line = pendingClientLines.shift()!;
      pendingBytes -= Buffer.byteLength(line) + 1;
      writeServerLine(line);
    }
  };

  const onClientLine = (line: string): void => {
    if (line.trim().length === 0) return;
    const parsed = tryParse(line);
    if (parsed?.method === 'initialize' && parsed.id !== undefined && initializeLine === undefined) {
      initializeLine = line;
      initializeId = parsed.id;
    } else if (parsed?.method === 'notifications/initialized') {
      initializedNotificationLine = line;
    }
    if (connected && !replayAwaitingResponse) writeServerLine(line);
    else bufferClientLine(line);
  };

  const onServerLine = (line: string): void => {
    if (line.trim().length === 0) return;
    const parsed = tryParse(line);
    const isInitializeResponse = parsed !== undefined
      && parsed.method === undefined
      && idEquals(parsed.id, initializeId);
    if (replayAwaitingResponse && isInitializeResponse) {
      replayAwaitingResponse = false;
      // Forward the replayed response only when the client never saw the
      // original (disconnect raced the first response); otherwise a duplicate
      // response id would corrupt the client's MCP session.
      if (!initializeResponseForwarded) {
        initializeResponseForwarded = true;
        output.write(`${line}\n`);
      }
      if (initializedNotificationLine !== undefined) writeServerLine(initializedNotificationLine);
      flushPendingClientLines();
      return;
    }
    if (isInitializeResponse) initializeResponseForwarded = true;
    output.write(`${line}\n`);
  };

  const attachSocket = (fresh: NetSocket): void => {
    socket = fresh;
    connected = true;
    everConnected = true;
    const decoder = new StringDecoder('utf8');
    let tail = '';
    fresh.on('data', (chunk: Buffer) => {
      tail += decoder.write(chunk);
      for (;;) {
        const newline = tail.indexOf('\n');
        if (newline < 0) break;
        const line = tail.slice(0, newline).replace(/\r$/, '');
        tail = tail.slice(newline + 1);
        onServerLine(line);
      }
    });
    fresh.on('error', () => { /* surfaced via 'close' */ });
    fresh.once('close', () => {
      if (socket !== fresh) return;
      socket = null;
      connected = false;
      replayAwaitingResponse = false;
      if (inputEnded || settled) {
        finish();
        return;
      }
      void reconnectLoop(false);
    });
    if (initializeSentToServer && initializeLine !== undefined) {
      // Fresh Gateway connection = fresh MCP server: replay the handshake the
      // client already performed. Pending client lines stay queued until the
      // replayed response arrives so the server never sees requests
      // pre-initialize.
      replayAwaitingResponse = true;
      fresh.write(`${initializeLine}\n`);
    } else {
      flushPendingClientLines();
    }
  };

  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  const reconnectLoop = async (initial: boolean): Promise<void> => {
    const budgetMs = initial && !everConnected ? tuning.initialBudgetMs : tuning.reconnectBudgetMs;
    const startedAt = Date.now();
    let delayMs = tuning.backoffMs;
    for (;;) {
      if (inputEnded || settled) { finish(); return; }
      try {
        attachSocket(await connectMcpGatewaySocket(socketPath));
        return;
      } catch (error) {
        if (Date.now() - startedAt + delayMs > budgetMs) {
          fatal(new Error(
            `Botmux MCP Gateway unreachable for ${Math.round(budgetMs / 1000)}s `
            + `(${error instanceof Error ? error.message : String(error)}); giving up`,
          ));
          return;
        }
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, tuning.maxBackoffMs);
      }
    }
  };

  const inputDecoder = new StringDecoder('utf8');
  let inputTail = '';
  input.on('data', (chunk: Buffer | string) => {
    inputTail += typeof chunk === 'string' ? chunk : inputDecoder.write(chunk);
    for (;;) {
      const newline = inputTail.indexOf('\n');
      if (newline < 0) break;
      const line = inputTail.slice(0, newline).replace(/\r$/, '');
      inputTail = inputTail.slice(newline + 1);
      onClientLine(line);
    }
  });
  input.once('end', () => {
    inputEnded = true;
    if (socket) socket.destroy();
    else finish();
  });
  input.once('error', () => {
    inputEnded = true;
    if (socket) socket.destroy();
    else finish();
  });
  input.resume?.();

  await reconnectLoop(true);
  try {
    await done;
  } finally {
    destroySocket();
  }
}
