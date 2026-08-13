/**
 * Authored public-artifact contracts for v3 DAG schemaVersion 2.
 *
 * A stable output key is the only cross-node identifier. Manifest `name`
 * remains presentation metadata; the contract resolves the key to path/kind.
 */

import {
  MANIFEST_FILE_KINDS,
  type Manifest,
  type ManifestFileKind,
} from './artifact-contract.js';

export const V3_ARTIFACT_OUTPUT_KEY_RE = /^[A-Za-z0-9._-]+$/;
export const V3_ARTIFACT_OUTPUT_MAX_COUNT = 32;
export const V3_ARTIFACT_OUTPUT_MAX_BYTES = 4 * 1024;

export interface V3ArtifactOutputDeclaration {
  path: string;
  kind: ManifestFileKind;
}

export type V3ArtifactOutputs = Record<string, V3ArtifactOutputDeclaration>;

export interface V3ArtifactContractValidation {
  ok: boolean;
  problems: string[];
}

export function normalizeArtifactOutputs(
  value: unknown,
  where: string,
  problems: string[],
): V3ArtifactOutputs | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    problems.push(`${where}.outputs must be a non-empty object when present`);
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > V3_ARTIFACT_OUTPUT_MAX_COUNT) {
    problems.push(`${where}.outputs has ${entries.length} entries (max ${V3_ARTIFACT_OUTPUT_MAX_COUNT})`);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf-8') > V3_ARTIFACT_OUTPUT_MAX_BYTES) {
    problems.push(`${where}.outputs exceeds ${V3_ARTIFACT_OUTPUT_MAX_BYTES} serialized bytes`);
  }

  const out: V3ArtifactOutputs = {};
  const paths = new Set<string>();
  for (const [key, raw] of entries) {
    const itemWhere = `${where}.outputs.${JSON.stringify(key)}`;
    if (!V3_ARTIFACT_OUTPUT_KEY_RE.test(key)) {
      problems.push(`${itemWhere} key must match ${V3_ARTIFACT_OUTPUT_KEY_RE}`);
      continue;
    }
    if (!isRecord(raw)) {
      problems.push(`${itemWhere} must be { path, kind }`);
      continue;
    }
    const extra = Object.keys(raw).filter((field) => field !== 'path' && field !== 'kind');
    if (extra.length > 0) {
      problems.push(`${itemWhere} has unsupported key(s): ${extra.join(', ')} (allowed: path, kind)`);
      continue;
    }
    if (!isPortableRelativeArtifactPath(raw.path)) {
      problems.push(`${itemWhere}.path must be a portable relative path without '.', '..', or empty segments`);
      continue;
    }
    if (typeof raw.kind !== 'string' || !(MANIFEST_FILE_KINDS as readonly string[]).includes(raw.kind)) {
      problems.push(`${itemWhere}.kind must be one of ${MANIFEST_FILE_KINDS.join(' | ')}`);
      continue;
    }
    if (paths.has(raw.path)) {
      problems.push(`${where}.outputs contains duplicate path ${JSON.stringify(raw.path)}`);
      continue;
    }
    paths.add(raw.path);
    out[key] = { path: raw.path, kind: raw.kind as ManifestFileKind };
  }
  return out;
}

export function validateManifestArtifactContract(
  outputs: V3ArtifactOutputs | undefined,
  manifest: Manifest,
): V3ArtifactContractValidation {
  if (!outputs) return { ok: true, problems: [] };
  const problems: string[] = [];
  for (const [key, declaration] of Object.entries(outputs)) {
    const matches = manifest.files.filter((file) => file.path === declaration.path);
    if (matches.length === 0) {
      problems.push(
        `output ${JSON.stringify(key)} requires path ${JSON.stringify(declaration.path)} ` +
        `(available: ${manifest.files.map((file) => `${file.path}:${file.kind}`).join(', ') || 'none'})`,
      );
      continue;
    }
    if (matches.length > 1) {
      problems.push(`output ${JSON.stringify(key)} path ${JSON.stringify(declaration.path)} appears more than once`);
      continue;
    }
    if (matches[0].kind !== declaration.kind) {
      problems.push(
        `output ${JSON.stringify(key)} path ${JSON.stringify(declaration.path)} ` +
        `has kind ${JSON.stringify(matches[0].kind)}, expected ${JSON.stringify(declaration.kind)}`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

function isPortableRelativeArtifactPath(value: unknown): value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value.startsWith('/') ||
    value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)
  ) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
