import { Buffer } from 'node:buffer';
import { loopbackFetch, type LoopbackFetchInit } from '../../loopback-fetch.js';
import { logger } from '../../../utils/logger.js';
import { isBotmuxCardAction } from '../../card-action-namespace.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { readPluginServiceState } from '../service-manager.js';
import { readPluginCardActionToken } from '../card-actions/auth.js';
import {
  assertServicePort,
  readResponseBodyLimited,
  resolvePluginCardActionRoute,
} from '../card-actions/gateway.js';
import type {
  InstalledPluginRecord,
  PluginCommandsContribution,
  PluginRegistryFile,
  PluginServiceState,
} from '../types.js';
import {
  parsePluginCommandResponse,
  PLUGIN_COMMAND_REQUEST_MAX_BYTES,
  PLUGIN_COMMAND_RESPONSE_MAX_BYTES,
  PLUGIN_COMMAND_SCHEMA_VERSION,
  PLUGIN_COMMAND_TIMEOUT_MS,
  type PluginCommandReply,
  type PluginCommandRequest,
} from './protocol.js';

export interface PluginCommandGatewayLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginCommandGatewayOptions {
  resolvePluginIds(larkAppId: string): readonly string[];
  readRegistry?: () => PluginRegistryFile;
  readServiceState?: (pluginId: string) => PluginServiceState | undefined;
  readToken?: (pluginId: string) => string;
  request?: (url: string, init: LoopbackFetchInit) => Promise<Response>;
  log?: PluginCommandGatewayLogger;
  timeoutMs?: number;
  now?: () => number;
}

export type PluginCommandRoutingRecord = Pick<InstalledPluginRecord, 'id' | 'contributions'>;

/** command name → owning plugin id, or `null` when two enabled plugins claim it (fail closed). */
export type PluginCommandTable = ReadonlyMap<string, string | null>;

export interface PluginCommandListing {
  name: string;
  description?: string;
  /** null = conflicting declaration; the command is unavailable. */
  pluginId: string | null;
}

export type PluginCommandOutcome =
  | { ok: true; reply?: PluginCommandReply }
  | { ok: false; error: string };

export type PluginCommandInvocation = Omit<PluginCommandRequest, 'schemaVersion'>;

const safeLogField = (value: unknown, fallback = '?'): string => {
  if (typeof value !== 'string' || !value) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256);
};

const safeErrorCode = (error: unknown): string => {
  if (error instanceof Error && error.name === 'AbortError') return 'plugin_command_timeout';
  const message = error instanceof Error ? error.message : '';
  if (/^(?:invalid_)?plugin_(?:command|card_action)_[a-z_]+(?::\d{3})?$/.test(message)) return message;
  if (/^(?:invalid_|unsafe_)?plugin_card_action_token/.test(message)) return 'plugin_command_token_unavailable';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return `transport_${code}`;
  return 'plugin_command_internal_error';
};

const commandsFor = (record: PluginCommandRoutingRecord): PluginCommandsContribution | undefined => {
  const contribution = record.contributions?.commands;
  if (!contribution || contribution.schemaVersion !== PLUGIN_COMMAND_SCHEMA_VERSION) return undefined;
  if (
    typeof contribution.endpoint !== 'string'
    || !contribution.endpoint.startsWith('/')
    || contribution.endpoint.startsWith('//')
    || contribution.endpoint.includes('\\')
    || contribution.endpoint.includes('?')
    || contribution.endpoint.includes('#')
    || !Array.isArray(contribution.commands)
  ) return undefined;
  return contribution;
};

/**
 * List every command the given enabled plugins declare. A name claimed by more
 * than one plugin is reported once with `pluginId: null` — install order never
 * decides who wins.
 */
export const listPluginCommands = (records: readonly PluginCommandRoutingRecord[]): PluginCommandListing[] => {
  const byName = new Map<string, PluginCommandListing>();
  for (const record of records) {
    const contribution = commandsFor(record);
    if (!contribution) continue;
    for (const command of contribution.commands) {
      if (typeof command?.name !== 'string') continue;
      const existing = byName.get(command.name);
      if (existing && existing.pluginId !== record.id) {
        byName.set(command.name, { ...existing, pluginId: null });
        continue;
      }
      if (!existing) {
        byName.set(command.name, {
          name: command.name,
          ...(typeof command.description === 'string' ? { description: command.description } : {}),
          pluginId: record.id,
        });
      }
    }
  }
  return [...byName.values()];
};

export const resolvePluginCommandTable = (records: readonly PluginCommandRoutingRecord[]): PluginCommandTable =>
  new Map(listPluginCommands(records).map(entry => [entry.name, entry.pluginId] as const));

const boundedTimeout = (candidate: number | undefined): number => {
  if (candidate === undefined) return PLUGIN_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(candidate) || candidate < 1) return 1;
  return Math.min(PLUGIN_COMMAND_TIMEOUT_MS, Math.floor(candidate));
};

export const createPluginCommandGateway = (options: PluginCommandGatewayOptions) => {
  const readRegistry = options.readRegistry ?? readPluginRegistry;
  const readServiceState = options.readServiceState ?? readPluginServiceState;
  const readToken = options.readToken ?? readPluginCardActionToken;
  const request = options.request ?? loopbackFetch;
  const log = options.log ?? logger;
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const now = options.now ?? Date.now;

  const enabledRecords = (larkAppId: string): InstalledPluginRecord[] => {
    const registry = readRegistry();
    return [...new Set(options.resolvePluginIds(larkAppId))]
      .map(pluginId => registry.plugins[pluginId])
      .filter((record): record is InstalledPluginRecord => record !== undefined);
  };

  /** Never throws: a broken registry must not take slash routing down with it. */
  const list = (larkAppId: string): PluginCommandListing[] => {
    try {
      return listPluginCommands(enabledRecords(larkAppId));
    } catch (error) {
      log.error(`[plugin-command] app=${safeLogField(larkAppId)} status=registry-error error=${safeErrorCode(error)}`);
      return [];
    }
  };

  const forward = async (
    record: InstalledPluginRecord,
    contribution: PluginCommandsContribution,
    records: readonly InstalledPluginRecord[],
    invocation: PluginCommandInvocation,
  ): Promise<PluginCommandReply | undefined> => {
    const port = assertServicePort(readServiceState(record.id), record.id);
    const token = readToken(record.id);
    const payload = JSON.stringify({ schemaVersion: PLUGIN_COMMAND_SCHEMA_VERSION, ...invocation });
    const bodyBytes = Buffer.byteLength(payload);
    if (bodyBytes > PLUGIN_COMMAND_REQUEST_MAX_BYTES) throw new Error('plugin_command_request_too_large');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(`http://127.0.0.1:${port}${contribution.endpoint}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(bodyBytes),
        },
        body: payload,
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`plugin_command_redirect:${response.status}`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`plugin_command_http_status:${response.status}`);
      }
      const body = await readResponseBodyLimited(response, PLUGIN_COMMAND_RESPONSE_MAX_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error('invalid_plugin_command_response_json');
      }
      // A reply card may only carry callbacks this plugin itself handles.
      return parsePluginCommandResponse(parsed, {
        callbackPolicy: {
          allowsAction(candidate) {
            if (isBotmuxCardAction(candidate)) return false;
            const route = resolvePluginCardActionRoute(records, candidate);
            return route.kind === 'matched' && route.record.id === record.id;
          },
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const execute = async (pluginId: string, invocation: PluginCommandInvocation): Promise<PluginCommandOutcome> => {
    const startedAt = now();
    const logPrefix = `[plugin-command] app=${safeLogField(invocation.larkAppId)} `
      + `command=${safeLogField(invocation.command)} plugin=${safeLogField(pluginId)}`;
    try {
      // Re-resolve at execution time: the plugin may have been disabled or have
      // dropped the command since routing looked at the registry.
      const records = enabledRecords(invocation.larkAppId);
      const owner = listPluginCommands(records).find(entry => entry.name === invocation.command);
      const record = records.find(candidate => candidate.id === pluginId);
      const contribution = record ? commandsFor(record) : undefined;
      if (!record || !contribution || owner?.pluginId !== pluginId) {
        throw new Error('plugin_command_not_routable');
      }
      const reply = await forward(record, contribution, records, invocation);
      log.info(`${logPrefix} status=ok durationMs=${Math.max(0, now() - startedAt)}`);
      return reply ? { ok: true, reply } : { ok: true };
    } catch (error) {
      const code = safeErrorCode(error);
      log.warn(`${logPrefix} status=isolated durationMs=${Math.max(0, now() - startedAt)} error=${code}`);
      return { ok: false, error: code };
    }
  };

  return {
    list,
    table: (larkAppId: string): PluginCommandTable =>
      new Map(list(larkAppId).map(entry => [entry.name, entry.pluginId] as const)),
    execute,
  };
};

export type PluginCommandGateway = ReturnType<typeof createPluginCommandGateway>;
