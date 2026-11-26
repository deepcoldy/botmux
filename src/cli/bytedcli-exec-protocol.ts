/** Credential-free wire contract. All fields are untrusted until parsed here;
 * peer, actor, operation effect and executable are exclusively host derived. */
export const BYTEDCLI_EXEC_SCHEMA = 'botmux.bytedcli-exec.v1' as const;
export const BYTEDCLI_EXEC_ROUTE = '/api/bytedcli-exec' as const;
export const BYTEDCLI_EXEC_LIMITS = Object.freeze({
  argvEntries: 256, argvBytes: 64 * 1024, inputBytes: 2 * 1024 * 1024,
  httpBodyBytes: 3 * 1024 * 1024, outputBytes: 16 * 1024 * 1024,
  defaultTimeoutMs: 60_000, maxTimeoutMs: 120_000,
});

export interface BytedcliInputFile { readonly id: string; readonly dataBase64: string }
export interface BytedcliExecInputs {
  readonly stdinBase64?: string;
  readonly files?: readonly BytedcliInputFile[];
}
export interface BytedcliExecRequest {
  readonly schema: typeof BYTEDCLI_EXEC_SCHEMA;
  readonly sessionId: string;
  readonly requestId: string;
  readonly argv: readonly string[];
  readonly inputs?: BytedcliExecInputs;
}
export const BYTEDCLI_EXEC_ERROR_CODES = [
  'invalid_request', 'unsupported_operation', 'unsupported_cli_version', 'broker_disabled',
  'broker_containment_unavailable', 'execution_unverified', 'execution_stale', 'permission_denied',
  'actor_required', 'actor_auth_required', 'actor_identity_unverified', 'machine_auth_required',
  'region_auth_required', 'authorization_revoked', 'binding_changed', 'delegation_revoked',
  'policy_changed', 'busy', 'timeout', 'cancelled', 'input_limit', 'output_limit', 'audit_unavailable',
  'executor_unavailable', 'upstream_failed', 'write_outcome_unknown', 'internal_error',
] as const;
export type BytedcliExecErrorCode = typeof BYTEDCLI_EXEC_ERROR_CODES[number];
export type BytedcliExecOutcome = 'completed' | 'rejected' | 'failed' | 'write_outcome_unknown';
export interface BytedcliEffectiveIdentity {
  readonly kind: 'machine' | 'actor' | 'none';
  /** Opaque safe host-produced hash, never an email, grant or provider body. */
  readonly accountFingerprint?: string;
}
export interface BytedcliExecResponse {
  readonly schema: typeof BYTEDCLI_EXEC_SCHEMA;
  readonly requestId: string;
  readonly operationId: string;
  readonly effectiveIdentity: BytedcliEffectiveIdentity;
  readonly outcome: BytedcliExecOutcome;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly exitCode: number;
  readonly errorCode?: BytedcliExecErrorCode;
}
export class BytedcliExecProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'BytedcliExecProtocolError'; }
}
function fail(field: string): never { throw new BytedcliExecProtocolError(`Invalid broker ${field}`); }
function record(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(field);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) fail(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)
    || (pattern && !pattern.test(value))) fail(field);
  return value;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Canonical padded RFC4648 only: Buffer's permissive decoder is insufficient.
 * The length check precedes allocation. Returned bytes are owned by the caller. */
export function decodeBytedcliBase64(value: unknown, maxBytes: number, field = 'base64'): Buffer {
  const data = text(value, field);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || data.length > 4 * Math.ceil(maxBytes / 3)
    || data.length % 4 !== 0) fail(field);
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  if (data.length / 4 * 3 - padding > maxBytes) fail(field);
  // Repeated-group regexes exhaust JS engine matching limits on valid output
  // near 16 MiB. Scan once with constant stack space; '=' is trailing only.
  for (let index = 0; index < contentLength; index++) {
    const code = data.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) fail(field);
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length > maxBytes || decoded.toString('base64') !== data) fail(field);
  return decoded;
}
export function validateBytedcliArgv(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > BYTEDCLI_EXEC_LIMITS.argvEntries) fail('argv');
  const argv = value.map(arg => text(arg, 'argv'));
  if (argv.reduce((sum, arg) => sum + Buffer.byteLength(arg, 'utf8'), 0) > BYTEDCLI_EXEC_LIMITS.argvBytes) fail('argv size');
  return Object.freeze(argv);
}
export function parseBytedcliExecInputs(value: unknown): BytedcliExecInputs {
  const rec = record(value, ['stdinBase64', 'files'], 'inputs');
  let total = 0;
  const consume = (data: unknown) => {
    const buffer = decodeBytedcliBase64(data, BYTEDCLI_EXEC_LIMITS.inputBytes - total, 'inputs bytes');
    total += buffer.length;
    return data as string;
  };
  const stdinBase64 = rec.stdinBase64 === undefined ? undefined : consume(rec.stdinBase64);
  let files: readonly BytedcliInputFile[] | undefined;
  if (rec.files !== undefined) {
    if (!Array.isArray(rec.files) || rec.files.length > BYTEDCLI_EXEC_LIMITS.argvEntries) fail('input files');
    const ids = new Set<string>();
    files = Object.freeze(rec.files.map(raw => {
      const file = record(raw, ['id', 'dataBase64'], 'input file');
      const id = text(file.id, 'input id', INPUT_ID);
      if (ids.has(id) || id === 'stdin') fail('input id');
      ids.add(id);
      return Object.freeze({ id, dataBase64: consume(file.dataBase64) });
    }));
  }
  return Object.freeze({ ...(stdinBase64 !== undefined ? { stdinBase64 } : {}), ...(files !== undefined ? { files } : {}) });
}
function decodeJson(raw: unknown, maxBytes: number): unknown {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return raw;
  if (Buffer.byteLength(raw) > maxBytes) fail('body size');
  try { return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { return fail('JSON'); }
}
export function parseBytedcliExecRequest(raw: unknown): BytedcliExecRequest {
  const rec = record(decodeJson(raw, BYTEDCLI_EXEC_LIMITS.httpBodyBytes),
    ['schema', 'sessionId', 'requestId', 'argv', 'inputs'], 'request');
  if (rec.schema !== BYTEDCLI_EXEC_SCHEMA) fail('schema');
  return Object.freeze({ schema: BYTEDCLI_EXEC_SCHEMA,
    sessionId: text(rec.sessionId, 'sessionId', ID), requestId: text(rec.requestId, 'requestId', ID),
    argv: validateBytedcliArgv(rec.argv),
    ...(rec.inputs !== undefined ? { inputs: parseBytedcliExecInputs(rec.inputs) } : {}) });
}
export function parseBytedcliExecResponse(raw: unknown): BytedcliExecResponse {
  const rec = record(decodeJson(raw, 4 * Math.ceil(BYTEDCLI_EXEC_LIMITS.outputBytes / 3) + 4096),
    ['schema', 'requestId', 'operationId', 'effectiveIdentity', 'outcome', 'stdoutBase64', 'stderrBase64', 'exitCode', 'errorCode'], 'response');
  if (rec.schema !== BYTEDCLI_EXEC_SCHEMA) fail('schema');
  const identity = record(rec.effectiveIdentity, ['kind', 'accountFingerprint'], 'effectiveIdentity');
  if (!['machine', 'actor', 'none'].includes(identity.kind as string)) fail('identity kind');
  const effectiveIdentity: BytedcliEffectiveIdentity = Object.freeze({ kind: identity.kind as BytedcliEffectiveIdentity['kind'],
    ...(identity.accountFingerprint !== undefined
      ? { accountFingerprint: text(identity.accountFingerprint, 'account fingerprint', /^sha256:[A-Za-z0-9_-]{1,128}$/) } : {}) });
  if (!['completed', 'rejected', 'failed', 'write_outcome_unknown'].includes(rec.outcome as string)) fail('outcome');
  if (!Number.isInteger(rec.exitCode) || (rec.exitCode as number) < 0 || (rec.exitCode as number) > 255) fail('exitCode');
  if (rec.errorCode !== undefined && !(BYTEDCLI_EXEC_ERROR_CODES as readonly unknown[]).includes(rec.errorCode)) fail('errorCode');
  if (rec.outcome !== 'completed' && (rec.exitCode === 0 || rec.errorCode === undefined)) fail('failure result');
  if (rec.outcome === 'write_outcome_unknown'
    && (rec.errorCode !== 'write_outcome_unknown' || identity.kind !== 'actor')) fail('unknown write result');
  const stdout = decodeBytedcliBase64(rec.stdoutBase64, BYTEDCLI_EXEC_LIMITS.outputBytes, 'stdout');
  decodeBytedcliBase64(rec.stderrBase64, BYTEDCLI_EXEC_LIMITS.outputBytes - stdout.length, 'stderr');
  return Object.freeze({ schema: BYTEDCLI_EXEC_SCHEMA, requestId: text(rec.requestId, 'requestId', ID),
    operationId: text(rec.operationId, 'operationId', ID), effectiveIdentity,
    outcome: rec.outcome as BytedcliExecOutcome, stdoutBase64: rec.stdoutBase64 as string,
    stderrBase64: rec.stderrBase64 as string, exitCode: rec.exitCode as number,
    ...(rec.errorCode !== undefined ? { errorCode: rec.errorCode as BytedcliExecErrorCode } : {}) });
}
