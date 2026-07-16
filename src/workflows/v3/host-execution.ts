/** Durable artifacts and provider-neutral helpers for v3 host execution. */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, computeInputHash } from '../../utils/canonical-input-hash.js';
import {
  fsyncDirectorySyncPortable,
  fsyncRegularFileSync,
} from '../../utils/fs-durability.js';
import { deriveIdempotencyKey } from '../shared/idempotency-key.js';
import type { RegisteredHostExecutor } from '../hostExecutors/registry.js';
import type { Manifest } from './contract.js';

export const V3_HOST_INPUT_SCHEMA_VERSION = 1 as const;
/** P0 gates render the complete redacted payload inline. Refuse larger inputs
 * before gate dispatch rather than asking a human to approve truncated bytes. */
export const V3_MAX_APPROVABLE_HOST_INPUT_BYTES = 8_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const INPUT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export interface V3PreparedHostInput {
  schemaVersion: typeof V3_HOST_INPUT_SCHEMA_VERSION;
  runId: string;
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  provider: string;
  parsedInput: unknown;
  canonicalInput: unknown;
  inputHash: string;
  idempotencyKey: string;
  idempotencyTtlMs: number;
  approvalDigest: string;
}

export interface V3PreparedHostInputArtifact {
  prepared: V3PreparedHostInput;
  inputRef: { path: string; sha256: string; bytes: number };
  absolutePath: string;
}

export interface V3HostSuccessResult {
  schemaVersion: 1;
  runId: string;
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  provider: string;
  idempotencyKey: string;
  inputHash: string;
  approvalDigest: string;
  output: unknown;
  externalRefs: Record<string, unknown>;
}

function deriveV3HostEffectIdentity(input: {
  runId: string;
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  inputHash: string;
}): { idempotencyKey: string; approvalDigest: string } {
  const idempotencyKey = deriveIdempotencyKey({
    workflowId: 'v3-host',
    revisionId: 'v1',
    runId: input.runId,
    nodeId: input.instanceId,
    attemptId: input.attemptId,
  }, { namespace: 'wf3_' });
  const approvalDigest = computeInputHash({
    v: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    attemptId: input.attemptId,
    executor: input.executor,
    inputHash: input.inputHash,
  });
  return { idempotencyKey, approvalDigest };
}

export function prepareV3HostInputArtifact<I, O>(input: {
  runDir: string;
  attemptDir: string;
  runId: string;
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executorName: string;
  resolvedInput: unknown;
  registered: RegisteredHostExecutor<I, O>;
}): V3PreparedHostInputArtifact {
  const parsedInput = input.registered.parseInput(input.resolvedInput);
  const canonicalInput = input.registered.executor.canonicalInput(parsedInput);
  // Proves both values are finite plain JSON before they become durable input.
  canonicalJson(parsedInput);
  canonicalJson(canonicalInput);
  if (Buffer.byteLength(JSON.stringify(parsedInput), 'utf-8') > V3_MAX_APPROVABLE_HOST_INPUT_BYTES) {
    throw new Error(
      `v3 host input exceeds ${V3_MAX_APPROVABLE_HOST_INPUT_BYTES} bytes; ` +
      'split the side effect so each approval card can show the complete payload',
    );
  }
  const inputHash = computeInputHash(canonicalInput);
  const { idempotencyKey, approvalDigest } = deriveV3HostEffectIdentity({
    runId: input.runId,
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    attemptId: input.attemptId,
    executor: input.executorName,
    inputHash,
  });
  const prepared: V3PreparedHostInput = {
    schemaVersion: V3_HOST_INPUT_SCHEMA_VERSION,
    runId: input.runId,
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    attemptId: input.attemptId,
    executor: input.executorName,
    provider: input.registered.executor.provider,
    parsedInput,
    canonicalInput,
    inputHash,
    idempotencyKey,
    idempotencyTtlMs: input.registered.executor.idempotencyTtlMs,
    approvalDigest,
  };
  const absolutePath = join(input.attemptDir, 'host-input.json');
  assertPathInside(input.runDir, input.attemptDir);
  ensureSecureDirectoryTree(input.runDir, input.attemptDir);
  const content = `${JSON.stringify(prepared, null, 2)}\n`;
  writeCreateOrVerify(absolutePath, content, 0o600, 'host input');
  const existing = readFileSync(absolutePath, 'utf-8');
  if (canonicalJson(parsePreparedHostInput(JSON.parse(existing))) !== canonicalJson(prepared)) {
    throw new Error(`v3 host input conflict at ${absolutePath}; refusing to overwrite prepared bytes`);
  }
  fsyncRegularFileSync(absolutePath);
  fsyncDirectorySyncPortable(input.attemptDir);
  const bytes = readFileSync(absolutePath);
  return {
    prepared,
    inputRef: {
      path: relative(input.runDir, absolutePath),
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
    absolutePath,
  };
}

/**
 * Adopt the durable sidecar left by a crash between file fsync and the
 * `hostInputPrepared` journal append. The sidecar is the freeze commit: never
 * resolve upstream bindings or parse relative time again in this window.
 *
 * This reader does not trust fields merely because they are self-consistent.
 * It re-derives the input hash, idempotency key and approval digest from the
 * expected run/attempt identity, then applies the same schema/provider drift
 * checks as normal journal-backed replay.
 */
export function readCrashLeftV3PreparedHostInput<I, O>(input: {
  runDir: string;
  attemptDir: string;
  runId: string;
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executorName: string;
  registered: RegisteredHostExecutor<I, O>;
}): V3PreparedHostInputArtifact | undefined {
  const absolutePath = join(input.attemptDir, 'host-input.json');
  if (!existsSync(absolutePath)) return undefined;
  assertPathInside(input.runDir, input.attemptDir);
  assertSecureExistingPath(input.runDir, absolutePath, 'host input');
  assertRegularFile(absolutePath, 'host input');
  const bytes = readFileSync(absolutePath);
  let prepared: V3PreparedHostInput;
  try {
    prepared = parsePreparedHostInput(JSON.parse(bytes.toString('utf-8')));
  } catch (err) {
    throw new Error(
      `v3 crash-left host input is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const inputHash = computeInputHash(prepared.canonicalInput);
  const identity = deriveV3HostEffectIdentity({
    runId: input.runId,
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    attemptId: input.attemptId,
    executor: input.executorName,
    inputHash,
  });
  const inputRef = {
    path: relative(input.runDir, absolutePath),
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
  return readAndVerifyV3PreparedHostInput({
    runDir: input.runDir,
    inputRef,
    expected: {
      runId: input.runId,
      nodeId: input.nodeId,
      instanceId: input.instanceId,
      attemptId: input.attemptId,
      executor: input.executorName,
      provider: input.registered.executor.provider,
      inputHash,
      idempotencyKey: identity.idempotencyKey,
      idempotencyTtlMs: input.registered.executor.idempotencyTtlMs,
      approvalDigest: identity.approvalDigest,
    },
    registered: input.registered,
  });
}

export function readAndVerifyV3PreparedHostInput<I, O>(input: {
  runDir: string;
  inputRef: { path: string; sha256: string; bytes: number };
  expected: {
    runId: string;
    nodeId: string;
    instanceId: string;
    attemptId: string;
    executor: string;
    provider: string;
    inputHash: string;
    idempotencyKey: string;
    idempotencyTtlMs: number;
    approvalDigest: string;
  };
  registered: RegisteredHostExecutor<I, O>;
}): V3PreparedHostInputArtifact {
  if (isAbsolute(input.inputRef.path) || input.inputRef.path.includes('\0')) {
    throw new Error('v3 host inputRef.path must be run-relative');
  }
  const absolutePath = resolve(input.runDir, input.inputRef.path);
  assertPathInside(input.runDir, absolutePath);
  assertSecureExistingPath(input.runDir, absolutePath, 'host input');
  assertRegularFile(absolutePath, 'host input');
  const bytes = readFileSync(absolutePath);
  if (bytes.length !== input.inputRef.bytes || sha256(bytes) !== input.inputRef.sha256) {
    throw new Error('v3 host input sidecar bytes/hash mismatch');
  }
  const prepared = parsePreparedHostInput(JSON.parse(bytes.toString('utf-8')));
  if (input.registered.executor.provider !== prepared.provider) {
    throw new Error('v3 host provider registration changed since input approval');
  }
  if (input.registered.executor.idempotencyTtlMs !== prepared.idempotencyTtlMs) {
    throw new Error('v3 host provider idempotency TTL changed since input approval');
  }
  for (const key of [
    'runId', 'nodeId', 'instanceId', 'attemptId', 'executor', 'provider',
    'inputHash', 'idempotencyKey', 'idempotencyTtlMs', 'approvalDigest',
  ] as const) {
    if (prepared[key] !== input.expected[key]) {
      throw new Error(`v3 host input ${key} does not match durable journal intent`);
    }
  }
  const reparsed = input.registered.parseInput(prepared.parsedInput);
  const canonicalInput = input.registered.executor.canonicalInput(reparsed);
  if (canonicalJson(reparsed) !== canonicalJson(prepared.parsedInput)) {
    throw new Error('v3 host input parse/schema drift changed the prepared payload');
  }
  if (canonicalJson(canonicalInput) !== canonicalJson(prepared.canonicalInput)) {
    throw new Error('v3 host canonicalization drift changed the prepared payload');
  }
  if (computeInputHash(canonicalInput) !== prepared.inputHash) {
    throw new Error('v3 host canonical input hash mismatch');
  }
  return { prepared, inputRef: input.inputRef, absolutePath };
}

export function writeV3HostSuccessArtifacts(input: {
  runDir: string;
  attemptDir: string;
  runId: string;
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  provider: string;
  idempotencyKey: string;
  inputHash: string;
  approvalDigest: string;
  output: unknown;
  externalRefs: Record<string, unknown>;
}): { manifestPath: string; resultPath: string } {
  canonicalJson(input.output);
  canonicalJson(input.externalRefs);
  const outputDir = join(input.attemptDir, 'work');
  assertPathInside(input.runDir, input.attemptDir);
  ensureSecureDirectoryTree(input.runDir, outputDir);
  const resultPath = join(outputDir, 'result.json');
  const resultContent = `${JSON.stringify({
    schemaVersion: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    attemptId: input.attemptId,
    executor: input.executor,
    provider: input.provider,
    idempotencyKey: input.idempotencyKey,
    inputHash: input.inputHash,
    approvalDigest: input.approvalDigest,
    output: input.output,
    externalRefs: input.externalRefs,
  }, null, 2)}\n`;
  writeCreateOrVerify(resultPath, resultContent, 0o600, 'host result');
  const resultBytes = Buffer.from(resultContent, 'utf-8');
  const manifest: Manifest = {
    schemaVersion: 1,
    status: 'ok',
    summary: `host executor ${input.executor} completed`,
    files: [{
      name: 'result',
      path: 'result.json',
      kind: 'json',
      bytes: resultBytes.length,
      sha256: sha256(resultBytes),
      mime: 'application/json',
    }],
  };
  const manifestPath = join(input.attemptDir, 'manifest.json');
  writeCreateOrVerify(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600, 'host manifest');
  fsyncRegularFileSync(resultPath);
  fsyncDirectorySyncPortable(outputDir);
  fsyncRegularFileSync(manifestPath);
  fsyncDirectorySyncPortable(input.attemptDir);
  return { manifestPath, resultPath };
}

/**
 * Re-validate the schema/identity-bound host result wrapper after the generic manifest
 * validator has proved the file bytes.  A generic goal manifest with a
 * coincidentally valid `result.json` is not close proof for a host intent: the
 * wrapper must remain bound to the complete durable effect identity. This is
 * crash/cross-attempt integrity, not an attestation against a same-UID writer.
 */
export function readAndVerifyV3HostSuccessResult(input: {
  runDir: string;
  attemptDir: string;
  manifest: Manifest;
  runId: string;
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  provider: string;
  idempotencyKey: string;
  inputHash: string;
  approvalDigest: string;
}): V3HostSuccessResult {
  assertRegularFile(join(input.attemptDir, 'manifest.json'), 'host manifest');
  if (input.manifest.status !== 'ok') {
    throw new Error('v3 host success manifest status must be ok');
  }
  if (input.manifest.files.length !== 1) {
    throw new Error('v3 host success manifest must contain exactly one file');
  }
  const file = input.manifest.files[0]!;
  if (file.name !== 'result' || file.path !== 'result.json' || file.kind !== 'json') {
    throw new Error('v3 host success manifest must expose exactly result.json as JSON');
  }
  const resultPath = join(input.attemptDir, 'work', 'result.json');
  assertPathInside(input.runDir, resultPath);
  assertSecureExistingPath(input.runDir, resultPath, 'host result');
  assertRegularFile(resultPath, 'host result');
  const bytes = readFileSync(resultPath);
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new Error('v3 host success result bytes/hash mismatch');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf-8')) as unknown;
  } catch (err) {
    throw new Error(
      `v3 host success result is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(raw)) throw new Error('v3 host success result must be an object');
  const allowed = new Set([
    'schemaVersion', 'runId', 'nodeId', 'instanceId', 'attemptId', 'executor',
    'provider', 'idempotencyKey', 'inputHash', 'approvalDigest', 'output', 'externalRefs',
  ]);
  const extra = Object.keys(raw).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new Error(`v3 host success result has unsupported keys: ${extra.join(', ')}`);
  }
  if (raw.schemaVersion !== 1) throw new Error('v3 host success result schemaVersion mismatch');
  for (const key of [
    'runId', 'nodeId', 'instanceId', 'attemptId', 'executor', 'provider',
    'idempotencyKey', 'inputHash', 'approvalDigest',
  ] as const) {
    if (raw[key] !== input[key]) throw new Error(`v3 host success result ${key} mismatch`);
  }
  if (!isRecord(raw.externalRefs)) throw new Error('v3 host success result externalRefs must be an object');
  canonicalJson(raw.output);
  canonicalJson(raw.externalRefs);
  return raw as unknown as V3HostSuccessResult;
}

function parsePreparedHostInput(raw: unknown): V3PreparedHostInput {
  if (!isRecord(raw)) throw new Error('v3 host input sidecar must be an object');
  const allowed = new Set([
    'schemaVersion', 'runId', 'nodeId', 'instanceId', 'attemptId', 'executor',
    'provider', 'parsedInput', 'canonicalInput', 'inputHash', 'idempotencyKey',
    'idempotencyTtlMs', 'approvalDigest',
  ]);
  const extra = Object.keys(raw).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new Error(`v3 host input sidecar has unsupported keys: ${extra.join(', ')}`);
  if (raw.schemaVersion !== V3_HOST_INPUT_SCHEMA_VERSION) throw new Error('v3 host input sidecar schemaVersion mismatch');
  for (const key of ['runId', 'nodeId', 'instanceId', 'attemptId', 'executor', 'provider', 'idempotencyKey'] as const) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) throw new Error(`v3 host input ${key} must be non-empty`);
  }
  if (typeof raw.inputHash !== 'string' || !INPUT_HASH_RE.test(raw.inputHash)) {
    throw new Error('v3 host input inputHash is invalid');
  }
  if (typeof raw.approvalDigest !== 'string' || !INPUT_HASH_RE.test(raw.approvalDigest)) {
    throw new Error('v3 host input approvalDigest is invalid');
  }
  if (!Number.isSafeInteger(raw.idempotencyTtlMs) || (raw.idempotencyTtlMs as number) < 1) {
    throw new Error('v3 host input idempotencyTtlMs must be a positive safe integer');
  }
  canonicalJson(raw.parsedInput);
  canonicalJson(raw.canonicalInput);
  return raw as unknown as V3PreparedHostInput;
}

function writeCreateOrVerify(path: string, content: string, mode: number, label: string): void {
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // link(2) is an atomic no-overwrite publish: the canonical path either
      // does not exist, or names the fully fsync'd inode. A crash may leave an
      // unreferenced temp file, never a partial canonical host artifact.
      linkSync(tempPath, path);
      fsyncDirectorySyncPortable(dirname(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      assertRegularFile(path, label);
      if (readFileSync(path, 'utf-8') !== content) {
        throw new Error(`v3 ${label} conflict at ${path}; refusing to overwrite committed bytes`);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tempPath);
      fsyncDirectorySyncPortable(dirname(path));
    } catch {
      // The canonical link (if any) is already fsync'd. A cleanup failure may
      // leave an unreferenced temp inode, but must not turn a proven provider
      // result into output uncertainty.
    }
  }
  fsyncRegularFileSync(path);
  fsyncDirectorySyncPortable(dirname(path));
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`v3 ${label} must be a regular file: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`v3 ${label} must not be group/world accessible: ${path}`);
  }
}

function assertPathInside(parent: string, child: string): void {
  const root = resolve(parent);
  const rel = relative(root, resolve(child));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('v3 host path escapes runDir');
  }
}

function ensureSecureDirectoryTree(rootPath: string, targetPath: string): void {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('v3 host directory escapes runDir');
  }
  assertDirectory(root, 'run directory');
  let current = root;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    assertDirectory(current, 'host artifact directory');
  }
}

function assertSecureExistingPath(rootPath: string, filePath: string, label: string): void {
  const root = resolve(rootPath);
  const target = resolve(filePath);
  assertPathInside(root, target);
  assertDirectory(root, 'run directory');
  const rel = relative(root, dirname(target));
  let current = root;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    assertDirectory(current, `${label} parent`);
  }
}

function assertDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`v3 ${label} must be a real directory: ${path}`);
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateHostInputRefShape(ref: { path: string; sha256: string; bytes: number }): void {
  if (!ref.path || isAbsolute(ref.path) || ref.path.includes('\0')) throw new Error('invalid v3 host inputRef.path');
  if (!SHA256_RE.test(ref.sha256)) throw new Error('invalid v3 host inputRef.sha256');
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('invalid v3 host inputRef.bytes');
}
