/** Persisted contract for the one-time v2 workflow-run archive. */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';

export const V2_RUN_ARCHIVE_SCHEMA_VERSION = 1 as const;
export const V2_RUN_ARCHIVE_KIND = 'botmux-v2-workflow-run-archive' as const;
export const V2_RUN_ARCHIVE_COMMIT_SCHEMA_VERSION = 1 as const;
export const V2_RUN_RETIREMENT_SCHEMA_VERSION = 1 as const;
export const V2_RUN_RETIREMENT_KIND = 'botmux-v2-workflow-run-retirement' as const;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const RelativePathSchema = z.string().min(1).max(4096).refine(
  (value) =>
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  'must be a normalized relative POSIX path',
);

export const V2RunArchiveFileSchema = z.object({
  path: RelativePathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
}).strict();
export type V2RunArchiveFile = z.infer<typeof V2RunArchiveFileSchema>;

export const V2RunArchiveWarningSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2048),
}).strict();
export type V2RunArchiveWarning = z.infer<typeof V2RunArchiveWarningSchema>;

const TerminalStatusSchema = z.enum(['succeeded', 'failed', 'cancelled']);

export const V2RunArchiveVerdictSchema = z.object({
  status: TerminalStatusSchema,
  workflowId: z.string().min(1),
  revisionId: z.string().min(1).optional(),
  lastSeq: z.number().int().positive(),
  updatedAt: z.number().finite(),
  dangling: z.object({
    activities: z.number().int().nonnegative(),
    effectAttempted: z.number().int().nonnegative(),
    waits: z.number().int().nonnegative(),
    cancels: z.number().int().nonnegative(),
  }).strict(),
  liveTerminalSidecars: z.number().int().nonnegative(),
}).strict();
export type V2RunArchiveVerdict = z.infer<typeof V2RunArchiveVerdictSchema>;

export const V2RunArchiveRunSchema = z.object({
  runId: z.string().min(1).max(128),
  rawRoot: RelativePathSchema,
  projectionPath: RelativePathSchema,
  projectionSha256: Sha256Schema,
  presence: z.object({
    workflowJson: z.boolean(),
    chatBindingJson: z.boolean(),
    attemptsDir: z.boolean(),
    blobsDir: z.boolean(),
  }).strict(),
  missingOptional: z.array(z.enum(['chat-binding.json', 'attempts'])),
  warnings: z.array(V2RunArchiveWarningSchema),
  verdict: V2RunArchiveVerdictSchema,
}).strict();
export type V2RunArchiveRun = z.infer<typeof V2RunArchiveRunSchema>;

export const V2RunArchiveResidualSchema = z.object({
  name: z.string().min(1),
  sourceType: z.enum(['directory', 'file']),
  reason: z.enum(['directory-without-events', 'top-level-file']),
  rawRoot: RelativePathSchema,
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  treeSha256: Sha256Schema,
}).strict();
export type V2RunArchiveResidual = z.infer<typeof V2RunArchiveResidualSchema>;

export const V2RunArchiveContentSchema = z.object({
  runs: z.array(V2RunArchiveRunSchema),
  residuals: z.array(V2RunArchiveResidualSchema),
  payloadDirectories: z.array(RelativePathSchema),
  payloadFiles: z.array(V2RunArchiveFileSchema),
}).strict();
export type V2RunArchiveContent = z.infer<typeof V2RunArchiveContentSchema>;

export const V2RunArchiveManifestSchema = z.object({
  schemaVersion: z.literal(V2_RUN_ARCHIVE_SCHEMA_VERSION),
  kind: z.literal(V2_RUN_ARCHIVE_KIND),
  archiveId: Sha256Schema,
  createdAt: z.string().datetime(),
  sourceRunsDir: z.string().min(1),
  containsSensitiveData: z.literal(true),
  content: V2RunArchiveContentSchema,
}).strict();
export type V2RunArchiveManifest = z.infer<typeof V2RunArchiveManifestSchema>;

export const V2RunArchiveCommitMarkerSchema = z.object({
  schemaVersion: z.literal(V2_RUN_ARCHIVE_COMMIT_SCHEMA_VERSION),
  archiveId: Sha256Schema,
  manifestSha256: Sha256Schema,
}).strict();
export type V2RunArchiveCommitMarker = z.infer<typeof V2RunArchiveCommitMarkerSchema>;

export const V2RunRetirementReceiptSchema = z.object({
  schemaVersion: z.literal(V2_RUN_RETIREMENT_SCHEMA_VERSION),
  kind: z.literal(V2_RUN_RETIREMENT_KIND),
  archiveId: Sha256Schema,
  manifestSha256: Sha256Schema,
  sourceRunsDir: z.string().min(1),
  quarantineDir: z.string().min(1),
  retiredAt: z.string().datetime(),
}).strict();
export type V2RunRetirementReceipt = z.infer<typeof V2RunRetirementReceiptSchema>;

export function sha256Ref(data: string | Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export function v2RunArchiveId(content: V2RunArchiveContent): string {
  return sha256Ref(canonicalJsonStringify(content));
}

export function archiveDirectoryName(archiveId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(archiveId)) {
    throw new Error(`Invalid v2 run archive id: ${archiveId}`);
  }
  return archiveId.replace(':', '-');
}

export function parseV2RunArchiveManifest(value: unknown): V2RunArchiveManifest {
  return V2RunArchiveManifestSchema.parse(value);
}

export function parseV2RunArchiveCommitMarker(value: unknown): V2RunArchiveCommitMarker {
  return V2RunArchiveCommitMarkerSchema.parse(value);
}

export function parseV2RunRetirementReceipt(value: unknown): V2RunRetirementReceipt {
  return V2RunRetirementReceiptSchema.parse(value);
}
