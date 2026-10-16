import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import { resolveBotmuxDataDir } from '../../data-dir.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import type { TrustedResultDelivery } from './trusted-result-delivery.js';

export const DEFAULT_PLUGIN_RESULT_TTL_MS = 30 * 60_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

export interface PluginResultArtifactManifest {
  schemaVersion: 1;
  artifactId: string;
  viewId: string;
  deliveryId: string;
  pluginId: string;
  owner: {
    unionId: string;
    openId?: string;
    larkAppId: string;
  };
  context: {
    sessionId: string;
    turnId: string;
    dispatchAttempt?: number;
  };
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  summaryFile?: string;
  files: Array<{ name: string; storedName: string; size: number; sha256: string }>;
}

export interface CreatedPluginResultArtifact {
  artifactId: string;
  viewId: string;
  viewToken: string;
  expiresAt: string;
  fileCount: number;
}

export interface PluginResultArtifactStoreOptions {
  dataDir?: string;
  now?: () => number;
  ttlMs?: number;
  randomToken?: () => string;
  randomId?: () => string;
}

function safeTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new RangeError('plugin result TTL must be between 1 minute and 24 hours');
  }
  return value;
}

function tokenDigest(token: string): string {
  return createHash('sha256')
    .update('botmux-plugin-result-view-v1\0')
    .update(token)
    .digest('hex');
}

function validOpaque(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,256}$/.test(value);
}

function validUnionId(value: string): boolean {
  return /^on_[A-Za-z0-9_-]{6,128}$/.test(value);
}

function safeStoredName(index: number, name: string): string {
  const leaf = basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'attachment';
  return `${String(index).padStart(3, '0')}-${leaf}`;
}

export class PluginResultArtifactStore {
  readonly root: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;

  constructor(opts: PluginResultArtifactStoreOptions = {}) {
    this.root = join(opts.dataDir ?? resolveBotmuxDataDir(), 'plugin-result-artifacts');
    this.now = opts.now ?? Date.now;
    this.ttlMs = safeTtl(opts.ttlMs ?? DEFAULT_PLUGIN_RESULT_TTL_MS);
    this.randomToken = opts.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.randomId = opts.randomId ?? (() => randomUUID().replaceAll('-', ''));
  }

  create(input: {
    pluginId: string;
    delivery: TrustedResultDelivery;
    ownerUnionId: string;
    ownerOpenId?: string;
    larkAppId: string;
    sessionId: string;
    turnId: string;
    dispatchAttempt?: number;
  }): CreatedPluginResultArtifact {
    if (!validUnionId(input.ownerUnionId)) throw new Error('invalid_plugin_result_owner');
    mkdirSync(join(this.root, 'artifacts'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, 'tokens'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, 'views'), { recursive: true, mode: 0o700 });

    const artifactId = this.randomId();
    const viewId = this.randomId();
    const viewToken = this.randomToken();
    if (!validOpaque(artifactId) || !validOpaque(viewId) || !validOpaque(viewToken)) {
      throw new Error('invalid_plugin_result_random_source');
    }
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + this.ttlMs;
    const artifactDir = join(this.root, 'artifacts', artifactId);
    mkdirSync(join(artifactDir, 'files'), { recursive: true, mode: 0o700 });

    let summaryFile: string | undefined;
    if (input.delivery.markdown?.trim()) {
      summaryFile = 'summary.md';
      writeFileSync(join(artifactDir, summaryFile), input.delivery.markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    const files = (input.delivery.files ?? []).map((file, index) => {
      const storedName = safeStoredName(index, file.name);
      writeFileSync(join(artifactDir, 'files', storedName), file.data, { mode: 0o600, flag: 'wx' });
      return {
        name: file.name,
        storedName,
        size: file.data.byteLength,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      };
    });
    const manifest: PluginResultArtifactManifest = {
      schemaVersion: 1,
      artifactId,
      viewId,
      deliveryId: input.delivery.deliveryId,
      pluginId: input.pluginId,
      owner: {
        unionId: input.ownerUnionId,
        ...(input.ownerOpenId ? { openId: input.ownerOpenId } : {}),
        larkAppId: input.larkAppId,
      },
      context: {
        sessionId: input.sessionId,
        turnId: input.turnId,
        ...(input.dispatchAttempt !== undefined ? { dispatchAttempt: input.dispatchAttempt } : {}),
      },
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(summaryFile ? { summaryFile } : {}),
      files,
    };
    atomicWriteFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest), {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
    atomicWriteFileSync(join(this.root, 'views', `${viewId}.json`), JSON.stringify({ artifactId }), {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
    const tokenPath = join(this.root, 'tokens', `${tokenDigest(viewToken)}.json`);
    writeFileSync(tokenPath, JSON.stringify({ artifactId }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(tokenPath, 0o600);
    return { artifactId, viewId, viewToken, expiresAt: manifest.expiresAt, fileCount: files.length };
  }

  redeem(viewToken: string, viewerUnionId: string): PluginResultArtifactManifest {
    if (!validOpaque(viewToken) || !validUnionId(viewerUnionId)) throw new Error('plugin_result_access_denied');
    const digest = tokenDigest(viewToken);
    const activePath = join(this.root, 'tokens', `${digest}.json`);
    const usedPath = join(this.root, 'tokens', `${digest}.used`);
    if (!existsSync(activePath) && existsSync(usedPath)) throw new Error('plugin_result_token_replayed');
    const ref = this.readRef(activePath);
    const manifest = this.readManifest(ref.artifactId);
    this.assertAccessible(manifest, viewerUnionId);
    try {
      renameSync(activePath, usedPath);
    } catch {
      throw new Error('plugin_result_token_replayed');
    }
    return manifest;
  }

  resolveView(viewId: string, viewerUnionId: string): PluginResultArtifactManifest {
    if (!validOpaque(viewId) || !validUnionId(viewerUnionId)) throw new Error('plugin_result_access_denied');
    const ref = this.readRef(join(this.root, 'views', `${viewId}.json`));
    const manifest = this.readManifest(ref.artifactId);
    if (manifest.viewId !== viewId) throw new Error('plugin_result_access_denied');
    this.assertAccessible(manifest, viewerUnionId);
    return manifest;
  }

  readSummary(manifest: PluginResultArtifactManifest): string | undefined {
    if (!manifest.summaryFile) return undefined;
    return readFileSync(join(this.root, 'artifacts', manifest.artifactId, manifest.summaryFile), 'utf8');
  }

  filePath(manifest: PluginResultArtifactManifest, index: number): { path: string; name: string; size: number } {
    const file = manifest.files[index];
    if (!file) throw new Error('plugin_result_file_not_found');
    return {
      path: join(this.root, 'artifacts', manifest.artifactId, 'files', file.storedName),
      name: file.name,
      size: file.size,
    };
  }

  revoke(artifactId: string): void {
    const manifest = this.readManifest(artifactId);
    if (manifest.revokedAt) return;
    manifest.revokedAt = new Date(this.now()).toISOString();
    atomicWriteFileSync(join(this.root, 'artifacts', artifactId, 'manifest.json'), JSON.stringify(manifest), {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }

  private readRef(path: string): { artifactId: string } {
    if (!existsSync(path)) throw new Error('plugin_result_access_denied');
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('plugin_result_access_denied'); }
    const artifactId = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { artifactId?: unknown }).artifactId
      : undefined;
    if (typeof artifactId !== 'string' || !validOpaque(artifactId)) throw new Error('plugin_result_access_denied');
    return { artifactId };
  }

  private readManifest(artifactId: string): PluginResultArtifactManifest {
    if (!validOpaque(artifactId)) throw new Error('plugin_result_access_denied');
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.root, 'artifacts', artifactId, 'manifest.json'), 'utf8'));
    } catch {
      throw new Error('plugin_result_access_denied');
    }
    const manifest = parsed as PluginResultArtifactManifest;
    if (!manifest || manifest.schemaVersion !== 1 || manifest.artifactId !== artifactId) {
      throw new Error('plugin_result_access_denied');
    }
    return manifest;
  }

  private assertAccessible(manifest: PluginResultArtifactManifest, viewerUnionId: string): void {
    if (manifest.owner.unionId !== viewerUnionId) throw new Error('plugin_result_access_denied');
    if (manifest.revokedAt) throw new Error('plugin_result_revoked');
    const expiresAt = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(expiresAt) || this.now() >= expiresAt) throw new Error('plugin_result_expired');
  }
}
