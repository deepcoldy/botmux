import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  deleteConnector,
  getConnector,
  listConnectors,
  newConnectorId,
  upsertConnector,
  type ConnectorDefinition,
} from '../services/connector-store.js';
import {
  createWebhookSecret,
  deleteWebhookSecret,
  generateWebhookSecretPlaintext,
  listWebhookSecretRefs,
  setWebhookSecret,
} from '../services/webhook-key.js';
import { platformMachineBaseUrl } from '../platform/binding.js';
import { isRemoteAccessEnabled } from '../global-config.js';
import {
  pruneTriggerLogs,
  queryTriggerLogs,
  summarizeTriggerLogOverview,
  summarizeTriggerLogs,
  type TriggerLogListOptions,
  type TriggerLogStats,
} from '../services/trigger-log-store.js';
import type { TriggerAction, TriggerErrorCode } from '../services/trigger-types.js';
import { jsonRes } from './http.js';

const DEFAULT_VERIFY_HEADERS = {
  signatureHeader: 'x-botmux-signature',
  timestampHeader: 'x-botmux-timestamp',
  nonceHeader: 'x-botmux-nonce',
  toleranceSeconds: 300,
};

async function readJsonBody<T = unknown>(req: IncomingMessage, maxBytes = 256 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(b);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function positiveInt(v: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function logStatus(v: string | null): 'ok' | 'error' | undefined {
  return v === 'ok' || v === 'error' ? v : undefined;
}

function logAction(v: string | null): TriggerAction | 'failed' | undefined {
  return v && ['queued', 'delivered', 'dry_run', 'ignored', 'completed', 'failed'].includes(v)
    ? v as TriggerAction | 'failed'
    : undefined;
}

function triggerLogFilters(url: URL): TriggerLogListOptions {
  const errorCode = url.searchParams.get('errorCode') as TriggerErrorCode | null;
  return {
    connectorId: url.searchParams.get('connectorId') ?? undefined,
    status: logStatus(url.searchParams.get('status')),
    errorCode: errorCode ?? undefined,
    method: url.searchParams.get('method') ?? undefined,
    action: logAction(url.searchParams.get('action')),
    query: url.searchParams.get('q') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
  };
}

function emptyStats(connectorId: string): TriggerLogStats {
  return { connectorId, total: 0, ok: 0, error: 0, actions: {}, errorCodes: {} };
}

function normalizeLifecycleExtractors(v: unknown): ConnectorDefinition['lifecycleExtractors'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.dedupKey !== 'string' || !r.dedupKey.trim()) return null;
  return { dedupKey: r.dedupKey.trim() };
}

function sameStringSet(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify([...new Set(left ?? [])].sort())
    === JSON.stringify([...new Set(right ?? [])].sort());
}

function sameConnectorTarget(
  left: ConnectorDefinition['target'],
  right: ConnectorDefinition['target'],
): boolean {
  return left.mode === right.mode
    && left.kind === right.kind
    && left.botId === right.botId
    && left.chatId === right.chatId
    && left.workflowId === right.workflowId
    && sameStringSet(left.botIds, right.botIds)
    && sameStringSet(left.allowChats, right.allowChats);
}

function normalizeConnectorInput(
  raw: unknown,
  opts: { id?: string; prior?: ConnectorDefinition | null; secretRef?: string },
): { ok: true; connector: ConnectorDefinition } | { ok: false; error: string } {
  const body = record(raw);
  const c = record(body.connector ?? body);
  const prior = opts.prior ?? null;
  const targetProvided = hasOwn(c, 'target');
  const verify = record(c.verify ?? prior?.verify);
  const target = record(c.target ?? prior?.target);
  const promptEnvelope = record(c.promptEnvelope ?? prior?.promptEnvelope);
  const loggingPolicy = record(c.loggingPolicy ?? prior?.loggingPolicy);
  const rateLimitCleared = c.rateLimit === null;
  const rateLimit = rateLimitCleared ? null : record(c.rateLimit ?? prior?.rateLimit);
  const id = opts.id ?? (typeof c.id === 'string' && c.id.trim() ? c.id.trim() : prior?.id ?? newConnectorId());
  const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : prior?.name;
  if (!name) return { ok: false, error: 'name_required' };

  const targetMode = typeof target.mode === 'string' ? target.mode : prior?.target.mode ?? 'dynamic';
  if (!['dynamic', 'fixed', 'new-group'].includes(targetMode)) return { ok: false, error: 'bad_target_mode' };
  const targetKind = typeof target.kind === 'string' ? target.kind : prior?.target.kind ?? 'turn';
  if (!['turn', 'workflow'].includes(targetKind)) return { ok: false, error: 'bad_target_kind' };
  const botId = typeof target.botId === 'string' && target.botId.trim() ? target.botId.trim() : prior?.target.botId;
  if (!botId) return { ok: false, error: 'target_bot_required' };
  const botIds = hasOwn(target, 'botIds')
    ? Array.from(new Set(stringList(target.botIds).map(x => x.trim()).filter(Boolean)))
    : prior?.target.botIds;
  const chatId = targetMode === 'fixed'
    ? (typeof target.chatId === 'string' && target.chatId.trim() ? target.chatId.trim() : prior?.target.chatId)
    : undefined;
  if (targetMode === 'fixed' && !chatId) return { ok: false, error: 'fixed_chat_required' };
  const workflowId = targetKind === 'workflow'
    ? (typeof target.workflowId === 'string' && target.workflowId.trim() ? target.workflowId.trim() : prior?.target.workflowId)
    : undefined;
  if (targetKind === 'workflow' && !workflowId) return { ok: false, error: 'workflow_id_required' };
  // Dedup is now OPTIONAL for new-group (null = a fresh group per event).
  const lifecycleExtractors = targetMode === 'new-group'
    ? (c.lifecycleExtractors === undefined
      ? (prior?.lifecycleExtractors ?? null)
      : normalizeLifecycleExtractors(c.lifecycleExtractors))
    : null;

  const secretRef =
    opts.secretRef ||
    (typeof verify.secretRef === 'string' && verify.secretRef.trim() ? verify.secretRef.trim() : prior?.verify.secretRef);
  if (!secretRef) return { ok: false, error: 'secret_required' };

  // Default new connectors to the easy `token` mode; HMAC is the advanced opt-in.
  const verifyType: ConnectorDefinition['verify']['type'] =
    verify.type === 'hmac-sha256' || verify.type === 'token'
      ? verify.type
      : prior?.verify.type ?? 'token';

  const now = new Date().toISOString();
  const next: ConnectorDefinition = {
    id,
    name,
    enabled: bool(c.enabled, prior?.enabled ?? true),
    verify: {
      type: verifyType,
      secretRef,
      signatureHeader: typeof verify.signatureHeader === 'string' && verify.signatureHeader.trim()
        ? verify.signatureHeader.trim().toLowerCase()
        : prior?.verify.signatureHeader ?? DEFAULT_VERIFY_HEADERS.signatureHeader,
      timestampHeader: typeof verify.timestampHeader === 'string' && verify.timestampHeader.trim()
        ? verify.timestampHeader.trim().toLowerCase()
        : prior?.verify.timestampHeader ?? DEFAULT_VERIFY_HEADERS.timestampHeader,
      nonceHeader: typeof verify.nonceHeader === 'string' && verify.nonceHeader.trim()
        ? verify.nonceHeader.trim().toLowerCase()
        : prior?.verify.nonceHeader ?? DEFAULT_VERIFY_HEADERS.nonceHeader,
      toleranceSeconds: positiveInt(verify.toleranceSeconds, prior?.verify.toleranceSeconds ?? DEFAULT_VERIFY_HEADERS.toleranceSeconds, 30, 86_400),
    },
    target: prior?.target.kind === 'workflow' && !targetProvided ? { ...prior.target } : {
      mode: targetMode as ConnectorDefinition['target']['mode'],
      kind: targetKind as ConnectorDefinition['target']['kind'],
      botId,
      ...(botIds && botIds.length > 0 ? { botIds: botIds.includes(botId) ? botIds : [botId, ...botIds] } : {}),
      ...(chatId ? { chatId } : {}),
      ...(targetMode === 'dynamic'
        ? { allowChats: hasOwn(target, 'allowChats') ? stringList(target.allowChats) : (prior?.target.allowChats ?? []) }
        : {}),
      ...(workflowId ? { workflowId } : {}),
    },
    promptEnvelope: {
      sourceName: typeof promptEnvelope.sourceName === 'string' && promptEnvelope.sourceName.trim()
        ? promptEnvelope.sourceName.trim()
        : prior?.promptEnvelope.sourceName ?? name,
      headerAllowlist: hasOwn(promptEnvelope, 'headerAllowlist')
        ? stringList(promptEnvelope.headerAllowlist).map(h => h.toLowerCase())
        : prior?.promptEnvelope.headerAllowlist ?? [],
      includeRawText: bool(promptEnvelope.includeRawText, prior?.promptEnvelope.includeRawText ?? false),
      maxBodyBytes: positiveInt(promptEnvelope.maxBodyBytes, prior?.promptEnvelope.maxBodyBytes ?? 256 * 1024, 1, 10 * 1024 * 1024),
      // A provided string sets/clears the trusted instruction (empty = clear);
      // when the field is absent entirely, keep whatever the prior had.
      ...(typeof promptEnvelope.instruction === 'string'
        ? (promptEnvelope.instruction.trim() ? { instruction: promptEnvelope.instruction.trim().slice(0, 8000) } : {})
        : prior?.promptEnvelope.instruction ? { instruction: prior.promptEnvelope.instruction } : {}),
    },
    loggingPolicy: {
      storePayload: bool(loggingPolicy.storePayload, prior?.loggingPolicy.storePayload ?? true),
      storeHeaders: bool(loggingPolicy.storeHeaders, prior?.loggingPolicy.storeHeaders ?? true),
      retentionDays: positiveInt(loggingPolicy.retentionDays, prior?.loggingPolicy.retentionDays ?? 14, 1, 365),
    },
    lifecycleExtractors,
    ...(rateLimitCleared ? {} : rateLimit && Object.keys(rateLimit).length > 0 ? {
      rateLimit: {
        windowSeconds: positiveInt(rateLimit.windowSeconds, prior?.rateLimit?.windowSeconds ?? 60, 1, 86_400),
        maxRequests: positiveInt(rateLimit.maxRequests, prior?.rateLimit?.maxRequests ?? 60, 1, 100_000),
      },
    } : prior?.rateLimit ? { rateLimit: prior.rateLimit } : {}),
    createdAt: prior?.createdAt ?? now,
    updatedAt: prior?.updatedAt ?? now,
  };

  // Workflow targets belong to the retiring v2 engine. Keep existing assets
  // maintainable during the migration window, but never create a new entry,
  // convert a turn connector into one, or let an existing workflow connector
  // drift to a different target. Non-target fields (name, prompt, secret,
  // enabled state, logging policy, etc.) remain editable.
  if (!prior && next.target.kind === 'workflow') {
    return { ok: false, error: 'legacy_workflow_connector_creation_disabled' };
  }
  if (prior?.target.kind === 'turn' && next.target.kind === 'workflow') {
    return { ok: false, error: 'legacy_workflow_connector_creation_disabled' };
  }
  if (prior?.target.kind === 'workflow' && !sameConnectorTarget(next.target, prior.target)) {
    return { ok: false, error: 'legacy_workflow_connector_target_immutable' };
  }
  return { ok: true, connector: next };
}

function publicWebhookUrl(req: IncomingMessage, connectorId: string, token?: string): string {
  // 远程访问开启且绑定平台后用「机器子域」中心域名（外部/内网可达，经隧道回本机）；否则回退本机 host。
  // 经隧道访问时 req.headers.host 会被平台改写成 127.0.0.1，故必须优先用 binding 推导的中心域名。
  const platformBase = isRemoteAccessEnabled() ? platformMachineBaseUrl() : null;
  let origin: string;
  if (platformBase) {
    origin = platformBase;
  } else {
    const proto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : 'http';
    origin = `${proto}://${req.headers.host ?? 'localhost'}`;
  }
  const base = `${origin}/webhook/${encodeURIComponent(connectorId)}`;
  // token mode: bake the secret into the path so the whole URL is the credential.
  return token ? `${base}/${encodeURIComponent(token)}` : base;
}

export async function handleConnectorApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/connectors') {
    jsonRes(res, 200, { connectors: listConnectors() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/connectors/stats') {
    const since = url.searchParams.get('since') ?? undefined;
    const rawStats = summarizeTriggerLogs({ since });
    const byId = new Map(rawStats.filter(s => s.connectorId).map(s => [s.connectorId!, s]));
    const connectors = listConnectors();
    const known = new Set(connectors.map(c => c.id));
    const stats: Array<TriggerLogStats & { name?: string; enabled?: boolean }> = connectors.map(c => ({
      name: c.name,
      enabled: c.enabled,
      ...emptyStats(c.id),
      ...byId.get(c.id),
    }));
    for (const stat of rawStats) {
      if (!stat.connectorId || !known.has(stat.connectorId)) stats.push(stat);
    }
    jsonRes(res, 200, { stats });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/webhook-secrets') {
    try {
      const body = await readJsonBody<{ secret?: unknown }>(req);
      const secret = typeof body.secret === 'string' && body.secret ? body.secret : generateWebhookSecretPlaintext();
      const record = createWebhookSecret(secret);
      jsonRes(res, 201, { ok: true, secretRef: record.ref, secret });
    } catch (e: any) {
      jsonRes(res, 400, { ok: false, error: e?.message ?? 'bad_json' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/webhook-secrets') {
    jsonRes(res, 200, { secrets: listWebhookSecretRefs() });
    return true;
  }

  let mSecret: RegExpMatchArray | null;
  if ((mSecret = url.pathname.match(/^\/api\/webhook-secrets\/([^/]+)$/))) {
    const ref = decodeURIComponent(mSecret[1]);
    if (req.method === 'PUT') {
      try {
        const body = await readJsonBody<{ secret?: unknown }>(req);
        const secret = typeof body.secret === 'string' && body.secret ? body.secret : generateWebhookSecretPlaintext();
        const record = setWebhookSecret(ref, secret);
        jsonRes(res, 200, { ok: true, secretRef: record.ref, secret });
      } catch (e: any) {
        jsonRes(res, 400, { ok: false, error: e?.message ?? 'bad_json' });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      jsonRes(res, 200, { ok: true, deleted: deleteWebhookSecret(ref) });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/connectors') {
    try {
      const body = await readJsonBody<any>(req);
      const providedSecret = typeof body.secret === 'string' && body.secret ? body.secret : undefined;
      const generatedSecret = providedSecret ? undefined : generateWebhookSecretPlaintext();
      const record = createWebhookSecret(providedSecret ?? generatedSecret!);
      const normalized = normalizeConnectorInput(body, { secretRef: record.ref });
      if (!normalized.ok) {
        deleteWebhookSecret(record.ref);
        jsonRes(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const connector = upsertConnector(normalized.connector);
      const plaintext = providedSecret ?? generatedSecret;
      jsonRes(res, 201, {
        ok: true,
        connector,
        secretRef: record.ref,
        ...(generatedSecret ? { secret: generatedSecret } : {}),
        webhookUrl: publicWebhookUrl(req, connector.id, connector.verify.type === 'token' ? plaintext : undefined),
      });
    } catch (e: any) {
      jsonRes(res, 400, { ok: false, error: e?.message ?? 'bad_json' });
    }
    return true;
  }

  let m: RegExpMatchArray | null;
  if ((m = url.pathname.match(/^\/api\/connectors\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (req.method === 'PUT') {
      const prior = getConnector(id);
      if (!prior) {
        jsonRes(res, 404, { ok: false, error: 'unknown_connector' });
        return true;
      }
      try {
        const body = await readJsonBody<any>(req);
        // Validate the complete update before rotating the secret. In
        // particular, a rejected legacy-workflow target mutation must not
        // leave behind an otherwise successful credential side effect.
        const preflight = normalizeConnectorInput({ ...body, id }, {
          id,
          prior,
          secretRef: prior.verify.secretRef,
        });
        if (!preflight.ok) {
          jsonRes(res, 400, { ok: false, error: preflight.error });
          return true;
        }
        let generatedSecret: string | undefined;
        let secretRef: string | undefined;
        let plaintextForUrl: string | undefined;
        if (typeof body.secret === 'string' && body.secret) {
          secretRef = prior.verify.secretRef || createWebhookSecret(body.secret).ref;
          setWebhookSecret(secretRef, body.secret);
          plaintextForUrl = body.secret;
        } else if (body.rotateSecret === true) {
          generatedSecret = generateWebhookSecretPlaintext();
          secretRef = prior.verify.secretRef || createWebhookSecret(generatedSecret).ref;
          setWebhookSecret(secretRef, generatedSecret);
          plaintextForUrl = generatedSecret;
        }
        const normalized = normalizeConnectorInput({ ...body, id }, { id, prior, secretRef });
        if (!normalized.ok) {
          jsonRes(res, 400, { ok: false, error: normalized.error });
          return true;
        }
        const connector = upsertConnector(normalized.connector);
        jsonRes(res, 200, {
          ok: true,
          connector,
          ...(secretRef ? { secretRef } : {}),
          ...(generatedSecret ? { secret: generatedSecret } : {}),
          webhookUrl: publicWebhookUrl(req, connector.id, connector.verify.type === 'token' ? plaintextForUrl : undefined),
        });
      } catch (e: any) {
        jsonRes(res, 400, { ok: false, error: e?.message ?? 'bad_json' });
      }
      return true;
    }
    if (req.method === 'PATCH') {
      const prior = getConnector(id);
      if (!prior) {
        jsonRes(res, 404, { ok: false, error: 'unknown_connector' });
        return true;
      }
      try {
        const body = await readJsonBody<{ enabled?: unknown }>(req);
        const connector = upsertConnector({ ...prior, enabled: bool(body.enabled, prior.enabled) });
        jsonRes(res, 200, { ok: true, connector });
      } catch (e: any) {
        jsonRes(res, 400, { ok: false, error: e?.message ?? 'bad_json' });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      jsonRes(res, 200, { ok: true, deleted: deleteConnector(id) });
      return true;
    }
  }

  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/connectors\/([^/]+)$/))) {
    const connector = getConnector(decodeURIComponent(m[1]));
    if (!connector) {
      jsonRes(res, 404, { ok: false, error: 'unknown_connector' });
      return true;
    }
    jsonRes(res, 200, { connector });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/trigger-logs/summary') {
    jsonRes(res, 200, { summary: summarizeTriggerLogOverview(triggerLogFilters(url)) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/trigger-logs') {
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    jsonRes(res, 200, queryTriggerLogs({ ...triggerLogFilters(url), limit, offset }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/trigger-logs/prune') {
    try {
      const body = await readJsonBody<{ retentionDays?: unknown; maxEntries?: unknown }>(req);
      const retentionDays = body.retentionDays === undefined
        ? undefined
        : positiveInt(body.retentionDays, 14, 1, 3650);
      const maxEntries = body.maxEntries === undefined
        ? undefined
        : positiveInt(body.maxEntries, 1000, 1, 1_000_000);
      jsonRes(res, 200, { ok: true, ...pruneTriggerLogs({ retentionDays, maxEntries }) });
    } catch (e: any) {
      jsonRes(res, 400, { ok: false, error: e?.message ?? 'bad_json' });
    }
    return true;
  }

  return false;
}
