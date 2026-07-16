/**
 * Immutable v3 run execution envelope.
 *
 * `run.json` is the durable authorization/identity boundary between the
 * pre-runtime product flows (grill Gate-2, saved-definition instantiation, or
 * the local developer CLI) and the v3 scheduler.  It deliberately contains no
 * mutable phase/status: once execution starts, `journal.ndjson` is the only
 * state truth and `STATE` remains a derived projection.
 *
 * Publication is create-once.  Every referenced artifact is pinned by the
 * SHA-256 of its exact bytes; readers verify and parse those same bytes so a
 * caller cannot approve one DAG and execute a different one after a re-read.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

import {
  fsyncDirectorySyncPortable,
  fsyncFilesAndDirectorySync,
} from '../../utils/fs-durability.js';
import { validateDag, type V3Dag } from './dag.js';
import { validateSpec } from './spec.js';
import type { Spec } from './contract.js';
import type { RunChatBinding } from './grill-state.js';

export const V3_RUN_ENVELOPE_FILE = 'run.json';
export const V3_RUN_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const V3_RUN_ENGINE = 'workflow-v3' as const;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type Sha256Digest = `sha256:${string}`;

export type V3RunArtifactPath =
  | 'dag.json'
  | 'spec.json'
  | 'bots.snapshot.json'
  | 'params.resolved.json'
  | 'definition.snapshot.json';

export interface V3ArtifactRef<Path extends V3RunArtifactPath = V3RunArtifactPath> {
  path: Path;
  sha256: Sha256Digest;
}

const sha256Schema = z.string()
  .regex(SHA256_RE, 'must be sha256:<64 lowercase hex>')
  .transform((value) => value as Sha256Digest);
const runIdSchema = z.string().regex(RUN_ID_RE, 'must be a path-safe v3 run id');
const timestampSchema = z.string().datetime({ offset: true });
const nonEmptyString = z.string().min(1);

const chatBindingSchema = z.object({
  larkAppId: nonEmptyString,
  chatId: nonEmptyString,
  chatType: z.enum(['group', 'p2p']).optional(),
  rootMessageId: nonEmptyString.optional(),
  sessionId: nonEmptyString.optional(),
  ownerOpenId: nonEmptyString.optional(),
}).strict();

function artifactRefSchema<Path extends V3RunArtifactPath>(path: Path) {
  return z.object({
    path: z.literal(path),
    sha256: sha256Schema,
  }).strict();
}

const baseShape = {
  schemaVersion: z.literal(V3_RUN_ENVELOPE_SCHEMA_VERSION),
  engine: z.literal(V3_RUN_ENGINE),
  runId: runIdSchema,
  createdAt: timestampSchema,
  chatBinding: chatBindingSchema.optional(),
};

const adHocEnvelopeSchema = z.object({
  ...baseShape,
  source: z.object({
    kind: z.literal('ad_hoc'),
    grillStatePath: z.literal('grill.state.json'),
  }).strict(),
  artifacts: z.object({
    dag: artifactRefSchema('dag.json'),
    spec: artifactRefSchema('spec.json'),
    botSnapshots: artifactRefSchema('bots.snapshot.json'),
  }).strict(),
  authorization: z.object({
    kind: z.literal('gate2'),
    authorizedAt: timestampSchema,
    authorizedByOpenId: nonEmptyString.optional(),
    dagSha256: sha256Schema,
    specSha256: sha256Schema,
  }).strict(),
}).strict();

const savedDefinitionEnvelopeSchema = z.object({
  ...baseShape,
  source: z.object({
    kind: z.literal('saved_definition'),
    workflowId: runIdSchema,
    revisionId: nonEmptyString,
    humanVersion: z.number().int().positive(),
  }).strict(),
  artifacts: z.object({
    dag: artifactRefSchema('dag.json'),
    spec: artifactRefSchema('spec.json'),
    botSnapshots: artifactRefSchema('bots.snapshot.json'),
    resolvedParams: artifactRefSchema('params.resolved.json'),
    definitionSnapshot: artifactRefSchema('definition.snapshot.json'),
  }).strict(),
  authorization: z.object({
    kind: z.literal('published_revision'),
    authorizedAt: timestampSchema,
    workflowId: runIdSchema,
    revisionId: nonEmptyString,
    definitionSnapshotSha256: sha256Schema,
    dagSha256: sha256Schema,
    specSha256: sha256Schema,
  }).strict(),
}).strict();

const manualCliEnvelopeSchema = z.object({
  ...baseShape,
  source: z.object({ kind: z.literal('manual_cli') }).strict(),
  artifacts: z.object({
    dag: artifactRefSchema('dag.json'),
    botSnapshots: artifactRefSchema('bots.snapshot.json'),
  }).strict(),
  authorization: z.object({
    kind: z.literal('local_cli'),
    authorizedAt: timestampSchema,
    dagSha256: sha256Schema,
  }).strict(),
}).strict();

const legacyV3EnvelopeSchema = z.object({
  ...baseShape,
  source: z.object({
    kind: z.literal('legacy_v3'),
    original: z.enum(['grill', 'manual_cli']),
  }).strict(),
  artifacts: z.object({
    dag: artifactRefSchema('dag.json'),
    spec: artifactRefSchema('spec.json').optional(),
    botSnapshots: artifactRefSchema('bots.snapshot.json').optional(),
  }).strict(),
  authorization: z.object({
    kind: z.literal('legacy_backfill'),
    backfilledAt: timestampSchema,
    basis: z.enum(['grill_dag_approved', 'runtime_started']),
    integrity: z.literal('unverifiable_before_backfill'),
    dagSha256: sha256Schema,
    specSha256: sha256Schema.optional(),
  }).strict(),
}).strict();

/** Strict v1 schema. Unknown keys are rejected at every envelope-owned level. */
export const V3RunEnvelopeSchema = z.union([
  adHocEnvelopeSchema,
  savedDefinitionEnvelopeSchema,
  manualCliEnvelopeSchema,
  legacyV3EnvelopeSchema,
]).superRefine((envelope, ctx) => {
  if (envelope.authorization.dagSha256 !== envelope.artifacts.dag.sha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authorization', 'dagSha256'],
      message: 'must match artifacts.dag.sha256',
    });
  }

  if (envelope.authorization.kind === 'gate2') {
    const artifacts = envelope.artifacts as z.infer<typeof adHocEnvelopeSchema>['artifacts'];
    if (envelope.authorization.specSha256 !== artifacts.spec.sha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'specSha256'],
        message: 'must match artifacts.spec.sha256',
      });
    }
  } else if (envelope.authorization.kind === 'published_revision') {
    const source = envelope.source as z.infer<typeof savedDefinitionEnvelopeSchema>['source'];
    const artifacts = envelope.artifacts as z.infer<typeof savedDefinitionEnvelopeSchema>['artifacts'];
    if (envelope.authorization.workflowId !== source.workflowId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'workflowId'],
        message: 'must match source.workflowId',
      });
    }
    if (envelope.authorization.revisionId !== source.revisionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'revisionId'],
        message: 'must match source.revisionId',
      });
    }
    if (envelope.authorization.definitionSnapshotSha256 !== artifacts.definitionSnapshot.sha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'definitionSnapshotSha256'],
        message: 'must match artifacts.definitionSnapshot.sha256',
      });
    }
    if (envelope.authorization.specSha256 !== artifacts.spec.sha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'specSha256'],
        message: 'must match artifacts.spec.sha256',
      });
    }
  } else if (envelope.authorization.kind === 'legacy_backfill') {
    const artifacts = envelope.artifacts as z.infer<typeof legacyV3EnvelopeSchema>['artifacts'];
    if (artifacts.spec) {
      if (envelope.authorization.specSha256 !== artifacts.spec.sha256) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['authorization', 'specSha256'],
          message: 'must match artifacts.spec.sha256 when a legacy spec is present',
        });
      }
    } else if (envelope.authorization.specSha256 !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'specSha256'],
        message: 'must be absent when artifacts.spec is absent',
      });
    }
  }
});

export type V3RunEnvelope = z.infer<typeof V3RunEnvelopeSchema>;
export type V3AdHocRunEnvelope = Extract<V3RunEnvelope, { source: { kind: 'ad_hoc' } }>;
export type V3SavedDefinitionRunEnvelope = Extract<V3RunEnvelope, { source: { kind: 'saved_definition' } }>;
export type V3ManualCliRunEnvelope = Extract<V3RunEnvelope, { source: { kind: 'manual_cli' } }>;
export type V3LegacyRunEnvelope = Extract<V3RunEnvelope, { source: { kind: 'legacy_v3' } }>;
export type V3RunSourceKind = V3RunEnvelope['source']['kind'];

export class RunEnvelopeValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid v3 run envelope:\n  - ${problems.join('\n  - ')}`);
    this.name = 'RunEnvelopeValidationError';
  }
}

export class RunEnvelopeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunEnvelopeConflictError';
  }
}

export class RunEnvelopeIntegrityError extends Error {
  constructor(
    public readonly code:
      | 'envelope_missing'
      | 'envelope_invalid'
      | 'source_not_allowed'
      | 'artifact_missing'
      | 'artifact_not_regular_file'
      | 'artifact_digest_mismatch'
      | 'artifact_invalid_json'
      | 'artifact_invalid_content'
      | 'run_id_mismatch',
    message: string,
    public readonly artifact?: V3RunArtifactPath,
  ) {
    super(message);
    this.name = 'RunEnvelopeIntegrityError';
  }
}

function zodProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${where}${issue.message}`;
  });
}

export function validateRunEnvelope(raw: unknown, expectedRunId?: string): V3RunEnvelope {
  const parsed = V3RunEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new RunEnvelopeValidationError(zodProblems(parsed.error));
  if (expectedRunId !== undefined && parsed.data.runId !== expectedRunId) {
    throw new RunEnvelopeValidationError([
      `runId must match run directory "${expectedRunId}" (got "${parsed.data.runId}")`,
    ]);
  }
  return parsed.data;
}

export type ReadRunEnvelopeResult =
  | { kind: 'missing'; path: string }
  | { kind: 'invalid'; path: string; problems: string[] }
  | { kind: 'ok'; path: string; envelope: V3RunEnvelope; bytes: Buffer };

/**
 * Defensive reader that preserves the crucial missing-vs-corrupt distinction.
 * Compatibility callers may fall back to grill state only for `missing`; an
 * existing invalid envelope must fail closed.
 *
 * Only an ENOENT from the initial lstat is `missing`. An existing path that
 * is a symlink, FIFO, directory, device, or otherwise non-regular file is
 * always `invalid` — even when a dangling symlink would make existsSync/stat
 * follow-and-miss. The type check runs on lstat BEFORE any open: a plain
 * open(2) on a writerless FIFO blocks forever, and this reader sits on
 * daemon-side integrity paths. The open then uses O_NOFOLLOW + O_NONBLOCK and
 * re-confirms via fstat dev+ino so a lstat→open TOCTOU swap can neither block
 * nor substitute another file. Once lstat has observed the path, every later
 * error — including ENOENT from a removal race — is `invalid`: the path
 * changed mid-read, and missing-only legacy fallbacks must not engage.
 */
export function readRunEnvelope(runDir: string, expectedRunId: string = basename(runDir)): ReadRunEnvelopeResult {
  const path = join(runDir, V3_RUN_ENVELOPE_FILE);
  // Boundary 1: the initial lstat is the only place a true "file was never
  // there" can be told apart from "path mutated while we were reading".
  // It also must run before any open — open(O_RDONLY) on a FIFO with no
  // writer blocks indefinitely regardless of O_NOFOLLOW.
  let linkStat;
  try {
    linkStat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing', path };
    return {
      kind: 'invalid',
      path,
      problems: [`cannot read run.json: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (!linkStat.isFile()) {
    return {
      kind: 'invalid',
      path,
      problems: ['run.json must be a regular file'],
    };
  }
  // Boundary 2: lstat saw a regular file, so from here every failure —
  // ENOENT included — means the path changed underneath us and must fail
  // closed as invalid, never as missing.
  let fd: number | undefined;
  let bytes: Buffer;
  try {
    // O_NONBLOCK makes an open on a race-swapped FIFO return immediately
    // instead of blocking (it is a no-op for regular files); O_NOFOLLOW
    // rejects a swap to a symlink.
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const st = fstatSync(fd);
    // Re-confirm on the open fd and pin the inode identity: anything that is
    // not the exact regular file lstat approved fails closed.
    if (!st.isFile() || st.dev !== linkStat.dev || st.ino !== linkStat.ino) {
      return {
        kind: 'invalid',
        path,
        problems: ['run.json must be a regular file'],
      };
    }
    bytes = readFileSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP (Linux O_NOFOLLOW on symlink), EPERM (some NOFOLLOW platforms),
    // EISDIR, and a raced ENOENT all mean "the observed path stopped being a
    // stable regular file".
    if (code === 'ELOOP' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR' || code === 'ENOENT') {
      return {
        kind: 'invalid',
        path,
        problems: [`run.json must be a stable regular file (${code})`],
      };
    }
    return {
      kind: 'invalid',
      path,
      problems: [`cannot read run.json: ${err instanceof Error ? err.message : String(err)}`],
    };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf-8'));
  } catch (err) {
    return {
      kind: 'invalid',
      path,
      problems: [`cannot read/parse run.json: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  try {
    return { kind: 'ok', path, envelope: validateRunEnvelope(raw, expectedRunId), bytes };
  } catch (err) {
    return {
      kind: 'invalid',
      path,
      problems: err instanceof RunEnvelopeValidationError ? err.problems : [String(err)],
    };
  }
}

/** SHA-256 of exact bytes (no JSON parse/re-serialization). */
export function sha256Bytes(bytes: string | Buffer): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactPath(runDir: string, path: V3RunArtifactPath): string {
  return join(runDir, path);
}

function readRegularArtifact(runDir: string, path: V3RunArtifactPath): Buffer {
  const absolutePath = artifactPath(runDir, path);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (err) {
    throw new RunEnvelopeIntegrityError(
      'artifact_missing',
      `v3 run artifact ${path} is missing: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }
  // Reject symlinks as well as directories/devices. A fixed basename plus a
  // symlink to outside runDir would otherwise bypass the path allowlist.
  if (!stat.isFile()) {
    throw new RunEnvelopeIntegrityError(
      'artifact_not_regular_file',
      `v3 run artifact ${path} must be a regular file`,
      path,
    );
  }
  // Same TOCTOU discipline as readRunEnvelope: O_NONBLOCK so a race-swapped
  // FIFO cannot block the open, O_NOFOLLOW against symlink swaps, then fstat
  // dev+ino must match the inode lstat approved.
  let fd: number | undefined;
  try {
    fd = openSync(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== stat.dev || st.ino !== stat.ino) {
      throw new RunEnvelopeIntegrityError(
        'artifact_not_regular_file',
        `v3 run artifact ${path} must be a regular file`,
        path,
      );
    }
    return readFileSync(fd);
  } catch (err) {
    if (err instanceof RunEnvelopeIntegrityError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new RunEnvelopeIntegrityError(
        'artifact_missing',
        `v3 run artifact ${path} is missing: ${err instanceof Error ? err.message : String(err)}`,
        path,
      );
    }
    throw new RunEnvelopeIntegrityError(
      'artifact_not_regular_file',
      `v3 run artifact ${path} must be a regular file (${code ?? String(err)})`,
      path,
    );
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Build an exact-byte artifact ref for an already-materialized run file. */
export function artifactRef<Path extends V3RunArtifactPath>(runDir: string, path: Path): V3ArtifactRef<Path> {
  return { path, sha256: sha256Bytes(readRegularArtifact(runDir, path)) };
}

function parseJsonArtifact(bytes: Buffer, path: V3RunArtifactPath): unknown {
  try {
    return JSON.parse(bytes.toString('utf-8'));
  } catch (err) {
    throw new RunEnvelopeIntegrityError(
      'artifact_invalid_json',
      `v3 run artifact ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }
}

function verifyArtifact(runDir: string, ref: V3ArtifactRef): Buffer {
  const bytes = readRegularArtifact(runDir, ref.path);
  const actual = sha256Bytes(bytes);
  if (actual !== ref.sha256) {
    throw new RunEnvelopeIntegrityError(
      'artifact_digest_mismatch',
      `v3 run artifact ${ref.path} digest mismatch: expected ${ref.sha256}, got ${actual}`,
      ref.path,
    );
  }
  return bytes;
}

export interface LoadedAuthorizedV3Run {
  envelope: V3RunEnvelope;
  /** Validated from the exact bytes whose digest was checked. */
  dag: V3Dag;
  spec?: Spec;
  /** Shape validation belongs to the bot-snapshot materializer; kept as exact JSON here. */
  botSnapshots?: unknown;
  resolvedParams?: unknown;
  definitionSnapshot?: unknown;
  /** Exact verified bytes, for a caller that must avoid a second filesystem read. */
  bytes: {
    runEnvelope: Buffer;
    dag: Buffer;
    spec?: Buffer;
    botSnapshots?: Buffer;
    resolvedParams?: Buffer;
    definitionSnapshot?: Buffer;
  };
}

export interface LoadAuthorizedV3RunOptions {
  expectedRunId?: string;
  allowedSources?: readonly V3RunSourceKind[];
}

/** Strictly read, authorize, hash-check, and parse a materialized v3 run. */
export function loadAuthorizedV3Run(
  runDir: string,
  options: LoadAuthorizedV3RunOptions = {},
): LoadedAuthorizedV3Run {
  const expectedRunId = options.expectedRunId ?? basename(runDir);
  const read = readRunEnvelope(runDir, expectedRunId);
  if (read.kind === 'missing') {
    throw new RunEnvelopeIntegrityError('envelope_missing', `v3 run envelope is missing at ${read.path}`);
  }
  if (read.kind === 'invalid') {
    throw new RunEnvelopeIntegrityError(
      'envelope_invalid',
      `v3 run envelope is invalid: ${read.problems.join('; ')}`,
    );
  }
  const envelope = read.envelope;
  if (options.allowedSources && !options.allowedSources.includes(envelope.source.kind)) {
    throw new RunEnvelopeIntegrityError(
      'source_not_allowed',
      `v3 run source "${envelope.source.kind}" is not allowed here`,
    );
  }

  const dagBytes = verifyArtifact(runDir, envelope.artifacts.dag);
  let dag: V3Dag;
  try {
    dag = validateDag(parseJsonArtifact(dagBytes, 'dag.json'));
  } catch (err) {
    if (err instanceof RunEnvelopeIntegrityError) throw err;
    throw new RunEnvelopeIntegrityError(
      'artifact_invalid_content',
      `v3 run artifact dag.json failed validation: ${err instanceof Error ? err.message : String(err)}`,
      'dag.json',
    );
  }
  if (dag.runId !== envelope.runId) {
    throw new RunEnvelopeIntegrityError(
      'run_id_mismatch',
      `dag.runId "${dag.runId}" does not match envelope.runId "${envelope.runId}"`,
      'dag.json',
    );
  }

  const bytes: LoadedAuthorizedV3Run['bytes'] = {
    runEnvelope: read.bytes,
    dag: dagBytes,
  };
  let spec: Spec | undefined;
  let botSnapshots: unknown;
  let resolvedParams: unknown;
  let definitionSnapshot: unknown;

  if ('spec' in envelope.artifacts && envelope.artifacts.spec) {
    const specBytes = verifyArtifact(runDir, envelope.artifacts.spec);
    bytes.spec = specBytes;
    try {
      spec = validateSpec(parseJsonArtifact(specBytes, 'spec.json'));
    } catch (err) {
      if (err instanceof RunEnvelopeIntegrityError) throw err;
      throw new RunEnvelopeIntegrityError(
        'artifact_invalid_content',
        `v3 run artifact spec.json failed validation: ${err instanceof Error ? err.message : String(err)}`,
        'spec.json',
      );
    }
    if (spec.runId !== envelope.runId) {
      throw new RunEnvelopeIntegrityError(
        'run_id_mismatch',
        `spec.runId "${spec.runId}" does not match envelope.runId "${envelope.runId}"`,
        'spec.json',
      );
    }
  }

  if ('botSnapshots' in envelope.artifacts && envelope.artifacts.botSnapshots) {
    const botBytes = verifyArtifact(runDir, envelope.artifacts.botSnapshots);
    bytes.botSnapshots = botBytes;
    botSnapshots = parseJsonArtifact(botBytes, 'bots.snapshot.json');
  }
  if ('resolvedParams' in envelope.artifacts) {
    const paramBytes = verifyArtifact(runDir, envelope.artifacts.resolvedParams);
    bytes.resolvedParams = paramBytes;
    resolvedParams = parseJsonArtifact(paramBytes, 'params.resolved.json');
  }
  if ('definitionSnapshot' in envelope.artifacts) {
    const definitionBytes = verifyArtifact(runDir, envelope.artifacts.definitionSnapshot);
    bytes.definitionSnapshot = definitionBytes;
    definitionSnapshot = parseJsonArtifact(definitionBytes, 'definition.snapshot.json');
  }

  if (envelope.source.kind === 'saved_definition') {
    if (!definitionSnapshot || typeof definitionSnapshot !== 'object' || Array.isArray(definitionSnapshot)) {
      throw new RunEnvelopeIntegrityError(
        'artifact_invalid_content',
        'definition.snapshot.json must be an object for a saved-definition run',
        'definition.snapshot.json',
      );
    }
    const snapshot = definitionSnapshot as Record<string, unknown>;
    if (
      snapshot.workflowId !== envelope.source.workflowId ||
      snapshot.revisionId !== envelope.source.revisionId ||
      snapshot.humanVersion !== envelope.source.humanVersion
    ) {
      throw new RunEnvelopeIntegrityError(
        'artifact_invalid_content',
        'definition.snapshot.json identity does not match run.json source revision',
        'definition.snapshot.json',
      );
    }
  }

  return { envelope, dag, spec, botSnapshots, resolvedParams, definitionSnapshot, bytes };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).filter((k) => source[k] !== undefined).sort()) {
    out[key] = canonicalize(source[key]);
  }
  return out;
}

export function serializeRunEnvelope(envelope: V3RunEnvelope): string {
  return `${JSON.stringify(canonicalize(envelope))}\n`;
}

export interface PublishRunEnvelopeResult {
  created: boolean;
  path: string;
  envelope: V3RunEnvelope;
}

function fsyncEnvelopeArtifacts(runDir: string, envelope: V3RunEnvelope): void {
  const refs = Object.values(envelope.artifacts) as Array<V3ArtifactRef | undefined>;
  fsyncFilesAndDirectorySync(
    runDir,
    refs.filter((ref): ref is V3ArtifactRef => ref !== undefined)
      .map((ref) => join(runDir, ref.path)),
  );
}

/**
 * Atomically publish run.json without ever replacing an existing envelope.
 * A hard-link publishes a fully-written same-filesystem temp inode with
 * create-only semantics; an exact semantic repeat is accepted idempotently.
 *
 * run.json is also the commit marker for every digest-pinned artifact. Before
 * exposing it we fsync each referenced regular file and the run directory, so
 * a crash cannot retain the authorization while losing its DAG/spec/snapshot.
 */
export function publishRunEnvelopeOnce(runDir: string, raw: V3RunEnvelope): PublishRunEnvelopeResult {
  const expectedRunId = basename(runDir);
  const envelope = validateRunEnvelope(raw, expectedRunId);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, V3_RUN_ENVELOPE_FILE);

  const existingBefore = readRunEnvelope(runDir, expectedRunId);
  if (existingBefore.kind === 'ok') {
    if (serializeRunEnvelope(existingBefore.envelope) === serializeRunEnvelope(envelope)) {
      // Besides validating an idempotent retry, this heals a process that
      // crashed after link(2) but before syncing the directory entry, and
      // upgrades envelopes published before artifact fsync was introduced.
      fsyncEnvelopeArtifacts(runDir, existingBefore.envelope);
      return { created: false, path, envelope: existingBefore.envelope };
    }
    throw new RunEnvelopeConflictError(`run.json already exists with different content at ${path}`);
  }
  if (existingBefore.kind === 'invalid') {
    throw new RunEnvelopeConflictError(
      `run.json already exists but is invalid at ${path}: ${existingBefore.problems.join('; ')}`,
    );
  }

  // The authorization marker must never become durable before the exact bytes
  // it authorizes. atomicWrite's rename gives atomic visibility, while these
  // fsyncs provide the separate crash-durability guarantee.
  fsyncEnvelopeArtifacts(runDir, envelope);

  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, serializeRunEnvelope(envelope), 'utf-8');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const raced = readRunEnvelope(runDir, expectedRunId);
      if (raced.kind === 'ok' && serializeRunEnvelope(raced.envelope) === serializeRunEnvelope(envelope)) {
        fsyncDirectorySyncPortable(runDir);
        return { created: false, path, envelope: raced.envelope };
      }
      const detail = raced.kind === 'invalid' ? `: ${raced.problems.join('; ')}` : '';
      throw new RunEnvelopeConflictError(`run.json was concurrently published with different content at ${path}${detail}`);
    }
    // Persist the newly-created directory entry as well as the file inode.
    // Without this, a crash can lose run.json after Gate-2 has advanced even
    // though the file itself was fsync'd.
    fsyncDirectorySyncPortable(runDir);
    return { created: true, path, envelope };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* temp may already be absent */ }
  }
}

interface CommonBuilderInput {
  runId: string;
  createdAt: string;
  chatBinding?: RunChatBinding;
}

export function makeAdHocRunEnvelope(input: CommonBuilderInput & {
  authorizedAt: string;
  authorizedByOpenId?: string;
  artifacts: V3AdHocRunEnvelope['artifacts'];
}): V3AdHocRunEnvelope {
  return validateRunEnvelope({
    schemaVersion: V3_RUN_ENVELOPE_SCHEMA_VERSION,
    engine: V3_RUN_ENGINE,
    runId: input.runId,
    createdAt: input.createdAt,
    ...(input.chatBinding ? { chatBinding: input.chatBinding } : {}),
    source: { kind: 'ad_hoc', grillStatePath: 'grill.state.json' },
    artifacts: input.artifacts,
    authorization: {
      kind: 'gate2',
      authorizedAt: input.authorizedAt,
      ...(input.authorizedByOpenId ? { authorizedByOpenId: input.authorizedByOpenId } : {}),
      dagSha256: input.artifacts.dag.sha256,
      specSha256: input.artifacts.spec.sha256,
    },
  }) as V3AdHocRunEnvelope;
}

export function makeSavedDefinitionRunEnvelope(input: CommonBuilderInput & {
  workflowId: string;
  revisionId: string;
  humanVersion: number;
  authorizedAt: string;
  artifacts: V3SavedDefinitionRunEnvelope['artifacts'];
}): V3SavedDefinitionRunEnvelope {
  return validateRunEnvelope({
    schemaVersion: V3_RUN_ENVELOPE_SCHEMA_VERSION,
    engine: V3_RUN_ENGINE,
    runId: input.runId,
    createdAt: input.createdAt,
    ...(input.chatBinding ? { chatBinding: input.chatBinding } : {}),
    source: {
      kind: 'saved_definition',
      workflowId: input.workflowId,
      revisionId: input.revisionId,
      humanVersion: input.humanVersion,
    },
    artifacts: input.artifacts,
    authorization: {
      kind: 'published_revision',
      authorizedAt: input.authorizedAt,
      workflowId: input.workflowId,
      revisionId: input.revisionId,
      definitionSnapshotSha256: input.artifacts.definitionSnapshot.sha256,
      dagSha256: input.artifacts.dag.sha256,
      specSha256: input.artifacts.spec.sha256,
    },
  }) as V3SavedDefinitionRunEnvelope;
}

export function makeManualCliRunEnvelope(input: CommonBuilderInput & {
  authorizedAt: string;
  artifacts: V3ManualCliRunEnvelope['artifacts'];
}): V3ManualCliRunEnvelope {
  return validateRunEnvelope({
    schemaVersion: V3_RUN_ENVELOPE_SCHEMA_VERSION,
    engine: V3_RUN_ENGINE,
    runId: input.runId,
    createdAt: input.createdAt,
    ...(input.chatBinding ? { chatBinding: input.chatBinding } : {}),
    source: { kind: 'manual_cli' },
    artifacts: input.artifacts,
    authorization: {
      kind: 'local_cli',
      authorizedAt: input.authorizedAt,
      dagSha256: input.artifacts.dag.sha256,
    },
  }) as V3ManualCliRunEnvelope;
}

export function makeLegacyV3RunEnvelope(input: CommonBuilderInput & {
  original: 'grill' | 'manual_cli';
  basis: 'grill_dag_approved' | 'runtime_started';
  backfilledAt: string;
  artifacts: V3LegacyRunEnvelope['artifacts'];
}): V3LegacyRunEnvelope {
  return validateRunEnvelope({
    schemaVersion: V3_RUN_ENVELOPE_SCHEMA_VERSION,
    engine: V3_RUN_ENGINE,
    runId: input.runId,
    createdAt: input.createdAt,
    ...(input.chatBinding ? { chatBinding: input.chatBinding } : {}),
    source: { kind: 'legacy_v3', original: input.original },
    artifacts: input.artifacts,
    authorization: {
      kind: 'legacy_backfill',
      backfilledAt: input.backfilledAt,
      basis: input.basis,
      integrity: 'unverifiable_before_backfill',
      dagSha256: input.artifacts.dag.sha256,
      ...(input.artifacts.spec ? { specSha256: input.artifacts.spec.sha256 } : {}),
    },
  }) as V3LegacyRunEnvelope;
}
