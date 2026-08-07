/** User-configurable update policy for a compatible CLI runtime. */
export type CliRuntimeUpdateConfig =
  | { provider: 'auto' }
  | { provider: 'self' }
  | { provider: 'none' }
  | { provider: 'npm'; packageName: string };

/**
 * A concrete distribution that implements the behavioral contract selected by
 * `cliId`. For example, VendorCodex can use the `codex` adapter without becoming
 * a new adapter id of its own.
 */
export interface CliRuntimeConfig {
  id: string;
  displayName?: string;
  executable: string;
  update?: CliRuntimeUpdateConfig;
}

export type CliRuntimeSource = 'official' | 'legacy-path' | 'configured';

/** `internal` is reserved for botmux's built-in official Codex update source. */
export type ResolvedCliRuntimeUpdateConfig =
  | CliRuntimeUpdateConfig
  | { provider: 'internal' };

/** Fully resolved, serializable runtime state suitable for freezing on a session. */
export interface CliRuntimeSnapshot {
  id: string;
  displayName: string;
  executable: string;
  source: CliRuntimeSource;
  update: ResolvedCliRuntimeUpdateConfig;
}

export interface ResolveCliRuntimeInput {
  cliId: string;
  cliRuntime?: unknown;
  cliPathOverride?: string;
  /** Error-path prefix used when validating a structured runtime. */
  context?: string;
}

export interface CliRuntimeIdentityInput {
  cliId?: string | null;
  cliRuntime?: Pick<CliRuntimeConfig, 'id'> | Pick<CliRuntimeSnapshot, 'id' | 'source'> | null;
  /** Legacy sessions may only have the frozen path and need an identity backfill. */
  cliPathOverride?: string | null;
  wrapperCli?: string | null;
}

export interface CliRuntimeInstallationInput {
  cliId?: string | null;
  cliRuntime?: Pick<CliRuntimeConfig, 'id' | 'executable'>
    | Pick<CliRuntimeSnapshot, 'id' | 'executable' | 'source'>
    | null;
  cliPathOverride?: string | null;
}

const RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SINGLE_LINE_RE = /[\r\n\u2028\u2029]/;
const DISPLAY_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONFIG_KEYS = new Set(['id', 'displayName', 'executable', 'update']);
const UPDATE_KEYS = new Set(['provider', 'packageName']);

/** Shared allow-list for npm registry lookup and copyable install commands. */
export function isValidNpmPackageName(value: string): boolean {
  return value.length <= 214 && NPM_PACKAGE_RE.test(value);
}

/** Browser-safe basename extraction that also recognizes Windows paths. */
export function executableBasename(executable: string): string {
  const withoutTrailingSeparators = executable.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(
    withoutTrailingSeparators.lastIndexOf('/'),
    withoutTrailingSeparators.lastIndexOf('\\'),
  );
  return withoutTrailingSeparators.slice(lastSeparator + 1) || executable;
}

function isAbsoluteExecutablePath(executable: string): boolean {
  // Keep this browser-safe: runtime validation is shared by the dashboard
  // bundle, so importing node:path's platform-specific implementation here
  // would either break the bundle or classify Windows paths by the host OS.
  return executable.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(executable)
    || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(executable);
}

function isBareExecutableName(executable: string): boolean {
  return !/[\\/\s]/.test(executable);
}

function isReservedOfficialCodexExecutable(executable: string): boolean {
  const name = executableBasename(executable).toLowerCase();
  return name === 'codex' || name === 'codex.exe';
}

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(raw: unknown, context: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(context, 'must be an object');
  }
  return raw as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(context, `unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
}

function normalizeExecutableLiteral(raw: unknown, context: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    fail(context, 'must be a non-empty string');
  }
  if (raw.includes('\0') || SINGLE_LINE_RE.test(raw)) {
    fail(context, 'must not contain NUL or newline characters');
  }
  return raw;
}

function normalizeStructuredExecutable(raw: unknown, context: string): string {
  const executable = normalizeExecutableLiteral(raw, context);
  if (!isBareExecutableName(executable) && !isAbsoluteExecutablePath(executable)) {
    fail(context, 'must be a bare command name or an absolute POSIX/Windows path');
  }
  // Deliberately preserve the string byte-for-byte. It is one executable path,
  // not a command line, so an embedded space must never be tokenized as argv.
  return executable;
}

function normalizeUpdate(raw: unknown, context: string): CliRuntimeUpdateConfig | undefined {
  if (raw === undefined) return undefined;
  const value = asRecord(raw, context);
  rejectUnknownKeys(value, UPDATE_KEYS, context);

  const provider = value.provider;
  if (provider !== 'auto' && provider !== 'self' && provider !== 'none' && provider !== 'npm') {
    fail(context, 'provider must be one of auto, self, none, npm');
  }

  if (provider !== 'npm') {
    if (value.packageName !== undefined) fail(context, 'packageName is only valid for provider npm');
    return { provider };
  }

  if (typeof value.packageName !== 'string' || value.packageName.trim().length === 0) {
    fail(context, 'packageName is required for provider npm');
  }
  const packageName = value.packageName.trim();
  if (!isValidNpmPackageName(packageName)) {
    fail(context, 'packageName must be a valid lowercase npm package name');
  }
  return { provider: 'npm', packageName };
}

/** Strictly validate the user-facing `cliRuntime` object. */
export function normalizeCliRuntimeConfig(raw: unknown, context: string): CliRuntimeConfig {
  const value = asRecord(raw, context);
  rejectUnknownKeys(value, CONFIG_KEYS, context);

  if (typeof value.id !== 'string' || !RUNTIME_ID_RE.test(value.id)) {
    fail(context, 'id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  }
  if (value.id.toLowerCase() === 'codex') {
    fail(context, 'id "codex" is reserved for the built-in official Codex runtime');
  }

  let displayName: string | undefined;
  if (value.displayName !== undefined) {
    if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
      fail(context, 'displayName must be a non-empty string when provided');
    }
    if (DISPLAY_CONTROL_RE.test(value.displayName)) {
      fail(context, 'displayName must be a single line without control characters');
    }
    const normalizedDisplayName = value.displayName.trim();
    if (Array.from(normalizedDisplayName).length > 64) {
      fail(context, 'displayName must be at most 64 characters');
    }
    displayName = normalizedDisplayName;
  }

  const executable = normalizeStructuredExecutable(value.executable, `${context}.executable`);
  if (isReservedOfficialCodexExecutable(executable)) {
    fail(`${context}.executable`, 'basename "codex" is reserved for the built-in official Codex runtime; use a distinct custom alias');
  }
  const update = normalizeUpdate(value.update, `${context}.update`);
  return {
    id: value.id,
    ...(displayName !== undefined ? { displayName } : {}),
    executable,
    ...(update !== undefined ? { update } : {}),
  };
}

/**
 * Resolve the effective runtime for a bot/session.
 *
 * - Plain Codex gets the built-in official runtime.
 * - A legacy `cliPathOverride` becomes a stable basename-based snapshot.
 * - Structured runtimes are currently supported only by the Codex adapter.
 * - Other plain adapters need no runtime snapshot yet.
 */
export function resolveCliRuntime(input: ResolveCliRuntimeInput): CliRuntimeSnapshot | undefined {
  const hasStructured = input.cliRuntime !== undefined;
  const hasLegacyPath = input.cliPathOverride !== undefined;

  if (hasStructured) {
    if (input.cliId !== 'codex') {
      fail(input.context ?? 'cliRuntime', 'structured runtimes are currently supported only for cliId "codex"');
    }
    const configured = normalizeCliRuntimeConfig(input.cliRuntime, input.context ?? 'cliRuntime');
    // New writers shadow the canonical executable into cliPathOverride so a
    // rollback to a pre-cliRuntime BotMux still launches the same distribution.
    // Accept only byte-for-byte equality: two independent executable sources
    // would make old and new versions disagree and must fail closed.
    if (hasLegacyPath && input.cliPathOverride !== configured.executable) {
      fail(input.context ?? 'cliRuntime', 'cliPathOverride must exactly match cliRuntime.executable when both are present');
    }
    return {
      id: configured.id,
      displayName: configured.displayName ?? configured.id,
      executable: configured.executable,
      source: 'configured',
      update: configured.update ?? { provider: 'auto' },
    };
  }

  if (hasLegacyPath) {
    // cliPathOverride predates structured runtimes and historically accepted
    // relative launchers. Preserve that downgrade/upgrade compatibility; the
    // stricter bare-or-absolute shape is a contract of cliRuntime.executable.
    const executable = normalizeExecutableLiteral(input.cliPathOverride, 'cliPathOverride');
    const name = executableBasename(executable);
    return {
      id: name,
      displayName: name,
      executable,
      source: 'legacy-path',
      update: { provider: 'auto' },
    };
  }

  if (input.cliId === 'codex') {
    return {
      id: 'codex',
      displayName: 'Codex',
      executable: 'codex',
      source: 'official',
      update: { provider: 'internal' },
    };
  }

  return undefined;
}

/** Return the adapter path override implied by a resolved runtime. */
export function runtimePathOverride(runtime: CliRuntimeSnapshot | null | undefined): string | undefined {
  if (!runtime || runtime.source === 'official') return undefined;
  return runtime.executable;
}

/** Make a detached serializable copy before persisting runtime state on a session. */
export function snapshotCliRuntime(
  runtime: CliRuntimeSnapshot | null | undefined,
): CliRuntimeSnapshot | undefined {
  if (!runtime) return undefined;
  return {
    id: runtime.id,
    displayName: runtime.displayName,
    executable: runtime.executable,
    source: runtime.source,
    update: { ...runtime.update },
  };
}

function identityRuntimeId(input: CliRuntimeIdentityInput): string {
  if (input.cliRuntime && typeof input.cliRuntime.id === 'string') return input.cliRuntime.id;
  if (typeof input.cliPathOverride === 'string' && input.cliPathOverride.trim()) {
    return executableBasename(input.cliPathOverride);
  }
  return input.cliId === 'codex' ? 'codex' : '';
}

function identityRuntimeSource(input: CliRuntimeIdentityInput): CliRuntimeSource | '' {
  if (input.cliRuntime) {
    if ('source' in input.cliRuntime) return input.cliRuntime.source;
    // Configured runtimes do not carry `source`; `codex` is reserved and can
    // therefore only represent a legacy minimal official descriptor here.
    return input.cliId === 'codex' && input.cliRuntime.id === 'codex'
      ? 'official'
      : 'configured';
  }
  if (typeof input.cliPathOverride === 'string' && input.cliPathOverride.trim()) return 'legacy-path';
  return input.cliId === 'codex' ? 'official' : '';
}

/** Stable identity key: adapter id + runtime source/id + wrapper. */
export function runtimeIdentityKey(input: CliRuntimeIdentityInput): string {
  return JSON.stringify([
    input.cliId ?? '',
    identityRuntimeSource(input),
    identityRuntimeId(input),
    input.wrapperCli?.trim() ?? '',
  ]);
}

export function sameRuntimeIdentity(
  left: CliRuntimeIdentityInput,
  right: CliRuntimeIdentityInput,
): boolean {
  return runtimeIdentityKey(left) === runtimeIdentityKey(right);
}

/** Version/probe cache key for one concrete installation. Session identity is
 * intentionally id-based, but two hosts/paths using the same distribution id
 * may run different versions and must not overwrite each other's cache entry. */
export function runtimeInstallationKey(input: CliRuntimeInstallationInput): string {
  const source = identityRuntimeSource(input);
  const runtimeId = input.cliRuntime?.id
    ?? (input.cliPathOverride ? executableBasename(input.cliPathOverride) : input.cliId === 'codex' ? 'codex' : '');
  const executable = input.cliRuntime?.executable
    ?? input.cliPathOverride
    ?? (input.cliId === 'codex' ? 'codex' : '');
  return JSON.stringify([input.cliId ?? '', source, runtimeId, executable]);
}
