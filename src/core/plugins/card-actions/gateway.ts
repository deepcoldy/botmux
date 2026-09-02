import { Buffer } from 'node:buffer';
import type { CardActionData } from '../../../im/lark/card-handler.js';
import { loopbackFetch, type LoopbackFetchInit } from '../../loopback-fetch.js';
import { logger } from '../../../utils/logger.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { readPluginServiceState } from '../service-manager.js';
import type {
  InstalledPluginRecord,
  PluginCardActionsContribution,
  PluginRegistryFile,
  PluginServiceState,
} from '../types.js';
import { readPluginCardActionToken } from './auth.js';
import {
  buildPluginCardActionRequest,
  parsePluginCardActionResponse,
  pluginCardActionName,
  PLUGIN_CARD_ACTION_REQUEST_MAX_BYTES,
  PLUGIN_CARD_ACTION_RESPONSE_MAX_BYTES,
  PLUGIN_CARD_ACTION_SCHEMA_VERSION,
  PLUGIN_CARD_ACTION_TIMEOUT_MS,
  type PluginCardActionAck,
} from './protocol.js';

export interface PluginCardActionGatewayLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginCardActionGatewayOptions {
  resolvePluginIds(larkAppId: string): readonly string[];
  fallback?: (data: CardActionData, larkAppId: string) => unknown | Promise<unknown>;
  readRegistry?: () => PluginRegistryFile;
  readServiceState?: (pluginId: string) => PluginServiceState | undefined;
  readToken?: (pluginId: string) => string;
  request?: (url: string, init: LoopbackFetchInit) => Promise<Response>;
  log?: PluginCardActionGatewayLogger;
  timeoutMs?: number;
  requestMaxBytes?: number;
  responseMaxBytes?: number;
  now?: () => number;
}

export type PluginCardActionRouteResolution =
  | { kind: 'unmatched' }
  | { kind: 'matched'; record: InstalledPluginRecord; contribution: PluginCardActionsContribution }
  | { kind: 'conflict'; pluginIds: string[]; selectorType: 'action' | 'prefix'; selector: string };

const safeLogField = (value: unknown, fallback = '?'): string => {
  if (typeof value !== 'string' || !value) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256);
};

const safeErrorCode = (error: unknown): string => {
  if (error instanceof Error && error.name === 'AbortError') return 'plugin_card_action_timeout';
  const message = error instanceof Error ? error.message : '';
  if (/^(?:invalid_)?plugin_card_action_[a-z_]+(?::\d{3})?$/.test(message)) return message;
  if (/^(?:invalid_|unsafe_)?plugin_card_action_token/.test(message)) {
    return 'plugin_card_action_token_unavailable';
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return `transport_${code}`;
  return 'plugin_card_action_internal_error';
};

const contributionFor = (record: InstalledPluginRecord): PluginCardActionsContribution | undefined => {
  const contribution = record.contributions?.cardActions;
  if (!contribution || contribution.schemaVersion !== PLUGIN_CARD_ACTION_SCHEMA_VERSION) return undefined;
  if (
    typeof contribution.endpoint !== 'string'
    || !contribution.endpoint.startsWith('/')
    || contribution.endpoint.startsWith('//')
    || contribution.endpoint.includes('\\')
    || contribution.endpoint.includes('?')
    || contribution.endpoint.includes('#')
  ) return undefined;
  if (
    contribution.actions !== undefined
    && (!Array.isArray(contribution.actions) || contribution.actions.some(value => typeof value !== 'string'))
  ) return undefined;
  if (
    contribution.actionPrefixes !== undefined
    && (!Array.isArray(contribution.actionPrefixes) || contribution.actionPrefixes.some(value => typeof value !== 'string'))
  ) return undefined;
  return contribution;
};

const boundedLimit = (candidate: number | undefined, maximum: number): number => {
  if (candidate === undefined) return maximum;
  if (!Number.isFinite(candidate) || candidate < 1) return 1;
  return Math.min(maximum, Math.floor(candidate));
};

export const resolvePluginCardActionRoute = (
  records: readonly InstalledPluginRecord[],
  actionName: string,
): PluginCardActionRouteResolution => {
  const candidates = records
    .map(record => ({ record, contribution: contributionFor(record) }))
    .filter((entry): entry is { record: InstalledPluginRecord; contribution: PluginCardActionsContribution } => (
      entry.contribution !== undefined
    ));

  const exact = candidates.filter(({ contribution }) => contribution.actions?.includes(actionName));
  if (exact.length > 1) {
    return {
      kind: 'conflict',
      pluginIds: exact.map(({ record }) => record.id),
      selectorType: 'action',
      selector: actionName,
    };
  }
  if (exact.length === 1) return { kind: 'matched', ...exact[0] };

  const prefixes = candidates.flatMap(({ record, contribution }) => (
    (contribution.actionPrefixes ?? [])
      .filter(prefix => actionName.startsWith(prefix))
      .map(prefix => ({ record, contribution, prefix }))
  ));
  if (prefixes.length === 0) return { kind: 'unmatched' };
  const longest = Math.max(...prefixes.map(entry => entry.prefix.length));
  const selected = prefixes.filter(entry => entry.prefix.length === longest);
  const pluginIds = [...new Set(selected.map(entry => entry.record.id))];
  if (pluginIds.length > 1) {
    return {
      kind: 'conflict',
      pluginIds,
      selectorType: 'prefix',
      selector: selected[0].prefix,
    };
  }
  return {
    kind: 'matched',
    record: selected[0].record,
    contribution: selected[0].contribution,
  };
};

const readResponseBodyLimited = async (response: Response, maxBytes: number): Promise<string> => {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('plugin_card_action_response_too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('plugin_card_action_response_too_large');
      }
      chunks = [...chunks, value];
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString('utf8');
};

const assertServicePort = (state: PluginServiceState | undefined, pluginId: string): number => {
  if (state?.pluginId !== pluginId || state.status !== 'online') {
    throw new Error('plugin_card_action_service_offline');
  }
  if (!Number.isInteger(state.port) || state.port! < 1 || state.port! > 65_535) {
    throw new Error('plugin_card_action_service_port_invalid');
  }
  return state.port!;
};

interface ResolvedPluginCardActionGatewayOptions {
  resolvePluginIds: PluginCardActionGatewayOptions['resolvePluginIds'];
  fallback: PluginCardActionGatewayOptions['fallback'];
  readRegistry: NonNullable<PluginCardActionGatewayOptions['readRegistry']>;
  readServiceState: NonNullable<PluginCardActionGatewayOptions['readServiceState']>;
  readToken: NonNullable<PluginCardActionGatewayOptions['readToken']>;
  request: NonNullable<PluginCardActionGatewayOptions['request']>;
  log: PluginCardActionGatewayLogger;
  timeoutMs: number;
  requestMaxBytes: number;
  responseMaxBytes: number;
  now: () => number;
}

const resolveGatewayOptions = (
  options: PluginCardActionGatewayOptions,
): ResolvedPluginCardActionGatewayOptions => ({
  resolvePluginIds: options.resolvePluginIds,
  fallback: options.fallback,
  readRegistry: options.readRegistry ?? readPluginRegistry,
  readServiceState: options.readServiceState ?? readPluginServiceState,
  readToken: options.readToken ?? readPluginCardActionToken,
  request: options.request ?? loopbackFetch,
  log: options.log ?? logger,
  timeoutMs: boundedLimit(options.timeoutMs, PLUGIN_CARD_ACTION_TIMEOUT_MS),
  requestMaxBytes: boundedLimit(options.requestMaxBytes, PLUGIN_CARD_ACTION_REQUEST_MAX_BYTES),
  responseMaxBytes: boundedLimit(options.responseMaxBytes, PLUGIN_CARD_ACTION_RESPONSE_MAX_BYTES),
  now: options.now ?? Date.now,
});

const forwardPluginCardAction = async (
  options: ResolvedPluginCardActionGatewayOptions,
  record: InstalledPluginRecord,
  contribution: PluginCardActionsContribution,
  data: CardActionData,
  larkAppId: string,
  actionName: string,
): Promise<PluginCardActionAck | undefined> => {
  const port = assertServicePort(options.readServiceState(record.id), record.id);
  const token = options.readToken(record.id);
  const payload = JSON.stringify(buildPluginCardActionRequest(data, larkAppId, actionName));
  const bodyBytes = Buffer.byteLength(payload);
  if (bodyBytes > options.requestMaxBytes) throw new Error('plugin_card_action_request_too_large');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.request(
      `http://127.0.0.1:${port}${contribution.endpoint}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(bodyBytes),
        },
        body: payload,
        signal: controller.signal,
      },
    );
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`plugin_card_action_redirect:${response.status}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`plugin_card_action_http_status:${response.status}`);
    }
    const body = await readResponseBodyLimited(response, options.responseMaxBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('invalid_plugin_card_action_response_json');
    }
    return parsePluginCardActionResponse(parsed);
  } finally {
    clearTimeout(timeout);
  }
};

const dispatchPluginCardAction = async (
  options: ResolvedPluginCardActionGatewayOptions,
  data: CardActionData,
  larkAppId: string,
): Promise<unknown> => {
  const actionName = pluginCardActionName(data);
  if (!actionName) return options.fallback?.(data, larkAppId);

  let route: PluginCardActionRouteResolution;
  try {
    const registry = options.readRegistry();
    const records = [...new Set(options.resolvePluginIds(larkAppId))]
      .map(pluginId => registry.plugins[pluginId])
      .filter((record): record is InstalledPluginRecord => record !== undefined);
    route = resolvePluginCardActionRoute(records, actionName);
  } catch (error) {
    options.log.error(
      `[plugin-card-action] app=${safeLogField(larkAppId)} action=${safeLogField(actionName)} `
      + `status=route-error error=${safeErrorCode(error)}`,
    );
    return undefined;
  }

  if (route.kind === 'unmatched') return options.fallback?.(data, larkAppId);
  if (route.kind === 'conflict') {
    options.log.error(
      `[plugin-card-action] app=${safeLogField(larkAppId)} action=${safeLogField(actionName)} `
      + `status=conflict selectorType=${route.selectorType} selector=${safeLogField(route.selector)} `
      + `plugins=${route.pluginIds.map(id => safeLogField(id)).join(',')}`,
    );
    return undefined;
  }

  const startedAt = options.now();
  try {
    const result = await forwardPluginCardAction(options, route.record, route.contribution, data, larkAppId, actionName);
    options.log.info(
      `[plugin-card-action] app=${safeLogField(larkAppId)} action=${safeLogField(actionName)} `
      + `plugin=${safeLogField(route.record.id)} status=ok `
      + `durationMs=${Math.max(0, options.now() - startedAt)}`,
    );
    return result;
  } catch (error) {
    options.log.warn(
      `[plugin-card-action] app=${safeLogField(larkAppId)} action=${safeLogField(actionName)} `
      + `plugin=${safeLogField(route.record.id)} status=isolated `
      + `durationMs=${Math.max(0, options.now() - startedAt)} error=${safeErrorCode(error)}`,
    );
    return undefined;
  }
};

export const createPluginCardActionGateway = (options: PluginCardActionGatewayOptions) => {
  const resolved = resolveGatewayOptions(options);
  return {
    dispatch: (data: CardActionData, larkAppId: string) => dispatchPluginCardAction(resolved, data, larkAppId),
  };
};

export type PluginCardActionGateway = ReturnType<typeof createPluginCardActionGateway>;
