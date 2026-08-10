/**
 * Host-neutral artifact contract shared by workflow schedulers and agents.
 *
 * Keep this module free of Botmux session, worker-fence, daemon, and provider
 * types so alternate hosts can implement the same manifest boundary.
 */

export type ManifestFileKind =
  | 'markdown'
  | 'json'
  | 'text'
  | 'code'
  | 'log'
  | 'binary'
  | 'directory';

export const MANIFEST_FILE_KINDS: readonly ManifestFileKind[] = [
  'markdown',
  'json',
  'text',
  'code',
  'log',
  'binary',
  'directory',
];

export const MANIFEST_SUMMARY_MAX_BYTES = 4 * 1024;
export const MANIFEST_PREVIEW_MAX_BYTES = 4 * 1024;

export interface ManifestFile {
  name: string;
  /** Relative to the node output directory. */
  path: string;
  kind: ManifestFileKind;
  bytes: number;
  sha256: string;
  mime: string;
  preview?: string;
}

export type ManifestStatus = 'ok' | 'fail';

export const MANIFEST_STATUSES: readonly ManifestStatus[] = ['ok', 'fail'];

export interface Manifest {
  schemaVersion: 1;
  status: ManifestStatus;
  summary: string;
  error?: { code: string; message: string; retryable?: boolean };
  files: ManifestFile[];
}

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export interface ManifestValidationResult {
  ok: boolean;
  manifest?: Manifest;
  problems?: string[];
}

export type ValidateManifest = (
  manifestPath: string,
  outputDir: string,
) => Promise<ManifestValidationResult>;
