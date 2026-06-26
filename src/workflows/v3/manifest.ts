/**
 * v3 node manifest validator.
 *
 * Goal-mode workers write `manifest.json` at BOTMUX_GOAL_MANIFEST_PATH.
 * The runtime treats that file as untrusted agent output: this module checks
 * the shape, status invariants, path containment, file metadata, and hashes
 * before downstream nodes receive any file paths.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  MANIFEST_FILE_KINDS,
  MANIFEST_PREVIEW_MAX_BYTES,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SUMMARY_MAX_BYTES,
  MANIFEST_STATUSES,
  type Manifest,
  type ManifestFile,
  type ManifestFileKind,
  type ManifestStatus,
} from './contract.js';

export class ManifestValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid v3 manifest:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ManifestValidationError';
  }
}

export async function readAndValidateManifest(
  manifestPath: string,
  outputDir: string,
): Promise<Manifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    throw new ManifestValidationError([
      `manifest not readable at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestValidationError([
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  return validateManifest(parsed, outputDir);
}

export async function validateManifest(value: unknown, outputDir: string): Promise<Manifest> {
  const problems: string[] = [];
  const outputRoot = await canonicalDir(outputDir, problems, 'outputDir');

  if (!isRecord(value)) {
    throw new ManifestValidationError(['manifest root must be an object']);
  }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION} (got ${JSON.stringify(schemaVersion)})`);
  }

  const status = value.status;
  if (typeof status !== 'string' || !isManifestStatus(status)) {
    problems.push(`status must be one of ${MANIFEST_STATUSES.join(' | ')} (got ${JSON.stringify(status)})`);
  }

  const summary = normalizeString(value.summary, 'summary', MANIFEST_SUMMARY_MAX_BYTES, problems);
  const filesRaw = value.files;
  if (!Array.isArray(filesRaw)) {
    problems.push('files must be an array');
  }

  const error = normalizeError(value.error, problems);
  const files: ManifestFile[] = [];

  if (Array.isArray(filesRaw)) {
    for (let i = 0; i < filesRaw.length; i++) {
      const file = await normalizeFile(filesRaw[i], i, outputRoot, problems);
      if (file) files.push(file);
    }
  }

  if (status === 'ok') {
    if (files.length < 1) problems.push('status "ok" requires at least one file');
    if (value.error !== undefined) problems.push('status "ok" must not include error');
  } else if (status === 'fail') {
    if (!error) problems.push('status "fail" requires error');
  }

  if (problems.length > 0) throw new ManifestValidationError(problems);

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    status: status as ManifestStatus,
    summary,
    ...(error ? { error } : {}),
    files,
  };
}

export function resolveManifestFilePath(outputDir: string, relativePath: string): string {
  return resolve(outputDir, relativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function canonicalDir(path: string, problems: string[], label: string): Promise<string> {
  try {
    const st = await fs.stat(path);
    if (!st.isDirectory()) {
      problems.push(`${label} is not a directory: ${path}`);
      return resolve(path);
    }
    return await fs.realpath(path);
  } catch (err) {
    problems.push(`${label} is not accessible at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return resolve(path);
  }
}

function normalizeString(
  value: unknown,
  field: string,
  maxBytes: number,
  problems: string[],
): string {
  if (typeof value !== 'string') {
    problems.push(`${field} must be a string`);
    return '';
  }
  return truncateUtf8(value, maxBytes);
}

function normalizeError(
  value: unknown,
  problems: string[],
): Manifest['error'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push('error must be an object when present');
    return undefined;
  }
  const code = value.code;
  const message = value.message;
  const retryable = value.retryable;
  if (typeof code !== 'string' || code.trim() === '') problems.push('error.code must be a non-empty string');
  if (typeof message !== 'string' || message.trim() === '') problems.push('error.message must be a non-empty string');
  if (retryable !== undefined && typeof retryable !== 'boolean') problems.push('error.retryable must be boolean when present');
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  return {
    code,
    message,
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
  };
}

async function normalizeFile(
  value: unknown,
  index: number,
  outputRoot: string,
  problems: string[],
): Promise<ManifestFile | undefined> {
  const prefix = `files[${index}]`;
  if (!isRecord(value)) {
    problems.push(`${prefix} must be an object`);
    return undefined;
  }

  const name = value.name;
  const path = value.path;
  const kind = value.kind;
  const bytes = value.bytes;
  const sha256 = value.sha256;
  const mime = value.mime;

  if (typeof name !== 'string' || name.trim() === '') problems.push(`${prefix}.name must be a non-empty string`);
  if (typeof path !== 'string' || path.trim() === '') problems.push(`${prefix}.path must be a non-empty relative string`);
  if (typeof kind !== 'string' || !isManifestFileKind(kind)) {
    problems.push(`${prefix}.kind must be one of ${MANIFEST_FILE_KINDS.join(' | ')}`);
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    problems.push(`${prefix}.bytes must be a non-negative integer`);
  }
  if (typeof sha256 !== 'string') problems.push(`${prefix}.sha256 must be a string`);
  if (typeof mime !== 'string' || mime.trim() === '') problems.push(`${prefix}.mime must be a non-empty string`);

  const preview =
    value.preview === undefined
      ? undefined
      : normalizeString(value.preview, `${prefix}.preview`, MANIFEST_PREVIEW_MAX_BYTES, problems);

  if (typeof path === 'string') {
    await validateFileOnDisk(prefix, outputRoot, path, kind, bytes, sha256, problems);
  }

  if (
    typeof name !== 'string' ||
    typeof path !== 'string' ||
    typeof kind !== 'string' ||
    !isManifestFileKind(kind) ||
    typeof bytes !== 'number' ||
    typeof sha256 !== 'string' ||
    typeof mime !== 'string'
  ) {
    return undefined;
  }

  return {
    name,
    path,
    kind,
    bytes,
    sha256,
    mime,
    ...(preview !== undefined ? { preview } : {}),
  };
}

async function validateFileOnDisk(
  prefix: string,
  outputRoot: string,
  relativePath: string,
  kind: unknown,
  bytes: unknown,
  sha256: unknown,
  problems: string[],
): Promise<void> {
  if (isAbsolute(relativePath)) {
    problems.push(`${prefix}.path must be relative to outputDir`);
    return;
  }
  if (relativePath.includes('\0')) {
    problems.push(`${prefix}.path must not contain NUL bytes`);
    return;
  }

  const candidate = resolveManifestFilePath(outputRoot, relativePath);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err) {
    problems.push(`${prefix}.path does not exist under outputDir: ${relativePath} (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  if (!isPathInside(outputRoot, real)) {
    problems.push(`${prefix}.path escapes outputDir: ${relativePath}`);
    return;
  }

  let st;
  try {
    st = await fs.stat(real);
  } catch (err) {
    problems.push(`${prefix}.path is not stat-able: ${relativePath} (${err instanceof Error ? err.message : String(err)})`);
    return;
  }

  if (kind === 'directory') {
    if (!st.isDirectory()) problems.push(`${prefix}.kind is directory but path is not a directory`);
    if (sha256 !== '') problems.push(`${prefix}.sha256 must be "" for directory entries`);
    return;
  }

  if (st.isDirectory()) {
    problems.push(`${prefix}.path is a directory but kind is ${JSON.stringify(kind)}`);
    return;
  }
  if (!st.isFile()) {
    problems.push(`${prefix}.path must be a regular file or directory`);
    return;
  }
  if (typeof bytes === 'number' && st.size !== bytes) {
    problems.push(`${prefix}.bytes mismatch: manifest=${bytes}, actual=${st.size}`);
  }
  if (typeof sha256 === 'string') {
    const actual = await sha256File(real);
    if (actual !== sha256) problems.push(`${prefix}.sha256 mismatch`);
  }
}

function isManifestFileKind(value: string): value is ManifestFileKind {
  return (MANIFEST_FILE_KINDS as readonly string[]).includes(value);
}

function isManifestStatus(value: string): value is ManifestStatus {
  return (MANIFEST_STATUSES as readonly string[]).includes(value);
}

function isPathInside(parentReal: string, childReal: string): boolean {
  const parent = parentReal.endsWith('/') ? parentReal : `${parentReal}/`;
  return childReal === parentReal || childReal.startsWith(parent);
}

async function sha256File(path: string): Promise<string> {
  const buf = await fs.readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf-8');
  if (buf.length <= maxBytes) return value;
  return buf.subarray(0, maxBytes).toString('utf-8').replace(/\uFFFD+$/g, '');
}
