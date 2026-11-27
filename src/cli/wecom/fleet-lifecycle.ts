/**
 * `botmux wecom start|stop|restart <configId> [--json]`
 * (or the member name `botmux status` shows, or `--config <file>`, instead of the id).
 *
 * A WeCom connection runs as a member of the fleet: the supervisor starts its
 * gateway, restarts it with backoff and stops it with the fleet. These commands
 * are how a person (or the Dashboard, which spawns them and parses `--json`)
 * changes one connection without touching the rest of the fleet:
 *
 *  - start:   record the desired state `running` (clearing a reason the
 *             gateway left when it stopped itself), then ask the supervisor to
 *             start the member and wait for its answer;
 *  - stop:    record `stopped` FIRST, then ask the supervisor to stop it. The
 *             record is what keeps the connection stopped across `botmux
 *             restart`, autostart and auto-update, so with no supervisor
 *             running the stop has already done its job;
 *  - restart: stop the member, wait for the answer, then start it. The desired
 *             state stays `running` throughout, so a restart that fails halfway
 *             never turns into a recorded stop. A connection that is not
 *             recorded as running is simply started.
 *
 * start / restart first make sure no instance outside the fleet already runs
 * the connection's bot (fleet-external-instance.ts, the Dashboard's facts):
 * a fleet gateway would only wait for the bot's lock and stop itself.
 *
 * A failed request never rolls the desired state back: it is the person's
 * intent and applies on the next fleet start. After a failure the supervisor is
 * nudged once more to reconcile with the recorded state.
 *
 * The fleet mutation lock is held only to record intent and hand an op to the
 * supervisor (deps.withFleetLock), never while waiting for its answer or
 * watching a gateway settle: Feishu `botmux restart` / `stop` / `start-bot` and
 * the auto-update restart take the same lock with a 5 s wait. An op whose
 * answer cannot come any more is taken back out of the queue. The supervisor
 * itself refuses an op that a newer recorded intent contradicts, and drops one
 * enqueued before it started (fleet-supervisor.ts).
 */
import { join, resolve } from 'node:path';
import { wecomConfigId } from '../../im/wecom/config/discovery.js';
import { isWecomFleetMemberName } from '../../im/wecom/config/fleet-member-name.js';
import {
  type WecomDesiredRecord,
  type WecomDesiredState,
  type WecomDesiredStateSnapshot,
  type WecomDesiredStopReason,
} from '../../im/wecom/config/fleet-desired-state.js';
import type { WecomExternalInstance } from '../../im/wecom/config/fleet-external-instance.js';
import {
  WecomFleetUnavailableError,
  type WecomFleetConnection,
} from '../../im/wecom/config/fleet-members.js';
import { WECOM_START_SETTLE_MS } from '../../im/wecom/contract/lifecycle-budgets.js';
import { describeWecomStopReason } from '../../im/wecom/contract/stop-reason.js';
import type { FleetMemberCommandOp } from '../../core/fleet-command-queue.js';
import type { FleetProcessAttestation } from '../../core/fleet-process-identity.js';
import type { FleetMemberRequestResult, FleetStatusRow } from '../../core/fleet-runtime.js';

export type WecomLifecycleOp = 'start' | 'stop' | 'restart';

export const WECOM_LIFECYCLE_OPS: readonly WecomLifecycleOp[] = ['start', 'stop', 'restart'];

export function isWecomLifecycleOp(value: string | undefined): value is WecomLifecycleOp {
  return (WECOM_LIFECYCLE_OPS as readonly (string | undefined)[]).includes(value);
}

/** A connection named on the command line: by id, by configuration file, or
 *  by the fleet member name `botmux status` shows (`wecom-<12 hex>`). */
export type WecomLifecycleTarget =
  | { kind: 'id'; configId: string }
  | { kind: 'file'; file: string }
  | { kind: 'member'; name: string };

export interface WecomLifecycleRequest {
  op: WecomLifecycleOp;
  target: WecomLifecycleTarget;
  json: boolean;
}

export const WECOM_LIFECYCLE_USAGE = `用法: botmux wecom start|stop|restart <configId|成员名> [--json]
      botmux wecom start|stop|restart --config <配置文件> [--json]
  start    记为「运行」并请 fleet 拉起该企业微信连接（清除网关自停时留下的原因）
  stop     记为「停止」并请 fleet 停下它；之后 botmux restart、开机自启、自动更新都不会再拉起它
  restart  停下再拉起；期望状态保持「运行」
configId 是配置文件绝对路径的 sha256（64 位十六进制，Dashboard 的连接 id）；
成员名是 botmux status 里的 wecom-<12 位>；也可以用 --config 指定登记过的配置文件。--json 输出一行 JSON。`;

const CONFIG_ID = /^[0-9a-f]{64}$/;

export type WecomLifecycleParse =
  | { ok: true; request: WecomLifecycleRequest }
  | { ok: false; help: boolean; json: boolean; message: string };

/** Parse `<op> <configId>|<member name>|--config <file> [--json]` (argv after `wecom`). */
export function parseWecomLifecycleArgs(args: readonly string[], cwd: string = process.cwd()): WecomLifecycleParse {
  const [op, ...rest] = args;
  const json = rest.includes('--json');
  if (!isWecomLifecycleOp(op)) {
    return { ok: false, help: false, json, message: WECOM_LIFECYCLE_USAGE };
  }
  if (rest.some(arg => arg === '--help' || arg === '-h')) {
    return { ok: false, help: true, json, message: WECOM_LIFECYCLE_USAGE };
  }
  const operands = rest.filter(arg => arg !== '--json');
  let target: WecomLifecycleTarget | undefined;
  if (operands.length === 1 && CONFIG_ID.test(operands[0])) {
    target = { kind: 'id', configId: operands[0] };
  } else if (operands.length === 1 && isWecomFleetMemberName(operands[0])) {
    target = { kind: 'member', name: operands[0] };
  } else if (operands.length === 2 && operands[0] === '--config' && operands[1] && !operands[1].startsWith('-')) {
    target = { kind: 'file', file: resolve(cwd, operands[1]) };
  }
  if (!target) {
    return { ok: false, help: false, json, message: WECOM_LIFECYCLE_USAGE };
  }
  return { ok: true, request: { op, target, json } };
}

/** Successful outcomes. `restarted`: a running member was stopped and started again. */
export type WecomLifecycleState = 'started' | 'already-online' | 'stopped' | 'already-stopped' | 'restarted';

/**
 * Why a command did not do what was asked. Besides the supervisor's own
 * answers (FleetMemberRequestResult — `superseded`: another command recorded the
 * opposite intent after this one; `member_stopping`: the gateway kept shutting
 * itself down):
 *  - unknown_connection: not a registered WeCom connection;
 *  - configuration_missing: the registered configuration file does not exist;
 *  - external_instance: the connection's bot is already run by an instance the
 *    fleet does not run (or one whose identity cannot be verified); nothing
 *    was recorded;
 *  - registry_unavailable / desired_state_unavailable: the file cannot be read
 *    and was left as it is;
 *  - desired_state_busy: another process held the desired-state file's lock;
 *  - fleet_busy: another fleet operation held the fleet mutation lock;
 *  - supervisor_exited: the supervisor went away while the command waited;
 *  - gateway_exited: the gateway started, then exited within the first seconds;
 *  - usage: the arguments were not understood.
 */
export type WecomLifecycleFailure =
  | Extract<FleetMemberRequestResult, { ok: false }>['reason']
  | 'unknown_connection'
  | 'configuration_missing'
  | 'external_instance'
  | 'registry_unavailable'
  | 'desired_state_unavailable'
  | 'desired_state_busy'
  | 'fleet_busy'
  | 'supervisor_exited'
  | 'gateway_exited'
  | 'usage';

/**
 * The command's outcome; with `--json` it is printed as one line.
 *  - ok, configId, member, message: always present (configId / member are null
 *    only when the target could not be resolved to a registered connection);
 *  - state on success, reason on failure;
 *  - desired: the connection's recorded desired state as the command ends, read
 *    from the file at that moment (absent when it has no record or the file
 *    cannot be read);
 *  - stopReason: with desired `stopped`, the reason its gateway recorded when it
 *    stopped the connection itself;
 *  - clearedStopReason: start / restart replaced such a record.
 */
export interface WecomLifecycleResult {
  ok: boolean;
  state?: WecomLifecycleState;
  reason?: WecomLifecycleFailure;
  configId: string | null;
  member: string | null;
  message: string;
  desired?: WecomDesiredState;
  stopReason?: WecomDesiredStopReason;
  clearedStopReason?: WecomDesiredStopReason;
}

/**
 * The answer to one member op, as the lifecycle sees it. `withdrawn` (with
 * timeout / supervisor_exited): the command was taken back out of the queue
 * before any supervisor read it, so no supervisor will carry it out later.
 */
export type WecomMemberRequestOutcome =
  | Extract<FleetMemberRequestResult, { ok: true }>
  | {
    ok: false;
    reason: Extract<FleetMemberRequestResult, { ok: false }>['reason'] | 'supervisor_exited';
    message: string;
    name: string;
    withdrawn?: boolean;
  };

/** A member op handed to a live supervisor (enqueued, and the supervisor signalled). */
export interface WecomMemberTicket {
  op: FleetMemberCommandOp;
  name: string;
  id: string;
  /** The supervisor generation that was signalled. */
  supervisor: FleetProcessAttestation;
}

export type WecomMemberSubmission =
  | { ok: true; ticket: WecomMemberTicket }
  | { ok: false; outcome: Extract<WecomMemberRequestOutcome, { ok: false }> };

/** The outcome of a section run under the fleet mutation lock. */
export type WecomFleetLockOutcome<T> = { ok: true; value: T } | { ok: false };

export interface WecomLifecycleDeps {
  readDesired(): WecomDesiredStateSnapshot;
  /** Registered connections; throws WecomFleetUnavailableError when the
   *  registry or the desired-state file cannot be trusted. */
  listConnections(): WecomFleetConnection[];
  /** setWecomFleetDesiredState (a person's intent: no reason). */
  setDesired(configId: string, desired: WecomDesiredState): void;
  desiredStatePath: string;
  registryPath: string;
  /**
   * Run `section` holding the fleet mutation lock, waiting for it at most
   * `maxWaitMs`; `{ ok: false }` when it stayed taken. The command takes the
   * lock only to record intent and hand an op to the supervisor, never while
   * it waits for an answer, so a Feishu `botmux restart` / `stop` /
   * `start-bot` is never held up by a WeCom command for longer than that.
   */
  withFleetLock<T>(section: () => T, maxWaitMs: number): Promise<WecomFleetLockOutcome<T>>;
  /** Under the lock: enqueue one member op and signal the live supervisor. */
  submit(op: FleetMemberCommandOp, name: string): WecomMemberSubmission;
  /**
   * Outside the lock: wait (at most `maxWaitMs`, and at most the op's own
   * budget) for the supervisor's answer. When none can come any more — the
   * wait ran out, or the supervisor that was signalled is gone — the op is
   * taken back out of the queue if no supervisor has read it yet.
   */
  awaitOutcome(ticket: WecomMemberTicket, maxWaitMs: number): Promise<WecomMemberRequestOutcome>;
  /** An instance of this connection's bot that the fleet does not run (see fleet-external-instance.ts). */
  findExternalInstance(connection: WecomFleetConnection, connections: readonly WecomFleetConnection[]): WecomExternalInstance;
  /** SIGHUP the supervisor so it reconciles with the recorded states. */
  reconcile(): void;
  /** The member's fleet-state row, if any. */
  readMemberRow(name: string): FleetStatusRow | undefined;
  logDir: string;
  /** Seconds the supervisor is given for one op; for messages only. */
  requestTimeoutSeconds(op: FleetMemberCommandOp): number;
  /** How long a gateway may take to finish shutting itself down. */
  memberStopWaitMs: number;
  /** Upper bound of the whole command (every lock wait and every wait for an answer). */
  commandBudgetMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SETTLE_POLL_MS = 250;
const GENERATION_POLL_MS = 250;

function memberLogHint(deps: WecomLifecycleDeps, member: string): string {
  return `${join(deps.logDir, `${member}-out.log`)} / ${member}-err.log`;
}

/** Recovery advice for an unreadable desired-state file. Never repaired or
 *  replaced automatically: guessing would start or stop connections. */
export function desiredStateUnavailableMessage(path: string, why: string): string {
  return `企业微信连接的期望状态文件无法读取（${why}）：${path}\n`
    + '   botmux 不会自动修复或覆盖它；在它恢复之前，fleet 不会拉起任何企业微信连接，也不会因为它停掉正在运行的连接。\n'
    + '   恢复方法：把这个文件移到别处（例如加 .bad 后缀）。之后所有企业微信连接都变成「无记录」，\n'
    + '   下一次对账会停掉正在运行的企业微信连接；再对需要运行的连接逐个执行 `botmux wecom start <configId>`。';
}

function connectionListing(connections: readonly WecomConnectionCandidate[]): string {
  if (connections.length === 0) return '   当前没有登记任何企业微信连接（先运行 `botmux setup --platform wecom`）。';
  return ['   已登记的连接：', ...connections.map(c => `     ${c.configId}  ${c.file}`)].join('\n');
}

/** The targets `botmux wecom start|stop|restart|logs` accept. */
export type WecomConnectionTarget = WecomLifecycleTarget;

/**
 * What findWecomConnection needs of a registered connection. `desired` and
 * `config` only decide which of two connections whose ids share a member name
 * holds that name; `botmux wecom logs`, which does not read the desired state,
 * goes without them.
 */
export type WecomConnectionCandidate =
  Pick<WecomFleetConnection, 'configId' | 'file' | 'memberName'>
  & Partial<Pick<WecomFleetConnection, 'desired' | 'config'>>;

/**
 * The registered connection `target` names, or the message `botmux wecom
 * start|stop|restart|logs` print when it names none.
 *
 * Two registered configurations whose ids share the 12 hex digits of a member
 * name: the name belongs to the one the fleet runs under it — as the member
 * resolution (core/fleet-wecom-members.ts) gives it out, the first, in registry
 * order, recorded as running whose file is not missing. When none is, the
 * first registered one: the order the same resolution goes by.
 */
export function findWecomConnection<C extends WecomConnectionCandidate>(
  connections: readonly C[],
  target: WecomConnectionTarget,
): { ok: true; connection: C } | { ok: false; message: string } {
  let connection: C | undefined;
  if (target.kind === 'member') {
    const named = connections.filter(candidate => candidate.memberName === target.name);
    connection = named.find(candidate => candidate.desired === 'running' && candidate.config?.presence !== 'missing')
      ?? named[0];
  } else {
    const configId = target.kind === 'id' ? target.configId : wecomConfigId(target.file);
    connection = connections.find(candidate => candidate.configId === configId);
  }
  if (connection) return { ok: true, connection };
  const what = target.kind === 'file'
    ? `配置文件 ${target.file}`
    : `连接 ${target.kind === 'id' ? target.configId : target.name}`;
  return { ok: false, message: `${what} 不是已登记的企业微信连接。\n${connectionListing(connections)}` };
}

function fleetBusyMessage(after: string): string {
  return '另一个 fleet 操作（`botmux restart`、`botmux stop`、`botmux start-bot` 等）'
    + `在等待时间内一直没有让出 fleet 变更锁；${after}`;
}

/** What the command does inside its first locked section, before any wait. */
type Opening =
  | { kind: 'done'; result: WecomLifecycleResult }
  | { kind: 'submitted'; lifecycle: ConnectionLifecycle; step: 'start' | 'stop' | 'restart'; submission: WecomMemberSubmission };

export async function runWecomLifecycle(
  request: Pick<WecomLifecycleRequest, 'op' | 'target'>,
  deps: WecomLifecycleDeps,
): Promise<WecomLifecycleResult> {
  const deadline = deps.now() + deps.commandBudgetMs;
  const remaining = () => Math.max(0, deadline - deps.now());
  const opened = await deps.withFleetLock(() => openLifecycle(request, deps, remaining), remaining());
  if (!opened.ok) {
    return {
      ok: false,
      reason: 'fleet_busy',
      configId: null,
      member: null,
      message: fleetBusyMessage('没有做任何改动，稍后重试。'),
    };
  }
  if (opened.value.kind === 'done') return opened.value.result;
  const { lifecycle, step, submission } = opened.value;
  if (step === 'start') return lifecycle.afterStartSubmitted(submission);
  if (step === 'stop') return lifecycle.afterStopSubmitted(submission);
  return lifecycle.afterRestartStopSubmitted(submission);
}

/** Under the fleet lock: resolve the connection, record intent, hand over the first op. */
function openLifecycle(
  request: Pick<WecomLifecycleRequest, 'op' | 'target'>,
  deps: WecomLifecycleDeps,
  remaining: () => number,
): Opening {
  const unresolved = (reason: WecomLifecycleFailure, message: string): Opening =>
    ({ kind: 'done', result: { ok: false, reason, configId: null, member: null, message } });

  const snapshot = deps.readDesired();
  if (snapshot.status !== 'ok') {
    return unresolved('desired_state_unavailable', desiredStateUnavailableMessage(deps.desiredStatePath, snapshot.reason));
  }
  let connections: WecomFleetConnection[];
  try {
    connections = deps.listConnections();
  } catch (err) {
    if (!(err instanceof WecomFleetUnavailableError)) throw err;
    const raced = deps.readDesired();
    if (raced.status !== 'ok') {
      return unresolved('desired_state_unavailable', desiredStateUnavailableMessage(deps.desiredStatePath, raced.reason));
    }
    return unresolved('registry_unavailable',
      `企业微信连接登记表无法读取：${deps.registryPath}（${err.message}）。没有做任何改动。`);
  }
  const found = findWecomConnection(connections, request.target);
  if (!found.ok) {
    return unresolved('unknown_connection', found.message);
  }
  const { connection } = found;
  const record = snapshot.connections.get(connection.configId);
  const lifecycle = new ConnectionLifecycle(connection, connections, record?.reason, deps, remaining);
  if (request.op === 'stop') return lifecycle.openStop();
  if (request.op === 'restart' && record?.desired === 'running') return lifecycle.openRestart();
  return lifecycle.openStart();
}

class ConnectionLifecycle {
  private readonly configId: string;
  private readonly member: string;
  /** The reason this command replaced on the record, if it did. */
  private clearedStopReason: WecomDesiredStopReason | undefined;

  constructor(
    private readonly connection: WecomFleetConnection,
    private readonly connections: readonly WecomFleetConnection[],
    /** The reason on the record before this command, if the gateway stopped itself. */
    private readonly recordedStopReason: WecomDesiredStopReason | undefined,
    private readonly deps: WecomLifecycleDeps,
    private readonly remaining: () => number,
  ) {
    this.configId = connection.configId;
    this.member = connection.memberName;
  }

  // ── results ───────────────────────────────────────────────────────────────

  /** The connection's record as it is on disk now (undefined: none, or unreadable). */
  private currentRecord(): WecomDesiredRecord | undefined {
    const snapshot = this.deps.readDesired();
    return snapshot.status === 'ok' ? snapshot.connections.get(this.configId) : undefined;
  }

  /** Every result carries the desired state as the file has it when the command ends. */
  private result(fields: Omit<WecomLifecycleResult, 'configId' | 'member' | 'desired' | 'stopReason'>): WecomLifecycleResult {
    const record = this.currentRecord();
    return {
      ...fields,
      configId: this.configId,
      member: this.member,
      ...(record ? { desired: record.desired } : {}),
      ...(record?.desired === 'stopped' && record.reason ? { stopReason: record.reason } : {}),
      ...(this.clearedStopReason ? { clearedStopReason: this.clearedStopReason } : {}),
    };
  }

  private success(state: WecomLifecycleState, message: string): WecomLifecycleResult {
    return this.result({ ok: true, state, message });
  }

  private failure(reason: WecomLifecycleFailure, message: string): WecomLifecycleResult {
    return this.result({ ok: false, reason, message });
  }

  private done(result: WecomLifecycleResult): Opening {
    return { kind: 'done', result };
  }

  /** The recorded desired state in words, for messages. */
  private recordedInWords(): string {
    const record = this.currentRecord();
    if (!record) return '无记录';
    if (record.desired === 'running') return '运行';
    return record.reason ? `停止（${describeWecomStopReason(record.reason, this.stopReasonContext())}）` : '停止';
  }

  /** The configuration's credential environment variable NAME (never its value). */
  private stopReasonContext(): { credentialEnv?: string } {
    if (this.connection.config.presence !== 'present') return {};
    try {
      const secretEnv = JSON.parse(this.connection.config.text)?.secretEnv;
      return typeof secretEnv === 'string' && secretEnv ? { credentialEnv: secretEnv } : {};
    } catch {
      return {};
    }
  }

  // ── sections under the fleet lock ─────────────────────────────────────────

  /** Record the desired state, or explain why it could not be recorded. */
  private record(desired: WecomDesiredState): WecomLifecycleResult | undefined {
    try {
      this.deps.setDesired(this.configId, desired);
      return undefined;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'WECOM_FLEET_DESIRED_STATE_UNAVAILABLE') {
        const why = (err as { reason?: string }).reason ?? String(err);
        return this.failure('desired_state_unavailable', desiredStateUnavailableMessage(this.deps.desiredStatePath, why));
      }
      if (code === 'FILE_LOCK_TIMEOUT') {
        return this.failure('desired_state_busy',
          `期望状态文件 ${this.deps.desiredStatePath} 正被另一个进程写入，没有做任何改动；稍后重试。`);
      }
      throw err;
    }
  }

  private missingConfiguration(): WecomLifecycleResult | undefined {
    if (this.connection.config.presence !== 'missing') return undefined;
    return this.failure('configuration_missing', `企业微信连接 ${this.member} 的配置文件不存在：${this.connection.file}。没有做任何改动。`);
  }

  /** Refuse to start a connection whose bot an instance outside the fleet already runs. */
  private externalInstance(): WecomLifecycleResult | undefined {
    const found = this.deps.findExternalInstance(this.connection, this.connections);
    if (found.kind === 'none') return undefined;
    const pid = found.pid !== undefined ? `（pid ${found.pid}）` : '';
    const unchanged = '没有做任何改动。';
    if (found.kind === 'unverifiable') {
      return this.failure('external_instance',
        `企业微信连接 ${this.member} 的机器人可能已有一个不归 fleet 管理的实例${pid}，但无法核验它的进程身份；`
        + `为避免两个实例互相顶替，${unchanged}确认它已不在运行（\`botmux status\`、Dashboard）后再试。`);
    }
    const messages: Record<typeof found.source, string> = {
      legacy_gateway: `旧版 Dashboard 拉起的网关仍在运行这个连接；执行 \`botmux restart\` 完成迁移，之后由 fleet 管理。${unchanged}`,
      same_bot: `同一个机器人已由另一份配置${found.configId ? ` ${found.configId}` : ''}运行${pid}；`
        + `请先停掉那一份（\`botmux wecom stop <configId>\`）。${unchanged}`,
      terminal_gateway: `这个连接的网关正在 fleet 之外运行（终端或其他实例${found.pid !== undefined ? `，pid ${found.pid}` : ''}）；`
        + `请在原终端停止它，之后再执行本命令。${unchanged}`,
      instance_lock: `该机器人的实例锁被 fleet 之外的进程持有${pid}；fleet 拉起的网关只会一直等锁，最后以「实例锁被占用」停下。`
        + `请先停掉那个进程。${unchanged}`,
    };
    return this.failure('external_instance', `企业微信连接 ${this.member}：${messages[found.source]}`);
  }

  openStart(): Opening {
    const refused = this.missingConfiguration() ?? this.externalInstance() ?? this.record('running');
    if (refused) return this.done(refused);
    this.clearedStopReason = this.recordedStopReason;
    return { kind: 'submitted', lifecycle: this, step: 'start', submission: this.deps.submit('start-member', this.member) };
  }

  openStop(): Opening {
    const unrecorded = this.record('stopped');
    if (unrecorded) return this.done(unrecorded);
    return { kind: 'submitted', lifecycle: this, step: 'stop', submission: this.deps.submit('stop-member', this.member) };
  }

  openRestart(): Opening {
    const refused = this.missingConfiguration() ?? this.externalInstance();
    if (refused) return this.done(refused);
    return { kind: 'submitted', lifecycle: this, step: 'restart', submission: this.deps.submit('stop-member', this.member) };
  }

  // ── waiting, outside the lock ─────────────────────────────────────────────

  private async outcomeOf(submission: WecomMemberSubmission): Promise<WecomMemberRequestOutcome> {
    return submission.ok ? this.deps.awaitOutcome(submission.ticket, this.remaining()) : submission.outcome;
  }

  /** Run a later section under the lock, or report that the lock stayed taken. */
  private async locked<T>(section: () => T, busyAfter: string): Promise<{ ok: true; value: T } | { ok: false; result: WecomLifecycleResult }> {
    const outcome = await this.deps.withFleetLock(section, this.remaining());
    if (outcome.ok) return outcome;
    return { ok: false, result: this.failure('fleet_busy', fleetBusyMessage(busyAfter)) };
  }

  /** A failed request: the record stands; nudge the supervisor to reconcile once more. */
  private requestFailed(
    op: FleetMemberCommandOp,
    outcome: Extract<WecomMemberRequestOutcome, { ok: false }>,
    prefix = '',
  ): WecomLifecycleResult {
    const recorded = `期望状态现为「${this.recordedInWords()}」`;
    if (outcome.reason === 'fleet_down') {
      return this.failure('fleet_down', `${prefix}fleet 未在运行；${recorded}，执行 \`botmux start\` 后生效。`);
    }
    try {
      this.deps.reconcile();
    } catch {
      // The nudge is best-effort; the record already holds the intent.
    }
    const fate = outcome.withdrawn === true
      ? '这条命令已从队列撤回，不会再被执行。'
      : outcome.withdrawn === false ? 'supervisor 已取走这条命令，它可能仍会执行完。' : '';
    if (outcome.reason === 'timeout') {
      return this.failure('timeout',
        `${prefix}supervisor 没有在 ${this.deps.requestTimeoutSeconds(op)} 秒内给出 ${this.member} 的处理结果。${fate}`
        + `${recorded}。\n`
        + '   如果刚升级 botmux，先执行 `botmux restart`（升级前启动的 supervisor 不认识这条命令）。');
    }
    if (outcome.reason === 'supervisor_exited') {
      return this.failure('supervisor_exited',
        `${prefix}supervisor 在处理 ${this.member} 期间退出。${fate}${recorded}；`
        + '下一个 supervisor（`botmux start`、fleet 重启或开机自启）按它处理这个连接。');
    }
    if (outcome.reason === 'superseded') {
      return this.failure('superseded',
        `${prefix}在这条命令之后，另一条命令改了 ${this.member} 的期望状态（${recorded}），这条命令没有执行。`);
    }
    if (outcome.reason === 'member_stopping') {
      return this.failure('member_stopping',
        `${prefix}${this.member} 的网关正在自行停止，在等待时间内没有退出，没有拉起新的网关；${recorded}。`
        + `日志: ${memberLogHint(this.deps, this.member)}`);
    }
    return this.failure(outcome.reason,
      `${prefix}${this.member}：supervisor 未能完成（${outcome.reason}）${outcome.message ? `：${outcome.message}` : ''}。`
      + `${recorded}；日志: ${memberLogHint(this.deps, this.member)}`);
  }

  async afterStartSubmitted(submission: WecomMemberSubmission): Promise<WecomLifecycleResult> {
    return this.afterStartOutcome(await this.outcomeOf(submission), { prefix: '', started: 'started' });
  }

  async afterStopSubmitted(submission: WecomMemberSubmission): Promise<WecomLifecycleResult> {
    const outcome = await this.outcomeOf(submission);
    const kept = '之后 `botmux restart`、开机自启和自动更新都不会再拉起它，直到执行 `botmux wecom start`。';
    if (outcome.ok) {
      return outcome.state === 'stopped'
        ? this.success('stopped', `已停止企业微信连接 ${this.member}；${kept}`)
        : this.success('already-stopped', `企业微信连接 ${this.member} 没有在运行；已记为「停止」，${kept}`);
    }
    if (outcome.reason === 'fleet_down') {
      return this.success('already-stopped', `fleet 未在运行；已把企业微信连接 ${this.member} 记为「停止」，${kept}`);
    }
    if (outcome.reason === 'unknown_member') {
      // The connection is registered (checked above) and no longer resolves as a
      // member now that it is recorded as stopped: the supervisor does not hold
      // it, so there is nothing running to stop.
      return this.success('already-stopped', `企业微信连接 ${this.member} 没有在运行；已记为「停止」，${kept}`);
    }
    return this.requestFailed('stop-member', outcome);
  }

  /**
   * The stop half of a restart has an answer. `unknown_member` means there was
   * nothing to stop (the supervisor does not hold the member): go on and start
   * it. Then, under the lock again: a person may have recorded a stop in the
   * meantime (respected: nothing is started), or the gateway may have recorded
   * its own stop with a reason (cleared, as `start` clears it).
   */
  async afterRestartStopSubmitted(submission: WecomMemberSubmission): Promise<WecomLifecycleResult> {
    const stopped = await this.outcomeOf(submission);
    if (!stopped.ok && stopped.reason !== 'unknown_member') {
      return this.requestFailed('stop-member', stopped);
    }
    const prefix = `已停下 ${this.member}，但未能重新拉起：`;
    const reopened = await this.locked((): WecomLifecycleResult | WecomMemberSubmission => {
      const record = this.currentRecord();
      if (record?.desired === 'stopped' && !record.reason) {
        return this.failure('superseded',
          `已停下 ${this.member}；重启期间另一条命令把它记为「停止」，因此没有重新拉起。`);
      }
      if (record?.desired !== 'running') {
        const unrecorded = this.record('running');
        if (unrecorded) return unrecorded;
        if (record?.reason) this.clearedStopReason = record.reason;
      }
      return this.deps.submit('start-member', this.member);
    }, `已停下 ${this.member}，但没能把重新拉起的请求交给 supervisor；期望状态仍为「运行」，`
      + '那个操作结束后由 fleet 拉起，或执行 `botmux wecom start`。');
    if (!reopened.ok) return reopened.result;
    if ('configId' in reopened.value) return reopened.value;
    return this.afterStartOutcome(await this.outcomeOf(reopened.value), { prefix, started: 'restarted' });
  }

  /**
   * What a start-member answered. `member_stopping`: the gateway is shutting
   * itself down (replaced, say) and will exit shortly — saying "already
   * running" would be false. Wait for that generation to go, then hand the
   * supervisor a fresh start-member; the new generation is watched like any
   * other start.
   */
  private async afterStartOutcome(
    outcome: WecomMemberRequestOutcome,
    options: { prefix: string; started: Extract<WecomLifecycleState, 'started' | 'restarted'> },
  ): Promise<WecomLifecycleResult> {
    let answer = outcome;
    let freshGeneration = false;
    if (!answer.ok && answer.reason === 'member_stopping') {
      const gone = await this.waitGenerationGone(this.deps.readMemberRow(this.member)?.pid);
      if (!gone) return this.requestFailed('start-member', answer, options.prefix);
      const again = await this.locked((): WecomLifecycleResult | WecomMemberSubmission => {
        const record = this.currentRecord();
        if (record?.desired !== 'running') {
          return this.failure('superseded',
            `${this.member} 原来的网关已退出；期间期望状态被改为「${this.recordedInWords()}」，因此没有拉起新的网关。`);
        }
        return this.deps.submit('start-member', this.member);
      }, `${this.member} 原来的网关已退出，但没能把拉起请求交给 supervisor；期望状态仍为「运行」，`
        + '那个操作结束后由 fleet 拉起，或执行 `botmux wecom start`。');
      if (!again.ok) return again.result;
      if ('configId' in again.value) return again.value;
      answer = await this.outcomeOf(again.value);
      freshGeneration = true;
    }
    if (!answer.ok) return this.requestFailed('start-member', answer, options.prefix);
    if (answer.state === 'already-online' && !freshGeneration) {
      return this.success('already-online', `企业微信连接 ${this.member} 已在运行。`);
    }
    const exited = await this.settle();
    if (exited) return exited;
    return options.started === 'restarted'
      ? this.success('restarted', `已重启企业微信连接 ${this.member}。`)
      : this.success('started', `已启动企业微信连接 ${this.member}。`);
  }

  /** Wait (within the gateway's stop budget) until the generation with `pid` is no longer the member's live process. */
  private async waitGenerationGone(pid: number | undefined): Promise<boolean> {
    if (pid === undefined) return true;
    const deadline = this.deps.now() + Math.min(this.deps.memberStopWaitMs, this.remaining());
    for (;;) {
      const row = this.deps.readMemberRow(this.member);
      if (!row || row.pid !== pid || row.status !== 'online' || !row.alive) return true;
      if (this.deps.now() >= deadline) return false;
      await this.deps.sleep(GENERATION_POLL_MS);
    }
  }

  /**
   * Watch a gateway the supervisor just started for WECOM_START_SETTLE_MS. A
   * gateway that exits in that time (its row leaves `online`, its pid dies or
   * is replaced by a restart) is reported with its exit code and, when it
   * recorded one, the reason it stopped itself.
   */
  private async settle(): Promise<WecomLifecycleResult | undefined> {
    const first = this.deps.readMemberRow(this.member);
    const pid = first?.pid;
    const deadline = this.deps.now() + WECOM_START_SETTLE_MS;
    let row = first;
    while (row && row.status === 'online' && row.alive && row.pid === pid) {
      if (this.deps.now() >= deadline) return undefined;
      await this.deps.sleep(SETTLE_POLL_MS);
      row = this.deps.readMemberRow(this.member);
    }
    const record = this.currentRecord();
    const stopReason = record?.desired === 'stopped' ? record.reason : undefined;
    const exitCode = row?.lastExitCode ?? null;
    const why = stopReason ? `：${describeWecomStopReason(stopReason, this.stopReasonContext())}` : '';
    // A missing credential variable's description already says what to do.
    const retry = stopReason === 'credential_env_missing'
      ? ''
      : row?.status === 'errored' || stopReason
        ? '；fleet 不会自动重试，处理后再执行 `botmux wecom start`'
        : '；fleet 会按退避继续重试';
    return this.failure('gateway_exited',
      `企业微信连接 ${this.member} 启动后随即退出（退出码 ${exitCode ?? '未知'}）${why}${retry}。`
      + `日志: ${memberLogHint(this.deps, this.member)}`);
  }
}

/** Print a result the way `start-bot` / `stop-bot` do; returns the exit code. */
export function printWecomLifecycleResult(
  result: WecomLifecycleResult,
  json: boolean,
  out: { log: (line: string) => void; error: (line: string) => void } = console,
): number {
  if (json) {
    out.log(JSON.stringify(result));
  } else if (result.ok) {
    out.log(`✅ ${result.message}`);
  } else {
    out.error(`❌ ${result.message}`);
  }
  return result.ok ? 0 : 1;
}
