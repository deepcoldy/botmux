import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { config } from '../../../config.js';
import { readGlobalConfig } from '../../../global-config.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { normalizePluginIdList } from '../ids.js';
import { pluginHome, pluginRuntimeDir, resolvePluginPath } from '../paths.js';
import { readSessionPluginManifest } from '../session-manifest.js';
import type { PluginMcpServer } from '../types.js';

const GATEWAY_VERSION = '1.0.0';
const DOWNSTREAM_INITIALIZE_TIMEOUT_MS = 10_000;

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

function gatewayPluginIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const sessionId = env.BOTMUX_SESSION_ID?.trim();
  if (sessionId) {
    const manifest = readSessionPluginManifest(sessionId);
    if (manifest) return manifest.pluginIds;
  }
  return normalizePluginIdList(readGlobalConfig().plugins) ?? [];
}

function gatewayDescriptors(pluginIds: readonly string[]): GatewayDescriptor[] {
  const registry = readPluginRegistry();
  const descriptors: GatewayDescriptor[] = [];
  for (const pluginId of pluginIds) {
    const record = registry.plugins[pluginId];
    if (!record) continue;
    const server = record.contributions?.mcp;
    if (!server) continue;
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

function diagnosticsPath(sessionId: string | undefined): string {
  const safe = sessionId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)
    ? sessionId
    : 'standalone';
  return join(config.session.dataDir, 'mcp-gateway', `${safe}.json`);
}

function writeDiagnostics(file: McpGatewayDiagnosticsFile): void {
  const path = diagnosticsPath(file.sessionId);
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
  private readonly pluginIds: string[];
  private readonly descriptors: GatewayDescriptor[];
  private readonly diagnostics: McpGatewayDiagnostic[] = [];
  private connections: GatewayConnection[] = [];
  private initializePromise?: Promise<void>;
  private toolRoutes = new Map<string, NamedRoute>();
  private promptRoutes = new Map<string, NamedRoute>();
  private resourceRoutes = new Map<string, ResourceRoute>();
  private resourceTemplateRoutes: ResourceRoute[] = [];

  constructor(pluginIds: string[] = gatewayPluginIds()) {
    this.pluginIds = pluginIds;
    this.descriptors = gatewayDescriptors(pluginIds);
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
    writeDiagnostics({
      schemaVersion: 1,
      sessionId: process.env.BOTMUX_SESSION_ID?.trim() || undefined,
      pluginIds: this.pluginIds,
      generatedAt: new Date().toISOString(),
      servers: this.diagnostics,
    });
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
            ...(process.env.BOTMUX_SESSION_ID ? { BOTMUX_SESSION_ID: process.env.BOTMUX_SESSION_ID } : {}),
          },
          stderr: 'inherit',
        });
      } else {
        transport = new StreamableHTTPClientTransport(new URL(descriptor.server.url), {
          requestInit: descriptor.server.headers ? { headers: descriptor.server.headers } : undefined,
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
        { ...request.params, name: route.originalName },
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
  const gateway = new PluginMcpGateway();
  const transport = new StdioServerTransport();
  const close = () => { void gateway.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await gateway.connect(transport);
}
