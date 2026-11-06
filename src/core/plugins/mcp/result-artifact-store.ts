import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import { resolveBotmuxDataDir } from '../../data-dir.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { withFileLockSync } from '../../../utils/file-lock.js';
import type { TrustedResultDelivery } from './trusted-result-delivery.js';

export const DEFAULT_PLUGIN_RESULT_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_PLUGIN_RESULT_STORE_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_PLUGIN_RESULT_STORE_MAX_ARTIFACTS = 1_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60_000;

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
  tokenDigest: string;
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
  maxStoreBytes?: number;
  maxArtifacts?: number;
  randomToken?: () => string;
  randomId?: () => string;
}

function safeTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new RangeError('plugin result TTL must be between 1 minute and 30 days');
  }
  return value;
}

function safePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
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
  private readonly maxStoreBytes: number;
  private readonly maxArtifacts: number;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;

  constructor(opts: PluginResultArtifactStoreOptions = {}) {
    this.root = join(opts.dataDir ?? resolveBotmuxDataDir(), 'plugin-result-artifacts');
    this.now = opts.now ?? Date.now;
    this.ttlMs = safeTtl(opts.ttlMs ?? DEFAULT_PLUGIN_RESULT_TTL_MS);
    this.maxStoreBytes = safePositiveInteger(
      opts.maxStoreBytes ?? DEFAULT_PLUGIN_RESULT_STORE_MAX_BYTES,
      'plugin result store byte quota',
    );
    this.maxArtifacts = safePositiveInteger(
      opts.maxArtifacts ?? DEFAULT_PLUGIN_RESULT_STORE_MAX_ARTIFACTS,
      'plugin result store artifact quota',
    );
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
    this.ensureRoots();
    return withFileLockSync(join(this.root, 'store-index'), () => {
      this.sweepExpiredUnlocked();
      const artifactRoot = join(this.root, 'artifacts');
      const artifactCount = readdirSync(artifactRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
      if (artifactCount >= this.maxArtifacts) throw new Error('plugin_result_store_artifact_quota_exceeded');

      const artifactId = this.randomId();
      const viewId = this.randomId();
      const viewToken = this.randomToken();
      if (!validOpaque(artifactId) || !validOpaque(viewId) || !validOpaque(viewToken)) {
        throw new Error('invalid_plugin_result_random_source');
      }
      const digest = tokenDigest(viewToken);
      const createdAtMs = this.now();
      const expiresAtMs = createdAtMs + this.ttlMs;
      const artifactDir = join(artifactRoot, artifactId);
      const viewPath = join(this.root, 'views', `${viewId}.json`);
      const tokenPath = join(this.root, 'tokens', `${digest}.json`);
      mkdirSync(artifactDir, { mode: 0o700 });
      mkdirSync(join(artifactDir, 'files'), { mode: 0o700 });
      try {
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
          tokenDigest: digest,
          ...(summaryFile ? { summaryFile } : {}),
          files,
        };
        atomicWriteFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest), {
          mode: 0o600,
          durable: true,
          followTargetSymlink: false,
        });
        atomicWriteFileSync(viewPath, JSON.stringify({ artifactId }), {
          mode: 0o600,
          durable: true,
          followTargetSymlink: false,
        });
        writeFileSync(tokenPath, JSON.stringify({ artifactId }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        chmodSync(tokenPath, 0o600);
        if (this.storeBytes() > this.maxStoreBytes) throw new Error('plugin_result_store_byte_quota_exceeded');
        return { artifactId, viewId, viewToken, expiresAt: manifest.expiresAt, fileCount: files.length };
      } catch (error) {
        rmSync(artifactDir, { recursive: true, force: true });
        rmSync(viewPath, { force: true });
        rmSync(tokenPath, { force: true });
        throw error;
      }
    });
  }

  redeem(viewToken: string, viewerUnionId: string): PluginResultArtifactManifest {
    if (!validOpaque(viewToken) || !validUnionId(viewerUnionId)) throw new Error('plugin_result_access_denied');
    const digest = tokenDigest(viewToken);
    const activePath = join(this.root, 'tokens', `${digest}.json`);
    const ref = this.readRef(activePath);
    const manifest = this.readManifest(ref.artifactId);
    this.assertAccessible(manifest, viewerUnionId);
    return manifest;
  }

  /** Remove expired/revoked artifacts and dangling access references. */
  sweepExpired(): void {
    this.ensureRoots();
    withFileLockSync(join(this.root, 'store-index'), () => this.sweepExpiredUnlocked());
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
    if (
      !manifest
      || manifest.schemaVersion !== 1
      || manifest.artifactId !== artifactId
      || !validOpaque(manifest.viewId)
      || !/^[a-f0-9]{64}$/.test(manifest.tokenDigest)
      || !validUnionId(manifest.owner?.unionId)
      || (manifest.summaryFile !== undefined && manifest.summaryFile !== 'summary.md')
      || !Array.isArray(manifest.files)
      || manifest.files.length > 8
      || manifest.files.some(file => (
        !file
        || typeof file.name !== 'string'
        || typeof file.storedName !== 'string'
        || basename(file.storedName) !== file.storedName
        || !Number.isSafeInteger(file.size)
        || file.size < 0
        || !/^[a-f0-9]{64}$/.test(file.sha256)
      ))
    ) {
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

  private ensureRoots(): void {
    mkdirSync(join(this.root, 'artifacts'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, 'tokens'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, 'views'), { recursive: true, mode: 0o700 });
  }

  private sweepExpiredUnlocked(): void {
    const now = this.now();
    for (const entry of readdirSync(join(this.root, 'artifacts'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !validOpaque(entry.name)) continue;
      const artifactDir = join(this.root, 'artifacts', entry.name);
      let manifest: PluginResultArtifactManifest | undefined;
      try { manifest = this.readManifest(entry.name); } catch { continue; }
      const expiresAt = Date.parse(manifest.expiresAt);
      if (!manifest.revokedAt && Number.isFinite(expiresAt) && now < expiresAt) continue;
      rmSync(artifactDir, { recursive: true, force: true });
      rmSync(join(this.root, 'views', `${manifest.viewId}.json`), { force: true });
      rmSync(join(this.root, 'tokens', `${manifest.tokenDigest}.json`), { force: true });
    }
    this.sweepReferences(join(this.root, 'views'), '.json');
    this.sweepReferences(join(this.root, 'tokens'), '.json');
  }

  private sweepReferences(directory: string, suffix: string): void {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(suffix)) continue;
      const path = join(directory, name);
      try {
        const ref = this.readRef(path);
        if (!existsSync(join(this.root, 'artifacts', ref.artifactId))) unlinkSync(path);
      } catch { rmSync(path, { force: true }); }
    }
  }

  private storeBytes(path = this.root): number {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += this.storeBytes(child);
      else if (entry.isFile() && !entry.isSymbolicLink()) total += lstatSync(child).size;
    }
    return total;
  }
}
