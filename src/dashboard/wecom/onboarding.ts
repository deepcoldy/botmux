import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock } from '../../utils/file-lock.js';
import { expandHomePath } from '../../utils/working-dir.js';
import { resolveCliSelection } from '../../setup/cli-selection.js';
import { checkCliAvailability } from '../../setup/cli-availability.js';
import { commitWecomConfiguration, parseWecomConfig, readWecomConfigSnapshot, readWecomCredentialFile, type WecomConfig } from '../../im/wecom/config/config.js';
import { readWecomConfigPaths, registerWecomConfig, wecomConfigId, wecomRoot } from '../../im/wecom/config/discovery.js';
import { WecomDashboardManager } from './manager.js';
import { WECOM_LIFECYCLE_CLI_TIMEOUT_MS } from './lifecycle-cli.js';
import { fleetProcessIdentityRuntime, type FleetProcessIdentityRuntime } from '../../core/fleet-process-identity.js';
import { inspectWecomProcess } from '../../im/wecom/config/runtime.js';
import { readWecomFleetDesiredState } from '../../im/wecom/config/fleet-desired-state.js';
import { WecomDashboardSessions } from './sessions.js';
import { createWecomQrAuthorization } from '../../im/wecom/protocol/qr-auth.js';
import { pairDraftWecomIdentity } from './draft-identity.js';
import { renderQrSvgDataUrl } from '../bot-onboarding.js';
import { jsonRes } from '../http.js';
import type { WecomOnboardingSnapshot } from '../../im/wecom/contract/dashboard-dto.js';
import { isWecomManualBotId, isWecomManualSecret } from '../../im/wecom/contract/manual-credentials.js';
export interface OnboardingActor {
  userId: string;
  authSessionId: string;
}
interface Input {
  appName: string;
  cliId: string;
  workingDir: string;
  model?: string;
  backend: 'pty' | 'tmux';
  port: number;
  wrapperCli?: string;
  cliLaunchMode?: 'forge-traex';
  dirMode: 'fixed' | 'card';
  mode: 'qr' | 'manual';
}
interface Receipt {
  version: 1;
  owner: string;
  generation: number;
  snapshot: WecomOnboardingSnapshot;
  input: Input;
  botId?: string;
  draftSecret?: string;
  ownerProof?: { userid: string; verifiedAt: string; generation: number };
  file?: string;
  configRevision?: string;
  plannedConfig?: WecomConfig;
  /** Saved before this job asks the fleet to start the connection: a cancel then
   *  stops it, whichever Dashboard process handles the cancel. */
  startRequestedAt?: number;
  /** The `botmux wecom start` command this job ran, saved right after it was
   *  spawned: a Dashboard that did not spawn it can still wait for it to end. */
  startCommand?: { pid: number; processStart?: string; pidNamespace?: string };
  /**
   * A cancel owes the connection a stop. Saved together with the cancel, before
   * the cancel is answered, and cleared only once a stop command confirmed the
   * connection stopped — so a Dashboard that goes away first (`botmux restart`,
   * an auto-update) leaves the stop to the next one.
   */
  stopOwed?: {
    since: number;
    /** Failed stop attempts so far (the last one's reason below). */
    attempts: number;
    lastFailure?: { reason: string; message: string; at: number };
    /**
     * When the start this job asked for was first seen over (its command ended,
     * no action of this Dashboard on the connection ran). A `running` record
     * written after it is a person's later start, which the owed stop leaves be.
     */
    commandsEndedAt?: number;
  };
}
interface Job {
  receipt: Receipt;
  abort: AbortController;
  running?: Promise<void>;
  expiration?: ReturnType<typeof setTimeout>;
  persistedGeneration?: number;
  pendingCredentials?: { botId: string; secret: string };
  /** This process is settling the receipt's owed stop. */
  settlingStop?: Promise<void>;
}
export interface WecomOnboardingOptions {
  root?: string;
  now?: () => number;
  isActorLive?: (actor: OnboardingActor) => boolean;
  preflight?: (raw: Record<string, unknown>) => Promise<Input>;
  authorize?: typeof createWecomQrAuthorization;
  pair?: typeof pairDraftWecomIdentity;
  commit?: typeof commitWecomConfiguration;
  register?: typeof registerWecomConfig;
  manager?: OnboardingConnections;
  waitForReady?: (id: string, signal: AbortSignal) => Promise<void>;
  writeDraft?: typeof atomicWriteFileSync;
  coreSessions?: Pick<WecomDashboardSessions, 'coreReady'>;
  /** Reads the start command's birth identity; tests inject their own. */
  processRuntime?: FleetProcessIdentityRuntime;
  /** Waits between failed attempts at an owed stop (default WECOM_OWED_STOP_RETRY_DELAYS_MS). */
  stopRetryDelaysMs?: readonly number[];
  /** How often a start command another Dashboard spawned is checked for having ended. */
  startCommandPollMs?: number;
}

type OnboardingConnections = Pick<WecomDashboardManager, 'begin' | 'connection' | 'idle'>
  & Partial<Pick<WecomDashboardManager, 'noteFailure'>>;

/**
 * Waits between failed attempts at the stop a cancel owes (a stop command can
 * fail on a busy fleet lock, a supervisor that does not answer in time, …):
 * six attempts over about four minutes. After the last one the connection's row
 * says the stop did not happen; the next Dashboard start tries again.
 */
export const WECOM_OWED_STOP_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const actorKey = (actor: OnboardingActor) => digest(JSON.stringify([actor.userId, actor.authSessionId]));

/** A start the fleet did not carry out; `detail` is what the wizard shows. */
class WecomStartFailedError extends Error {
  constructor(readonly detail: string) {
    super('wecom_start_pending');
  }
}

/** `work`, or a cancellation as soon as `signal` aborts (`work` itself keeps going). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('wecom_onboarding_cancelled'));
  }
  return new Promise<T>((done, reject) => {
    const cancel = () => reject(new Error('wecom_onboarding_cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    work.then(
      value => {
        signal.removeEventListener('abort', cancel);
        done(value);
      },
      error => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}

/**
 * Where a new connection's managed core port is picked from. The core binds
 * its port by number on every start, so the port must not come from the range
 * the OS hands out on its own (Linux 32768–60999, macOS 49152–65535 by
 * default): any process may be given it there while the core is stopped. The
 * range also stays clear of botmux's own listeners (Dashboard 7891–7911,
 * daemon IPC 7950+, Feishu terminal proxies 8800+, WeCom core terminal proxies
 * 18800+, and 19123, the default port of configurations written by the
 * former manual terminal setup).
 */
export const WECOM_CORE_PORT_RANGE = { first: 20000, last: 29999 } as const;

/** The OS's ephemeral port range: Linux reports it; elsewhere the IANA default (macOS uses it). */
export function hostEphemeralPortRange(
  platform: NodeJS.Platform = process.platform,
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): { first: number; last: number } {
  if (platform === 'linux') {
    try {
      const [first, last] = readText('/proc/sys/net/ipv4/ip_local_port_range').trim().split(/\s+/).map(Number);
      if (Number.isInteger(first) && Number.isInteger(last) && first > 0 && first <= last) {
        return { first, last };
      }
    } catch {
      // Fall back to the kernel default below.
    }
    return { first: 32768, last: 60999 };
  }
  return { first: 49152, last: 65535 };
}

/** Can `port` be bound on loopback and on every interface (the gateway checks both before starting its core)? */
function canBindPort(port: number): Promise<boolean> {
  const attempt = (host: string) => new Promise<boolean>(done => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, host, () => {
      server.close(() => done(true));
    });
  });
  return attempt('127.0.0.1').then(loopback => loopback && attempt('0.0.0.0'));
}

/** Managed core ports of the configurations already registered (unreadable ones are skipped). */
function registeredCorePorts(): Set<number> {
  const ports = new Set<number>();
  for (const path of readWecomConfigPaths()) {
    try {
      const port = parseWecomConfig(JSON.parse(readFileSync(path, 'utf8'))).managedCore?.port;
      if (port) {
        ports.add(port);
      }
    } catch {
      // Not readable: it cannot be holding a port we would hand out twice.
    }
  }
  return ports;
}

/**
 * Pick a free port for a new managed core in WECOM_CORE_PORT_RANGE, outside
 * the host's ephemeral range and not used by another registered configuration.
 * Starts at a random offset so two wizards running at once do not probe the
 * same ports in the same order.
 */
export async function allocateWecomCorePort(deps: {
  ephemeral?: { first: number; last: number };
  taken?: ReadonlySet<number>;
  canBind?: (port: number) => Promise<boolean>;
  random?: () => number;
  maxAttempts?: number;
} = {}): Promise<number> {
  const ephemeral = deps.ephemeral ?? hostEphemeralPortRange();
  const taken = deps.taken ?? registeredCorePorts();
  const candidates: number[] = [];
  for (let port = WECOM_CORE_PORT_RANGE.first; port <= WECOM_CORE_PORT_RANGE.last; port++) {
    if ((port < ephemeral.first || port > ephemeral.last) && !taken.has(port)) {
      candidates.push(port);
    }
  }
  const offset = Math.floor((deps.random ?? Math.random)() * candidates.length);
  const attempts = Math.min(candidates.length, deps.maxAttempts ?? 200);
  for (let index = 0; index < attempts; index++) {
    const port = candidates[(offset + index) % candidates.length];
    if (await (deps.canBind ?? canBindPort)(port)) {
      return port;
    }
  }
  throw new Error('wecom_core_port_unavailable');
}
/** Run all local validation before contacting the platform or accepting credentials. */
export async function preflightWecomOnboarding(raw: Record<string, unknown>): Promise<Input> {
  const selection = resolveCliSelection(typeof raw.cliId === 'string' && raw.cliId.trim() ? raw.cliId.trim() : 'codex');
  if (!checkCliAvailability(selection).available) {
    throw new Error('wecom_cli_unavailable');
  }
  const backend = raw.backend ?? 'pty';
  if (backend !== 'pty' && backend !== 'tmux') {
    throw new Error('wecom_invalid_backend');
  }
  if (backend === 'tmux' && spawnSync('tmux', ['-V'], { stdio: 'ignore', timeout: 3000 }).status !== 0) {
    throw new Error('wecom_backend_unavailable');
  }
  const workingDir = resolve(expandHomePath(typeof raw.workingDir === 'string' && raw.workingDir.trim() ? raw.workingDir.trim() : '~'));
  try {
    if (!statSync(workingDir).isDirectory()) {
      throw new Error();
    }
  } catch {
    throw new Error('wecom_working_directory_unavailable');
  }
  const appName = typeof raw.appName === 'string' ? raw.appName.trim() : '';
  if (appName.length > 64 || /[\x00-\x1f]/.test(appName)) {
    throw new Error('wecom_invalid_display_name');
  }
  if (raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.length > 200 || /[\x00-\x1f]/.test(raw.model))) {
    throw new Error('wecom_invalid_model');
  }
  if (raw.dirMode !== undefined && !['fixed', 'card'].includes(String(raw.dirMode))) {
    throw new Error('wecom_invalid_dir_mode');
  }
  if (raw.mode !== undefined && raw.mode !== 'qr' && raw.mode !== 'manual') {
    throw new Error('wecom_invalid_onboarding_mode');
  }
  return {
    appName,
    cliId: selection.cliId,
    wrapperCli: selection.wrapperCli,
    cliLaunchMode: selection.cliLaunchMode,
    backend,
    workingDir,
    model: typeof raw.model === 'string' ? raw.model.trim() || undefined : undefined,
    dirMode: raw.dirMode === 'card' ? 'card' : 'fixed',
    mode: raw.mode === 'manual' ? 'manual' : 'qr',
    port: await allocateWecomCorePort(),
  };
}
/** Provider-specific private receipt. A browser snapshot never contains credentials,
* callback userid, config paths, auth sessions, or platform polling capabilities. */
export class WecomOnboardingManager {
  private readonly root: string;
  private readonly jobs = new Map<string, Job>();
  private readonly manager: OnboardingConnections;
  constructor(private readonly options: WecomOnboardingOptions = {}) {
    this.root = options.root ?? wecomRoot();
    this.manager = options.manager ?? new WecomDashboardManager({ root: this.root });
    // Cleanup private expired receipts even if their old login no longer exists,
    // and take up every stop a cancel owes (an earlier Dashboard went away first).
    try {
      for (const file of readdirSync(join(this.root, 'onboarding')).filter(name => /^wecom-[a-f0-9-]{36}\.json$/.test(name))) {
        try {
          const id = file.slice(0, -5);
          const receipt = JSON.parse(readFileSync(join(this.root, 'onboarding', file), 'utf8')) as Receipt;
          if (receipt.version !== 1 || receipt.snapshot.id !== id) {
            continue;
          }
          if (receipt.stopOwed) {
            const job = this.loadReceipt(id);
            if (job) {
              this.expire(job);
            }
          } else if (this.now() >= receipt.snapshot.resumeUntil) {
            this.expire({ receipt, abort: new AbortController(), persistedGeneration: receipt.generation });
          }
        } catch { /* unreadable receipts cannot become active jobs */ }
      }
    } catch { /* no drafts yet */ }
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private armExpiry(job: Job) {
    if (job.expiration) {
      clearTimeout(job.expiration);
    }
    if (job.receipt.snapshot.status === 'completed') {
      return;
    }
    job.expiration = setTimeout(() => {
      try {
        this.expire(job);
      } catch { /* next access retries cleanup */ }
    }, Math.max(1, job.receipt.snapshot.resumeUntil - this.now()));
    job.expiration.unref();
  }
  private clearDraft(job: Job) {
    const r = job.receipt;
    delete job.pendingCredentials;
    {
      try {
        unlinkSync(join(this.root, 'onboarding', `${r.snapshot.id}.secret`));
      } catch { /* best effort; never remove a committed generation */ }
    }
    delete r.draftSecret;
    delete r.ownerProof;
    delete r.plannedConfig;
  }
  private expire(job: Job) {
    const s = job.receipt.snapshot;
    if (s.status === 'completed' || s.error === 'wecom_onboarding_expired' || this.now() < s.resumeUntil) {
      return;
    }
    job.abort.abort();
    job.receipt.generation++;
    if (!job.running) {
      this.clearDraft(job);
    }
    this.patch(job, {
      status: 'failed',
      error: 'wecom_onboarding_expired',
      retryable: false,
      pairingCode: undefined,
      qrUrl: undefined,
      qrDataUrl: undefined,
      message: s.saved
        ? '本地向导已过期；已保存配置保留，请从机器人列表管理。'
        : '本地向导已过期，草稿凭据已清理；已创建的平台机器人仍保留，可用已有机器人入口重新绑定。',
    });
  }
  private path(id: string) {
    return join(this.root, 'onboarding', `${id}.json`);
  }
  private save(job: Job) {
    const path = this.path(job.receipt.snapshot.id);
    if (existsSync(path)) {
      const durable = JSON.parse(readFileSync(path, 'utf8')) as Receipt;
      if (durable.owner !== job.receipt.owner || durable.generation !== job.persistedGeneration) {
        throw new Error('wecom_onboarding_stale_generation');
      }
    } else if (job.persistedGeneration !== undefined) {
      throw new Error('wecom_onboarding_stale_generation');
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, JSON.stringify(job.receipt), { mode: 0o600, durable: true, followTargetSymlink: false });
    job.persistedGeneration = job.receipt.generation;
  }
  private patch(job: Job, patch: Partial<WecomOnboardingSnapshot>) {
    Object.assign(job.receipt.snapshot, patch, { updatedAt: this.now() });
    this.save(job);
  }
  private assert(job: Job, actor: OnboardingActor, generation: number) {
    this.expire(job);
    const durable = JSON.parse(readFileSync(this.path(job.receipt.snapshot.id), 'utf8')) as Receipt;
    if (durable.generation !== generation || durable.owner !== job.receipt.owner || job.abort.signal.aborted
      || job.receipt.generation !== generation || job.receipt.owner !== actorKey(actor) || this.options.isActorLive?.(actor) === false) {
      throw new Error('wecom_onboarding_cancelled');
    }
  }
  private load(id: string, actor: OnboardingActor): Job | undefined {
    if (!/^wecom-[a-f0-9-]{36}$/.test(id)) {
      return;
    }
    const job = this.jobs.get(id) ?? this.loadReceipt(id, actorKey(actor));
    if (!job || job.receipt.owner !== actorKey(actor)) {
      return;
    }
    this.expire(job);
    return job;
  }
  /**
   * Make a receipt on disk this process's job (only `owner`'s, when given). A
   * receipt whose run was interrupted becomes a failed, retryable job; one that
   * owes a stop starts settling it.
   */
  private loadReceipt(id: string, owner?: string): Job | undefined {
    let job: Job;
    try {
      const receipt = JSON.parse(readFileSync(this.path(id), 'utf8')) as Receipt;
      if (receipt.version !== 1 || receipt.snapshot.id !== id || (owner !== undefined && receipt.owner !== owner)) {
        return;
      }
      job = { receipt, abort: new AbortController(), persistedGeneration: receipt.generation };
      // A crash after the credential rename but before the receipt
      // update must resume this platform bot, never request a new QR.
      const orphanDraft = join(this.root, 'onboarding', `${id}.secret`);
      if (!receipt.botId && existsSync(orphanDraft)) {
        const credentials = this.readDraft(orphanDraft);
        receipt.botId = credentials.botId;
        receipt.draftSecret = orphanDraft;
        receipt.file = join(this.root, 'connections', digest(credentials.botId), 'config.json');
        receipt.snapshot.externalBotCreated = receipt.input.mode === 'qr';
        receipt.snapshot.retryable = true;
      }
      if (!['completed', 'cancelled', 'failed'].includes(receipt.snapshot.status)) {
        receipt.generation++;
        receipt.snapshot.status = 'failed';
        receipt.snapshot.error = 'wecom_onboarding_interrupted';
        receipt.snapshot.retryable = Boolean(receipt.botId);
        delete receipt.snapshot.pairingCode;
        delete receipt.snapshot.qrUrl;
        delete receipt.snapshot.qrDataUrl;
        this.save(job);
      }
      this.jobs.set(id, job);
      this.armExpiry(job);
    } catch {
      return;
    }
    if (job.receipt.stopOwed) {
      void this.settleOwedStop(job);
    }
    return job;
  }
  get(id: string, actor: OnboardingActor): WecomOnboardingSnapshot | undefined {
    const job = this.load(id, actor);
    return job ? {
      ...job.receipt.snapshot,
    } : undefined;
  }
  list(actor: OnboardingActor): WecomOnboardingSnapshot[] {
    let files: string[] = [];
    try {
      files = readdirSync(join(this.root, 'onboarding'));
    } catch {
      return [];
    }
    return files.filter(file => /^wecom-[a-f0-9-]{36}\.json$/.test(file)).flatMap(file => {
      const snapshot = this.get(file.slice(0, -5), actor);
      return snapshot && snapshot.status !== 'completed' ? [snapshot] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async start(raw: Record<string, unknown>, actor: OnboardingActor): Promise<WecomOnboardingSnapshot> {
    const input = await (this.options.preflight ?? preflightWecomOnboarding)(raw);
    if (this.options.isActorLive?.(actor) === false) {
      throw new Error('wecom_onboarding_cancelled');
    }
    let manual: { botId: string; secret: string } | undefined;
    if (input.mode === 'manual') {
      if (!isWecomManualBotId(raw.botId) || !isWecomManualSecret(raw.secret)) {
        throw new Error('wecom_invalid_credentials');
      }
      manual = { botId: raw.botId.trim(), secret: raw.secret.trim() };
    }
    const id = `wecom-${randomUUID()}`;
    const now = this.now();
    const job: Job = {
      abort: new AbortController(),
      receipt: {
        version: 1,
        owner: actorKey(actor),
        generation: 1,
        input,
        snapshot: {
          id,
          platform: 'wecom',
          status: 'starting',
          createdAt: now,
          updatedAt: now,
          resumeUntil: now + 24 * 60 * 60 * 1000,
          appName: input.appName,
          cliId: input.cliId,
          workingDir: input.workingDir,
          externalBotCreated: false,
          saved: false,
          retryable: false,
        },
      },
    };
    this.save(job);
    this.jobs.set(id, job);
    this.armExpiry(job);
    this.launch(job, actor, manual);
    return {
      ...job.receipt.snapshot,
    };
  }
  private launch(job: Job, actor: OnboardingActor, manual?: { botId: string; secret: string }) {
    const generation = job.receipt.generation;
    job.running = this.run(job, actor, generation, manual).catch((error: unknown) => {
      if (job.receipt.generation !== generation || job.abort.signal.aborted) {
        return;
      }
      try {
        this.patch(job, {
          status: 'failed',
          error: job.receipt.snapshot.saved
            ? 'wecom_start_pending'
            : error instanceof Error && /^wecom_[a-z_]+$/.test(error.message) ? error.message : 'wecom_onboarding_failed',
          retryable: Boolean(job.receipt.botId),
          pairingCode: undefined,
          qrUrl: undefined,
          qrDataUrl: undefined,
          message: job.receipt.snapshot.saved
            ? error instanceof WecomStartFailedError ? error.detail : '配置已保存，尚未确认上线；重试将继续启动同一机器人。'
            : job.receipt.snapshot.externalBotCreated
              ? '企业微信机器人已创建，重试只继续本地配对和保存，不会再次创建。'
              : '本地流程未完成，请检查网络或刷新二维码。',
        });
      } catch { /* keep the last durable receipt for explicit recovery */ }
    }).finally(() => {
      job.running = undefined;
      if (job.receipt.snapshot.error === 'wecom_onboarding_expired') {
        this.clearDraft(job);
        try {
          this.save(job);
        } catch { /* expiry is already durable */ }
      }
    });
  }
  private assertNoExistingBot(botId: string, ownFile?: string) {
    for (const path of readWecomConfigPaths(this.root, true)) {
      if (!existsSync(path) || path === ownFile) {
        continue;
      }
      let config: WecomConfig;
      try {
        config = parseWecomConfig(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        throw new Error('wecom_configuration_invalid');
      }
      if (config.botId === botId) {
        throw new Error('wecom_bot_already_configured');
      }
    }
  }
  private async run(job: Job, actor: OnboardingActor, generation: number, manual?: { botId: string; secret: string }) {
    const check = () => this.assert(job, actor, generation);
    const r = job.receipt;
    check();
    if (!r.botId) {
      if (r.input.mode === 'manual' && !manual) {
        throw new Error('wecom_manual_credentials_required');
      }
      let credentials = manual;
      if (!credentials) {
        const auth = await (this.options.authorize ?? createWecomQrAuthorization)({ signal: job.abort.signal });
        try {
          check();
          this.patch(job, {
            status: 'waiting_for_scan',
            qrUrl: auth.authUrl,
            qrDataUrl: renderQrSvgDataUrl(auth.authUrl),
            expireAt: auth.expiresAt,
          });
          credentials = await auth.waitForCredentials({ signal: job.abort.signal });
        } finally {
          auth.cancel();
        }
        check();
      }
      r.botId = credentials.botId;
      r.draftSecret = join(this.root, 'onboarding', `${r.snapshot.id}.secret`);
      r.file = join(this.root, 'connections', digest(r.botId), 'config.json');
      job.pendingCredentials = credentials;
      r.snapshot.externalBotCreated = r.input.mode === 'qr';
      (this.options.writeDraft ?? atomicWriteFileSync)(r.draftSecret, JSON.stringify(credentials), {
        mode: 0o600, durable: true, followTargetSymlink: false,
      });
      this.patch(job, {
        status: 'verifying',
        externalBotCreated: r.input.mode === 'qr',
        retryable: true,
        qrUrl: undefined,
        qrDataUrl: undefined,
        expireAt: undefined,
      });
      delete job.pendingCredentials;
    }
    if (job.pendingCredentials && r.draftSecret && !existsSync(r.draftSecret)) {
      (this.options.writeDraft ?? atomicWriteFileSync)(r.draftSecret, JSON.stringify(job.pendingCredentials), {
        mode: 0o600, durable: true, followTargetSymlink: false,
      });
    }
    check();
    await withFileLock(join(this.root, `onboarding-target-${digest(r.botId!)}`), async () => {
      check();
      this.assertNoExistingBot(r.botId!, r.snapshot.saved ? r.file : undefined);
      if (!r.snapshot.saved) {
        // A previous atomic rename may have succeeded before its receipt update.
        // Reconcile only this immutable planned generation, never another config.
        const visible = readWecomConfigSnapshot(r.file!);
        if (visible && r.plannedConfig && this.isPlannedConfig(visible, r)) {
          r.configRevision = digest(visible);
          this.patch(job, { saved: true, connectionId: wecomConfigId(r.file!) });
        } else if (visible) {
          throw new Error('wecom_configuration_changed');
        }
      }
      if (!r.snapshot.saved) {
        this.patch(job, { status: 'verifying', pairingCode: undefined, error: undefined });
        const proof = await (this.options.pair ?? pairDraftWecomIdentity)({
          botId: r.botId!,
          secret: this.readDraft(r.draftSecret!, r.botId).secret,
          signal: job.abort.signal,
          beforeConnect: () => {
            check();
            this.assertNoExistingBot(r.botId!);
          },
          onChallenge: challenge => {
            check();
            this.patch(job, {
              status: 'needs_pairing',
              pairingCode: challenge,
              message: '请向本次绑定的机器人私聊发送本次验证码，以绑定真实企业微信身份。',
            });
          },
        });
        check();
        if (typeof proof.userid !== 'string' || !proof.userid || proof.userid.length > 200 || proof.userid === '*'
          || /[\x00-\x20]/.test(proof.userid)) {
          throw new Error('wecom_invalid_owner_proof');
        }
        r.ownerProof = { ...proof, generation };
        const identity = digest(r.botId!);
        const input = r.input;
        const coreState = join(this.root, identity, 'core');
        r.plannedConfig = parseWecomConfig({
          botId: r.botId,
          displayName: input.appName || undefined,
          secretFile: '/pending-credential-generation',
          allowedUsers: [proof.userid],
          coreUrl: `http://127.0.0.1:${input.port}`,
          stateDir: join(this.root, identity, 'bridge'),
          managedCore: {
            cli: input.cliId,
            backend: input.backend,
            workingDirectory: input.workingDir,
            model: input.model,
            port: input.port,
            stateDir: coreState,
            botId: `local_wecom_${identity.slice(0, 16)}`,
            botConfig: {
              ...(input.wrapperCli ? { wrapperCli: input.wrapperCli } : {}),
              ...(input.cliLaunchMode ? { cliLaunchMode: input.cliLaunchMode } : {}),
              ...(input.dirMode === 'fixed' ? { defaultWorkingDir: input.workingDir } : {}),
            },
          },
        });
        this.patch(job, { status: 'verifying', pairingCode: undefined, message: '身份已验证，正在保存本地配置。' });
        check();
        try {
          await (this.options.commit ?? commitWecomConfiguration)({
            file: r.file!,
            previous: undefined,
            config: r.plannedConfig,
            newSecret: this.readDraft(r.draftSecret!, r.botId).secret,
            beforeCommit: () => {
              check();
              if (r.ownerProof?.generation !== generation) {
                throw new Error('wecom_invalid_owner_proof');
              }
              this.assertNoExistingBot(r.botId!);
            },
          });
        } catch (error) {
          const committed = readWecomConfigSnapshot(r.file!);
          if (!committed || !this.isPlannedConfig(committed, r)) {
            throw error;
          }
        }
        const committed = readWecomConfigSnapshot(r.file!);
        if (!committed || !this.isPlannedConfig(committed, r)) {
          throw new Error('wecom_configuration_changed');
        }
        r.configRevision = digest(committed);
        this.patch(job, { saved: true, connectionId: wecomConfigId(r.file!) });
      }
      check();
      const current = readWecomConfigSnapshot(r.file!);
      if (!current || digest(current) !== r.configRevision) {
        throw new Error('wecom_configuration_changed');
      }
      await (this.options.register ?? registerWecomConfig)(r.file!, this.root);
      check();
      this.patch(job, {
        status: 'starting_bot',
        pairingCode: undefined,
        error: undefined,
        message: '配置已保存，正在等待机器人认证连接和本机 core 就绪。',
      });
      check();
      await this.startConnection(job, r.snapshot.connectionId!, () => {
        check();
        if (digest(readWecomConfigSnapshot(r.file!) ?? '') !== r.configRevision) {
          throw new Error('wecom_configuration_changed');
        }
      });
      check();
      if (this.options.waitForReady) {
        await this.options.waitForReady(r.snapshot.connectionId!, job.abort.signal);
      } else {
        await this.waitForReady(r.snapshot.connectionId!, job.abort.signal);
      }
      check();
      if (digest(readWecomConfigSnapshot(r.file!) ?? '') !== r.configRevision) {
        throw new Error('wecom_configuration_changed');
      }
      this.patch(job, { status: 'completed', retryable: false, liveStarted: true, message: '企业微信机器人已连接并就绪。' });
      if (job.expiration) {
        clearTimeout(job.expiration);
      }
      this.clearDraft(job);
      this.save(job);
    }, { maxWaitMs: 100 });
  }
  private readDraft(path: string, botId?: string): { botId: string; secret: string } {
    try {
      const credentials = JSON.parse(readWecomCredentialFile(path));
      if (typeof credentials.botId !== 'string' || !credentials.botId || typeof credentials.secret !== 'string' || !credentials.secret
        || (botId && credentials.botId !== botId)) {
        throw new Error();
      }
      return credentials;
    } catch {
      throw new Error('wecom_draft_credentials_unavailable');
    }
  }
  private isPlannedConfig(snapshot: string, r: Receipt): boolean {
    try {
      const config = parseWecomConfig(JSON.parse(snapshot));
      return Boolean(r.plannedConfig && r.ownerProof && config.botId === r.botId
        && JSON.stringify(config.allowedUsers) === JSON.stringify([r.ownerProof.userid])
        && readWecomCredentialFile(config.secretFile!) === this.readDraft(r.draftSecret!, r.botId).secret
        && JSON.stringify({ ...config, secretFile: undefined }) === JSON.stringify({ ...r.plannedConfig, secretFile: undefined }));
    } catch {
      return false;
    }
  }
  /**
   * Have the fleet run the new connection (`botmux wecom start`, which records
   * it as running) and wait for the command's answer. Skipped when the fleet
   * already runs it — a retry after the wizard gave up waiting, or a start from
   * the connection list. The request is saved on the receipt first, so a cancel
   * stops the connection even when this Dashboard dies before the answer.
   */
  private async startConnection(job: Job, id: string, beforeStart: () => void) {
    const signal = job.abort.signal;
    await untilAborted(this.manager.idle(id), signal);
    const current = await this.manager.connection(id);
    if (current?.ownership === 'fleet' && current.desired === 'running' && !current.notRunning) {
      return;
    }
    job.receipt.startRequestedAt = this.now();
    delete job.receipt.startCommand;
    this.save(job);
    const { settled } = this.manager.begin('start', id, {
      beforeStart,
      onSpawn: pid => this.recordStartCommand(job, pid),
    });
    const outcome = await untilAborted(settled, signal);
    if (!outcome.ok) {
      throw new WecomStartFailedError(outcome.reason === 'fleet_down'
        ? '配置已保存并记为运行；fleet 未在运行，执行 `botmux start` 后上线。'
        : `配置已保存，但启动没有完成：${outcome.message}`);
    }
  }

  /** Keep the start command's identity on the receipt (see Receipt.startCommand). */
  private recordStartCommand(job: Job, pid: number) {
    const runtime = this.options.processRuntime ?? fleetProcessIdentityRuntime;
    const processStart = runtime.readIdentity(pid);
    const pidNamespace = runtime.readPidNamespace(pid);
    job.receipt.startCommand = {
      pid,
      ...(processStart ? { processStart } : {}),
      ...(pidNamespace ? { pidNamespace } : {}),
    };
    try {
      this.save(job);
    } catch {
      // Not saved: a Dashboard taking over this job's owed stop does not wait for the command.
    }
  }

  private trySave(job: Job) {
    try {
      this.save(job);
    } catch {
      // Kept in memory; a later save, or the next Dashboard redoing the (idempotent) stop, settles it.
    }
  }

  /**
   * Resolves once the start command this job ran has ended: at once when none
   * was recorded, when it is gone, or once it has run past the Dashboard's own
   * limit for one command (it cannot be running any more).
   */
  private async startCommandEnded(r: Receipt): Promise<void> {
    const command = r.startCommand;
    if (!command || r.startRequestedAt === undefined) {
      return;
    }
    const runtime = this.options.processRuntime ?? fleetProcessIdentityRuntime;
    const alive = () => (command.processStart
      ? inspectWecomProcess({ pid: command.pid, processStart: command.processStart, pidNamespace: command.pidNamespace }, runtime).status !== 'stale'
      : runtime.pidExists(command.pid));
    // Why this limit: it is the one the Dashboard kills a command at, and it is
    // longer than the command's own bound (WECOM_LIFECYCLE_MAX_MS plus the settle
    // window, contract/lifecycle-budgets.ts). So it also holds for a command an
    // earlier Dashboard left running, which nobody kills: by then that command
    // has ended by itself, and waiting longer would only hold the owed stop back.
    // (startRequestedAt is taken just before the spawn, a moment before the kill
    // timer starts; the slack in that limit covers the difference.)
    const deadline = r.startRequestedAt + WECOM_LIFECYCLE_CLI_TIMEOUT_MS;
    while (this.now() < deadline && alive()) {
      await new Promise(done => setTimeout(done, this.options.startCommandPollMs ?? 500));
    }
  }

  /** Run the receipt's owed stop to its end; one loop per job in this process. */
  private settleOwedStop(job: Job): Promise<void> {
    job.settlingStop ??= this.runOwedStop(job).finally(() => {
      job.settlingStop = undefined;
    });
    return job.settlingStop;
  }

  /**
   * Stop the connection a cancelled job started: after the start command
   * (this Dashboard's, or one an earlier Dashboard left running) has ended and
   * no other action for the connection runs, so the stop is recorded last.
   * Retried on failure (WECOM_OWED_STOP_RETRY_DELAYS_MS); ends early when a
   * retry of the job takes the owed stop back.
   */
  private async runOwedStop(job: Job): Promise<void> {
    const r = job.receipt;
    const delays = this.options.stopRetryDelaysMs ?? WECOM_OWED_STOP_RETRY_DELAYS_MS;
    let failures = 0;
    while (r.stopOwed && r.snapshot.connectionId) {
      const id = r.snapshot.connectionId;
      await this.startCommandEnded(r);
      await this.manager.idle(id);
      if (!r.stopOwed) {
        return;
      }
      if (r.stopOwed.commandsEndedAt === undefined) {
        r.stopOwed = { ...r.stopOwed, commandsEndedAt: this.now() };
        this.trySave(job);
      }
      if (this.startedSince(id, r.stopOwed.commandsEndedAt!)) {
        // A person started the connection after this job's start was over (say,
        // from the list after the stop was given up on): that intent stands.
        delete r.stopOwed;
        delete r.startCommand;
        delete r.startRequestedAt;
        this.trySave(job);
        return;
      }
      const attempt = await this.attemptOwedStop(id, r);
      if (!r.stopOwed) {
        return;
      }
      if (attempt.kind === 'busy') {
        continue;
      }
      if (attempt.kind === 'stopped') {
        const hadFailed = r.stopOwed.lastFailure !== undefined;
        // Settled: this job no longer stands for a start, so cancelling it again stops nothing.
        delete r.stopOwed;
        delete r.startCommand;
        delete r.startRequestedAt;
        if (hadFailed && r.snapshot.status === 'cancelled') {
          this.patchQuietly(job, { message: this.cancelledMessage(r) });
        } else {
          this.trySave(job);
        }
        return;
      }
      failures++;
      r.stopOwed = {
        ...r.stopOwed,
        attempts: failures,
        lastFailure: { reason: attempt.reason, message: attempt.message, at: this.now() },
      };
      if (failures > delays.length) {
        const message = `取消向导时要停下的连接没有停下（${attempt.reason}）：${attempt.message}`
          + '；Dashboard 下次启动时会再试，也可以在连接列表里手动停止。';
        this.manager.noteFailure?.(id, { action: 'stop', reason: attempt.reason, message });
        if (r.snapshot.status === 'cancelled') {
          this.patchQuietly(job, { message: `${this.cancelledMessage(r)}${message}` });
        } else {
          this.trySave(job);
        }
        return;
      }
      this.trySave(job);
      await new Promise(done => setTimeout(done, delays[failures - 1]));
    }
  }

  /** Whether the connection was recorded `running` by a person after `since`. */
  private startedSince(id: string, since: number): boolean {
    const snapshot = readWecomFleetDesiredState(this.root);
    if (snapshot.status !== 'ok') {
      return false;
    }
    const record = snapshot.connections.get(id);
    return record?.desired === 'running' && record.reason === undefined && Date.parse(record.updatedAt) > since;
  }

  private patchQuietly(job: Job, patch: Partial<WecomOnboardingSnapshot>) {
    try {
      this.patch(job, patch);
    } catch {
      // As trySave.
    }
  }

  private cancelledMessage(r: Receipt): string {
    return r.snapshot.externalBotCreated
      ? '已取消本地流程；已创建的企业微信机器人仍保留，可重试续办。'
      : '已取消本地流程。';
  }

  /** One stop command for the owed stop. */
  private async attemptOwedStop(
    id: string,
    r: Receipt,
  ): Promise<{ kind: 'stopped' } | { kind: 'busy' } | { kind: 'failed'; reason: string; message: string }> {
    let begun: ReturnType<OnboardingConnections['begin']>;
    try {
      begun = this.manager.begin('stop', id, { force: true });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code === 'wecom_operation_in_progress') {
        return { kind: 'busy' };
      }
      if (code === 'wecom_connection_not_found' && r.file && !existsSync(r.file)) {
        // The configuration is gone: no gateway can run it, nothing is left to stop.
        return { kind: 'stopped' };
      }
      return { kind: 'failed', reason: code, message: '连接暂时无法停止' };
    }
    const outcome = await begun.settled;
    if (outcome.ok || outcome.reason === 'unknown_connection') {
      return { kind: 'stopped' };
    }
    return { kind: 'failed', reason: outcome.reason ?? 'cli_failed', message: outcome.message };
  }

  private async waitForReady(id: string, signal: AbortSignal) {
    const deadline = this.now() + 45000;
    while (this.now() < deadline) {
      if (signal.aborted) {
        throw new Error('wecom_onboarding_cancelled');
      }
      // Only this connection's row (its own processes, not every connection's): this runs every 300 ms.
      const row = await this.manager.connection(id);
      if (row?.desired === 'stopped' && row.stopReason) {
        // The gateway refused the configuration or credentials and stopped itself.
        throw new WecomStartFailedError(`配置已保存，但网关已自行停止：${row.message ?? row.stopReason}`);
      }
      if (row?.gateway === 'running' && row.connection === 'connected' && row.ownership === 'fleet'
        && await (this.options.coreSessions ?? new WecomDashboardSessions({ root: this.root })).coreReady(id)) {
        return;
      }
      await new Promise<void>((done, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(new Error('wecom_onboarding_cancelled'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', cancel);
          done();
        }, 300);
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    throw new Error('wecom_connection_not_ready');
  }
  async action(id: string, action: 'retry' | 'refresh' | 'cancel', actor: OnboardingActor): Promise<WecomOnboardingSnapshot | undefined> {
    const job = this.load(id, actor);
    if (!job) {
      return;
    }
    const r = job.receipt;
    if (r.snapshot.error === 'wecom_onboarding_expired') {
      throw new Error('wecom_onboarding_expired');
    }
    if (action === 'cancel') {
      if (r.snapshot.status === 'completed') {
        throw new Error('wecom_onboarding_already_completed');
      }
      job.abort.abort();
      r.generation++;
      // Only a connection this job asked the fleet to start is owed a stop.
      if (r.startRequestedAt !== undefined && r.snapshot.connectionId) {
        r.stopOwed = { since: this.now(), attempts: 0 };
      }
      // One durable write: the cancel and the stop it owes, before answering.
      this.patch(job, {
        status: 'cancelled',
        pairingCode: undefined,
        qrUrl: undefined,
        qrDataUrl: undefined,
        retryable: Boolean(r.botId),
        message: this.cancelledMessage(r),
      });
      if (r.stopOwed) {
        // Not awaited: a stop may wait out the start command and the gateway's
        // whole shutdown. The connection itself is kept; it is recorded as stopped.
        void this.settleOwedStop(job);
      }
      return {
        ...r.snapshot,
      };
    }
    if (job.running) {
      throw new Error('wecom_onboarding_busy');
    }
    if (action === 'refresh' && r.input.mode !== 'qr') {
      throw new Error('wecom_manual_credentials_required');
    }
    if (action === 'refresh' && r.botId) {
      throw new Error('wecom_onboarding_credentials_already_received');
    }
    if (action === 'retry' && !r.botId) {
      throw new Error('wecom_onboarding_refresh_required');
    }
    if (r.snapshot.status === 'completed') {
      throw new Error('wecom_onboarding_already_completed');
    }
    job.abort.abort();
    job.abort = new AbortController();
    r.generation++;
    // Continuing the job takes back a stop an earlier cancel owed.
    delete r.stopOwed;
    this.patch(job, {
      status: 'starting',
      pairingCode: undefined,
      error: undefined,
      qrUrl: undefined,
      qrDataUrl: undefined,
    });
    this.launch(job, actor);
    return {
      ...r.snapshot,
    };
  }
}
export async function handleWecomOnboardingApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  manager: WecomOnboardingManager;
  actor?: OnboardingActor;
  hostAdmin: boolean;
  csrfValid: () => boolean;
}): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/bot-onboarding/wecom-jobs') {
    if (!deps.hostAdmin || !deps.actor) {
      jsonRes(res, 403, { error: 'wecom_host_admin_required' });
    } else {
      jsonRes(res, 200, { jobs: deps.manager.list(deps.actor) });
    }
    return true;
  }
  const match = /^\/api\/bot-onboarding\/(wecom-[a-f0-9-]{36})(?:\/(retry|refresh|cancel))?$/.exec(url.pathname);
  if (!match) {
    return false;
  }
  if (!deps.hostAdmin || !deps.actor) {
    jsonRes(res, 403, { error: 'wecom_host_admin_required' });
    return true;
  }
  if (req.method !== 'GET' && !deps.csrfValid()) {
    jsonRes(res, 403, { error: 'control_csrf_invalid' });
    return true;
  }
  try {
    const job = req.method === 'GET' && !match[2]
      ? deps.manager.get(match[1], deps.actor)
      : req.method === 'POST' && match[2] ? await deps.manager.action(match[1], match[2] as 'retry' | 'refresh' | 'cancel', deps.actor) : undefined;
    jsonRes(res, job ? 200 : 404, job ? { job } : { error: 'unknown_onboarding_job' });
  } catch {
    jsonRes(res, 409, { error: 'wecom_onboarding_action_rejected' });
  }
  return true;
}
