import { createHash } from 'node:crypto';
import { constants, existsSync, mkdtempSync, openSync, writeFileSync, closeSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { bytedcliHomeFor, bytedcliLoginFingerprint, parseEnvelope, serializedCredentialWork } from '../services/bytedcli-auth.js';
import { cliAuthEpochAllows, readCliAuthEpoch } from '../services/cli-auth-epoch.js';
import { jwtClaims } from '../utils/bytecloud-jwt-claims.js';
import { ensureBytedcliPrivateDirectory } from './bytedcli-broker-audit.js';
import { BytedcliBrokerError, bytedcliMinimalEnv, runBoundedBytedcliChild,
  type BytedcliChildRunner, type BytedcliTrustedCli } from './bytedcli-broker-process.js';
import type { BytedcliExecErrorCode } from '../cli/bytedcli-exec-protocol.js';

export type BytedcliAuthorityRecheck = () => Promise<BytedcliExecErrorCode | undefined>;
export interface BytedcliVerifiedActor {
  readonly verifiedEmail: string; readonly credentialOpenId: string;
  readonly source: 'local' | 'platform' | 'auto'; readonly unionId?: string;
}
export interface BytedcliLeaseRequest {
  readonly region: 'cn'; readonly actor?: BytedcliVerifiedActor; readonly recheck: BytedcliAuthorityRecheck;
  readonly signal: AbortSignal; readonly sessionId?: string; readonly identityTurnId?: string; readonly botAppId?: string;
}
export interface BytedcliCredentialLease {
  readonly realm?: 'bytecloud' | 'gdpr';
  readonly jwt: string; readonly kind: 'machine' | 'actor'; readonly region: 'cn'; readonly expiresAt: number;
  readonly accountFingerprint: string; readonly source: 'machine' | 'local' | 'platform';
  readonly stillCurrent: (signal?: AbortSignal) => Promise<BytedcliExecErrorCode | undefined>;
}
export interface BytedcliLeaseResolver {
  realm?(realm: 'gdpr', kind: 'machine' | 'actor', request: BytedcliLeaseRequest): Promise<BytedcliCredentialLease>;
  machine(request: BytedcliLeaseRequest): Promise<BytedcliCredentialLease>;
  actor(request: BytedcliLeaseRequest): Promise<BytedcliCredentialLease>;
}
export interface BytedcliOfficialAccount { readonly username: string; readonly email: string; readonly emails?: readonly string[]; readonly type?: string }
interface CredentialContext { readonly home: string; readonly profile?: string; readonly signal: AbortSignal }
export interface BytedcliCredentialProvider {
  observe(context: CredentialContext): Promise<{ authenticated: boolean; loginFingerprint?: string }>;
  mint(context: CredentialContext): Promise<string | undefined>;
  /** Must query official provider with this exact CN request JWT, no fallback. */
  userinfo(jwt: string, signal: AbortSignal): Promise<BytedcliOfficialAccount>;
}
export interface BytedcliPlatformLeaseProvider {
  bindingKey(): string | undefined;
  resolve(request: BytedcliLeaseRequest): Promise<{ jwt: string; expiresAt: number; bindingKey: string; unionId: string } | undefined>;
}
export interface BytedcliCredentialDependencies {
  readonly machineHome: string; readonly machineProfile?: string; readonly provider: BytedcliCredentialProvider;
  readonly localHome: (openId: string) => string;
  readonly localQueue: <T>(openId: string, run: () => Promise<T>) => Promise<T>;
  readonly readEpoch: (openId: string) => number; readonly epochAllows: (openId: string, home: string) => boolean;
  readonly platform: BytedcliPlatformLeaseProvider;
}
export function parseBytedcliMachineProfile(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new BytedcliBrokerError('invalid_request');
  return value;
}
export function bytedcliSafeFingerprint(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
const machineQueues = new Map<string, Promise<unknown>>();
async function machineQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = machineQueues.get(key);
  const work = (async () => { await previous?.catch(() => undefined); return run(); })();
  machineQueues.set(key, work);
  try { return await work; } finally { if (machineQueues.get(key) === work) machineQueues.delete(key); }
}
async function check(request: BytedcliLeaseRequest): Promise<void> {
  if (request.signal.aborted) throw new BytedcliBrokerError('cancelled');
  const code = await request.recheck(); if (code) throw new BytedcliBrokerError(code);
  if (request.signal.aborted) throw new BytedcliBrokerError('cancelled');
}
function tokenExpiry(jwt: string, region: string): number {
  if (typeof jwt !== 'string' || jwt.length > 16 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
    throw new BytedcliBrokerError('region_auth_required');
  }
  const claims = jwtClaims(jwt);
  if (region !== 'cn' || claims?.region !== 'cn' || typeof claims.exp !== 'number'
    || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now() + 5000
    || claims.exp * 1000 > Date.now() + 4 * 3600_000) throw new BytedcliBrokerError('region_auth_required');
  return claims.exp * 1000;
}
function accountFingerprint(info: BytedcliOfficialAccount, jwt: string, expectedEmail?: string): string {
  if (!info || info.type === 'app' || typeof info.username !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(info.username)
    || typeof info.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(info.email)) throw new BytedcliBrokerError('actor_identity_unverified');
  const email = info.email.toLowerCase();
  if (expectedEmail !== undefined && email !== expectedEmail.toLowerCase()) throw new BytedcliBrokerError('actor_identity_unverified');
  // Payload claims are consistency checks only. The official userinfo query
  // above authenticates the borrowed token and its account to the provider.
  const claims = jwtClaims(jwt) as Record<string, unknown> | null;
  for (const key of ['email', 'mail']) {
    if (claims?.[key] !== undefined && claims[key] !== email && claims[key] !== info.email) throw new BytedcliBrokerError('actor_identity_unverified');
  }
  for (const key of ['username', 'user_name']) {
    if (claims?.[key] !== undefined && claims[key] !== info.username) throw new BytedcliBrokerError('actor_identity_unverified');
  }
  return bytedcliSafeFingerprint([info.username, email]);
}

export class BytedcliCredentialResolver implements BytedcliLeaseResolver {
  private readonly profile: string | undefined;
  constructor(private readonly deps: BytedcliCredentialDependencies) {
    this.profile = parseBytedcliMachineProfile(deps.machineProfile);
    if (!isAbsolute(deps.machineHome) || resolve(deps.machineHome) !== deps.machineHome) throw new BytedcliBrokerError('invalid_request');
  }
  async machine(request: BytedcliLeaseRequest): Promise<BytedcliCredentialLease> {
    await check(request);
    return machineQueue(JSON.stringify([this.deps.machineHome, this.profile]), () => this.localLease(request, 'machine', this.deps.machineHome, this.profile));
  }
  async actor(request: BytedcliLeaseRequest): Promise<BytedcliCredentialLease> {
    await check(request); const actor = request.actor;
    if (!actor || !/^[^\s@]+@[^\s@]+$/.test(actor.verifiedEmail)) throw new BytedcliBrokerError('actor_required');
    if (!['local', 'platform', 'auto'].includes(actor.source)) throw new BytedcliBrokerError('invalid_request');
    const binding = actor.source === 'local' ? undefined : this.deps.platform.bindingKey();
    const epoch = this.deps.readEpoch(actor.credentialOpenId);
    const epochCurrent = () => this.deps.readEpoch(actor.credentialOpenId) === epoch;
    if (actor.source === 'platform' || (actor.source === 'auto' && binding)) {
      if (!binding) throw new BytedcliBrokerError('actor_auth_required');
      const grant = await this.deps.platform.resolve(request); await check(request);
      if (!epochCurrent()) throw new BytedcliBrokerError('authorization_revoked');
      if (this.deps.platform.bindingKey() !== binding || (grant && grant.bindingKey !== binding)) throw new BytedcliBrokerError('binding_changed');
      if (!grant) throw new BytedcliBrokerError('actor_auth_required');
      if (actor.unionId && actor.unionId !== grant.unionId) throw new BytedcliBrokerError('actor_identity_unverified');
      const expiresAt = Math.min(tokenExpiry(grant.jwt, request.region), grant.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5000) throw new BytedcliBrokerError('actor_auth_required');
      const info = await this.deps.provider.userinfo(grant.jwt, request.signal); await check(request);
      const fingerprint = accountFingerprint(info, grant.jwt, actor.verifiedEmail);
      const stillCurrent: BytedcliAuthorityRecheck = async () => {
        const code = await request.recheck(); if (code) return code;
        if (this.deps.platform.bindingKey() !== binding) return 'binding_changed';
        if (!epochCurrent()) return 'authorization_revoked';
        if (Date.now() >= expiresAt) return 'authorization_revoked';
        return undefined;
      };
      const code = await stillCurrent(); if (code) throw new BytedcliBrokerError(code);
      return Object.freeze({ jwt: grant.jwt, kind: 'actor', region: 'cn', expiresAt, accountFingerprint: fingerprint, source: 'platform', stillCurrent });
    }
    const home = this.deps.localHome(actor.credentialOpenId);
    const frozenRequest = actor.source === 'auto' ? { ...request, recheck: async () => {
      const code = await request.recheck(); if (code) return code;
      return this.deps.platform.bindingKey() !== binding ? 'binding_changed' : undefined;
    } } : request;
    return this.deps.localQueue(actor.credentialOpenId, () => this.localLease(frozenRequest, 'actor', home, undefined, epoch));
  }
  private async localLease(request: BytedcliLeaseRequest, kind: 'machine' | 'actor', home: string, profile?: string, epoch?: number): Promise<BytedcliCredentialLease> {
    const openId = request.actor?.credentialOpenId;
    const authCurrent = () => kind === 'machine' || (!!openId && this.deps.readEpoch(openId) === epoch && this.deps.epochAllows(openId, home));
    await check(request); if (!authCurrent()) throw new BytedcliBrokerError('authorization_revoked');
    const context = { home, profile, signal: request.signal };
    const before = await this.deps.provider.observe(context); await check(request);
    if (!before.authenticated) throw new BytedcliBrokerError(kind === 'machine' ? 'machine_auth_required' : 'actor_auth_required');
    if (!before.loginFingerprint) throw new BytedcliBrokerError(kind === 'machine' ? 'machine_auth_required' : 'actor_identity_unverified');
    const jwt = await this.deps.provider.mint(context); await check(request);
    if (!authCurrent()) throw new BytedcliBrokerError('authorization_revoked');
    if (!jwt) throw new BytedcliBrokerError(kind === 'machine' ? 'machine_auth_required' : 'actor_auth_required');
    const expiresAt = tokenExpiry(jwt, request.region);
    const info = await this.deps.provider.userinfo(jwt, request.signal); await check(request);
    const fingerprint = accountFingerprint(info, jwt, kind === 'actor' ? request.actor!.verifiedEmail : undefined);
    const current = async (signal: AbortSignal = request.signal): Promise<BytedcliExecErrorCode | undefined> => {
      const code = await request.recheck(); if (code) return code;
      if (!authCurrent() || Date.now() >= expiresAt) return 'authorization_revoked';
      const after = await this.deps.provider.observe({ ...context, signal });
      if (!authCurrent()) return 'authorization_revoked';
      if (!after.authenticated || after.loginFingerprint !== before.loginFingerprint) return 'binding_changed';
      return request.recheck();
    };
    const code = await current(); if (code) throw new BytedcliBrokerError(code);
    const stillCurrent = (signal?: AbortSignal) => kind === 'machine'
      ? machineQueue(JSON.stringify([home, profile]), () => current(signal))
      : this.deps.localQueue(openId!, () => current(signal));
    return Object.freeze({ jwt, kind, region: 'cn', expiresAt, accountFingerprint: fingerprint,
      source: kind === 'machine' ? 'machine' : 'local', stillCurrent });
  }
}

export interface BytedcliHostCredentialOptions {
  readonly machineHome: string; readonly machineProfile?: string; readonly privateRoot: string;
  readonly trustedCli: (signal: AbortSignal) => Promise<BytedcliTrustedCli>;
  readonly networkEnv?: Readonly<NodeJS.ProcessEnv>; readonly run?: BytedcliChildRunner;
}
/** Production wiring: persistent HOME is used only for status/mint. Scoped
 * official userinfo runs in a separate empty HOME and cannot fall back. */
export async function createBytedcliHostCredentialResolver(options: BytedcliHostCredentialOptions): Promise<BytedcliCredentialResolver> {
  const platform = await import('./platform-credential-source.js');
  const run = options.run ?? runBoundedBytedcliChild;
  const sdk = async (args: readonly string[], signal: AbortSignal, home?: string, profile?: string, jwt?: string) => {
    if (signal.aborted) throw new BytedcliBrokerError('cancelled');
    ensureBytedcliPrivateDirectory(options.privateRoot);
    const root = mkdtempSync(join(options.privateRoot, 'credential-'));
    try {
      const cwd = join(root, 'cwd'); mkdirSync(cwd, { mode: 0o700 });
      const executionHome = home ?? join(root, 'home');
      if (!home) mkdirSync(executionHome, { mode: 0o700 });
      const cli = await options.trustedCli(signal);
      if (signal.aborted) throw new BytedcliBrokerError('cancelled');
      if (!cli.stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
      const argv = ['--site', 'cn', ...(profile ? ['--profile', parseBytedcliMachineProfile(profile)!] : []), ...args];
      if (jwt) {
        const path = join(root, 'request.jwt'); const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, jwt); } finally { closeSync(fd); }
        argv.unshift('--bytecloud-user-jwt-file', path);
      }
      const result = await run({ executable: cli.executable, argv: [...(cli.prefixArgs ?? []), ...argv], cwd, env: bytedcliMinimalEnv(executionHome, cwd, cli.path, options.networkEnv),
        signal, timeoutMs: 30_000, outputLimitBytes: 64 * 1024 });
      if (result.exitCode !== 0 || !cli.stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
      return result.stdout.toString('utf8');
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const provider: BytedcliCredentialProvider = {
    observe: async ({ home, profile, signal }) => {
      if (!existsSync(home)) return { authenticated: false };
      const envelope = parseEnvelope(await sdk(['--json', 'auth', 'status'], signal, home, profile));
      const data = envelope?.data as Record<string, unknown> | undefined;
      const auth = data?.bytecloud_auth as Record<string, unknown> | undefined;
      if (envelope?.status !== 'success' || typeof data?.authenticated !== 'boolean' || data.auth_as === 'app' || auth?.authType === 'app') {
        throw new BytedcliBrokerError('executor_unavailable');
      }
      return { authenticated: data.authenticated, loginFingerprint: bytedcliLoginFingerprint(data, auth) };
    },
    mint: async ({ home, profile, signal }) => (await sdk(['auth', 'get-bytecloud-jwt-token'], signal, home, profile)).trim() || undefined,
    userinfo: async (jwt, signal) => {
      const envelope = parseEnvelope(await sdk(['--json', 'auth', 'userinfo'], signal, undefined, undefined, jwt));
      if (envelope?.status !== 'success' || !envelope.data || typeof envelope.data !== 'object'
        || (envelope.data as Record<string, unknown>).auth_source !== 'request_jwt') throw new BytedcliBrokerError('actor_identity_unverified');
      return envelope.data as BytedcliOfficialAccount;
    },
  };
  return new BytedcliCredentialResolver({ machineHome: options.machineHome, machineProfile: options.machineProfile, provider,
    localHome: bytedcliHomeFor, localQueue: serializedCredentialWork, readEpoch: readCliAuthEpoch, epochAllows: cliAuthEpochAllows,
    platform: { bindingKey: platform.activePlatformCredentialBindingKey, resolve: async request => {
      if (!request.actor || !request.botAppId || !request.sessionId) throw new BytedcliBrokerError('execution_unverified');
      const result = await platform.resolvePlatformIdentity({ botConfig: { larkAppId: request.botAppId }, tool: 'bytedcli',
        sessionId: request.sessionId, turnId: request.identityTurnId, cloudJwtRegions: ['cn'], signal: request.signal,
        ...(request.actor.unionId ? { unionId: request.actor.unionId } : { openId: request.actor.credentialOpenId }) });
      if (result.state === 'denied') throw new BytedcliBrokerError('permission_denied');
      if (result.state !== 'granted' || result.identity.tool !== 'bytedcli') return undefined;
      const jwt = result.identity.regionalCloudJwts?.cn
        ?? (jwtClaims(result.identity.cloudJwt)?.region === 'cn' ? result.identity.cloudJwt : undefined);
      if (!jwt) throw new BytedcliBrokerError('region_auth_required');
      return { jwt, expiresAt: result.expiresAt, bindingKey: result.bindingKey, unionId: result.unionId };
    } } });
}
