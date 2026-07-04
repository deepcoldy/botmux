import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export type ConnectorVerifyType = 'hmac-sha256' | 'token';
export type ConnectorTargetMode = 'dynamic' | 'fixed' | 'new-group';
export type ConnectorTargetKind = 'turn' | 'workflow';

export interface ConnectorDefinition {
  id: string;
  name: string;
  enabled: boolean;
  // (No "source type" — all webhook sources are treated uniformly. The human
  // label is promptEnvelope.sourceName.)
  verify: {
    type: ConnectorVerifyType;
    secretRef: string;
    signatureHeader: string;
    timestampHeader: string;
    nonceHeader: string;
    toleranceSeconds: number;
  };
  target: {
    mode: ConnectorTargetMode;
    kind: ConnectorTargetKind;
    botId: string;
    botIds?: string[];
    chatId?: string;
    allowChats?: string[];
    workflowId?: string;
  };
  promptEnvelope: {
    sourceName: string;
    headerAllowlist: string[];
    includeRawText: boolean;
    maxBodyBytes: number;
    // Trusted task ("what should the bot do with this event"); injected above the
    // untrusted event data when a turn fires. Empty/absent = no extra instruction.
    instruction?: string;
  };
  loggingPolicy: {
    storePayload: boolean;
    storeHeaders: boolean;
    retentionDays: number;
  };
  // new-group dedup: null = no dedup (every event → a fresh group); { dedupKey }
  // = events whose payload yields the same value at `dedupKey` share one group.
  lifecycleExtractors: null | {
    dedupKey: string;
  };
  rateLimit?: {
    windowSeconds: number;
    maxRequests: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorStoreFile {
  version: 1;
  connectors: ConnectorDefinition[];
}

function storePath(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'connectors.json');
}

function emptyStore(): ConnectorStoreFile {
  return { version: 1, connectors: [] };
}

function normalizeStore(raw: unknown): ConnectorStoreFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  const r = raw as Partial<ConnectorStoreFile>;
  return {
    version: 1,
    connectors: Array.isArray(r.connectors)
      ? r.connectors.filter((c): c is ConnectorDefinition => !!c && typeof c === 'object' && typeof (c as any).id === 'string')
      : [],
  };
}

export function readConnectorStore(dataDir: string = config.session.dataDir): ConnectorStoreFile {
  const fp = storePath(dataDir);
  if (!existsSync(fp)) return emptyStore();
  try {
    return normalizeStore(JSON.parse(readFileSync(fp, 'utf-8')));
  } catch {
    return emptyStore();
  }
}

function writeConnectorStore(dataDir: string, store: ConnectorStoreFile): void {
  const fp = storePath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalizeStore(store), null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, fp);
}

export function listConnectors(dataDir: string = config.session.dataDir): ConnectorDefinition[] {
  return readConnectorStore(dataDir).connectors;
}

export function getConnector(id: string, dataDir: string = config.session.dataDir): ConnectorDefinition | null {
  if (!id) return null;
  return listConnectors(dataDir).find(c => c.id === id) ?? null;
}

export function upsertConnector(
  connector: ConnectorDefinition,
  dataDir: string = config.session.dataDir,
): ConnectorDefinition {
  if (!connector.id) throw new Error('connector id is required');
  const now = new Date().toISOString();
  const store = readConnectorStore(dataDir);
  const idx = store.connectors.findIndex(c => c.id === connector.id);
  const prior = idx >= 0 ? store.connectors[idx] : undefined;
  const next: ConnectorDefinition = {
    ...connector,
    createdAt: connector.createdAt || prior?.createdAt || now,
    updatedAt: now,
  };
  if (idx >= 0) store.connectors[idx] = next;
  else store.connectors.push(next);
  writeConnectorStore(dataDir, store);
  return next;
}

export function deleteConnector(id: string, dataDir: string = config.session.dataDir): boolean {
  const store = readConnectorStore(dataDir);
  const before = store.connectors.length;
  store.connectors = store.connectors.filter(c => c.id !== id);
  if (store.connectors.length === before) return false;
  writeConnectorStore(dataDir, store);
  return true;
}

export function newConnectorId(): string {
  return `conn_${randomUUID()}`;
}
