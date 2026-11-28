/**
 * A supervised gateway's say over whether its connection runs again.
 *
 * Exiting with the no-restart code only parks the member in the running
 * supervisor. `botmux restart`, autostart and crash recovery start a new
 * supervisor that resolves members from the desired-state file — where the
 * connection is still `running` — and starts it again: a connection taken over
 * by another client would then kick that client off, and be kicked off in turn.
 * So the gateway records the connection as `stopped`, with the reason
 * (config/fleet-desired-state.ts), and only an explicit start runs it again.
 *
 * Three rules make that record safe against kills, crashes and people:
 *  - it is written the moment the reason is known (on a terminal disconnect,
 *    right after the core has been told to stop), before the gateway waits for
 *    its core and releases the instance lock. A gateway killed while it shuts
 *    down, or a supervisor that dies meanwhile and is replaced, cannot leave the
 *    next generation a `running` record to reconnect with;
 *  - it is written only over the record this gateway runs under — the one it
 *    read before it connected, or a later `running` one it read while connected
 *    (compare-and-set under the file's lock). A person who stopped, started or
 *    restarted the connection since keeps their record; if that record is
 *    `running`, the gateway exits with a retryable code so the supervisor
 *    carries out the newer intent. The next generation runs under that newer
 *    record, and if the failure persists it records it there: the state
 *    settles instead of restarting forever;
 *  - a supervised gateway reads the record before it waits for the instance
 *    lock and again once it holds it: a connection recorded as `stopped` exits
 *    at once with the no-restart code, without connecting, starting its core or
 *    touching the record. That settles a gateway killed between writing the
 *    record and exiting, a previous generation that recorded its stop while
 *    this one waited for the lock, and a restart the supervisor still had
 *    scheduled for a connection someone has since stopped.
 *
 * None of this runs for a gateway outside the fleet (a terminal or Dashboard
 * run): such a gateway never reads or writes the file.
 */
import {
  readWecomFleetDesiredState,
  sameWecomDesiredRecord,
  setWecomFleetDesiredStopped,
  type WecomDesiredRecord,
  type WecomDesiredStopReason,
} from '../config/fleet-desired-state.js';
import type { WecomGatewayNotRetryableReason } from './exit-status.js';

/** Test seams; production reads and writes ~/.botmux/wecom/fleet-desired.json. */
export interface WecomDesiredStopDeps {
  root?: string;
  log?: (line: string) => void;
}

/** What the record of this connection was when last read. */
type Observation =
  | { status: 'ok'; record: WecomDesiredRecord | undefined }
  /** The file could not be read: nothing to compare a write against. */
  | { status: 'unavailable' };

/**
 * One supervised gateway run's dealings with its connection's desired state:
 * {@link check} before connecting, {@link record} when a not-retryable reason
 * is known, {@link restartRequested} when choosing the exit code.
 */
export class WecomGatewayDesiredStop {
  private observed: Observation = { status: 'unavailable' };
  private recorded: WecomGatewayNotRetryableReason | undefined;
  private written: WecomDesiredRecord | undefined;
  private readonly log: (line: string) => void;

  constructor(private readonly configId: string, private readonly deps: WecomDesiredStopDeps = {}) {
    this.log = deps.log ?? (line => console.error(line));
  }

  private read(): Observation {
    const snapshot = this.deps.root === undefined ? readWecomFleetDesiredState() : readWecomFleetDesiredState(this.deps.root);
    if (snapshot.status !== 'ok') {
      return { status: 'unavailable' };
    }
    return { status: 'ok', record: snapshot.connections.get(this.configId) };
  }

  /**
   * Read the connection's record and keep it as the one this run goes by. The
   * recorded stop when it is `stopped` (`reason` absent for a stop a person
   * made); undefined when it is `running`, not recorded, or the file cannot be
   * read — the gateway then runs.
   */
  check(): { reason?: WecomDesiredStopReason } | undefined {
    this.observed = this.read();
    if (this.observed.status !== 'ok' || this.observed.record?.desired !== 'stopped') {
      return undefined;
    }
    const reason = this.observed.record.reason;
    return reason ? { reason } : {};
  }

  /**
   * While connected: a `running` record written since the last read is one this
   * gateway is already carrying out (a `botmux wecom start` of a running
   * connection, say), so it becomes the record this run goes by. Without this,
   * such a no-op start would make the next replacement look like a newer intent
   * and restart the gateway into the other client. Anything else — a stop not
   * carried out yet, an unreadable file — keeps the earlier record. Does
   * nothing once a reason was recorded.
   */
  refresh(): void {
    if (this.recorded) {
      return;
    }
    const now = this.read();
    if (now.status === 'ok' && now.record?.desired === 'running') {
      this.observed = now;
    }
  }

  /** The not-retryable reason this run recorded (or tried to), if any. */
  get reason(): WecomGatewayNotRetryableReason | undefined {
    return this.recorded;
  }

  /**
   * Record `stopped` with `reason`, only over the record {@link check} last
   * read. The first reason of a run wins; later calls do nothing. Never
   * throws: a failed write (damaged file, lock held past its 5 s wait, disk
   * error) is logged and the gateway still exits with the no-restart code — the
   * member then stays parked only until the next supervisor start.
   *
   * `reason` is typed as the gateway's not-retryable reasons; passing it where
   * a desired-state reason is expected is what keeps every such reason
   * recordable.
   */
  record(reason: WecomGatewayNotRetryableReason): void {
    if (this.recorded) {
      return;
    }
    this.recorded = reason;
    const recordable: WecomDesiredStopReason = reason;
    const observed = this.observed;
    if (observed.status !== 'ok') {
      this.log(`[wecom] 启动时没能读到此连接的期望状态，不写入「已停止（${reason}）」；fleet 下次重启时会再次启动它`);
      return;
    }
    try {
      const outcome = setWecomFleetDesiredStopped(this.configId, recordable, {
        ...(this.deps.root === undefined ? {} : { root: this.deps.root }),
        expected: { record: observed.record },
      });
      if (outcome.written) {
        this.written = outcome.record;
      } else {
        const now = outcome.current ? `已记为「${outcome.current.desired === 'running' ? '运行' : '停止'}」` : '已没有记录';
        this.log(`[wecom] 此连接的期望状态在本次启动之后被改过（${now}），保留新的记录，不写入「已停止（${reason}）」`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`[wecom] 未能把此连接记为已停止（${reason}）：${detail}；fleet 下次重启时会再次启动它`);
    }
  }

  /**
   * At exit, after {@link record}: whether a person recorded `running` after
   * this run read the record — then the supervisor should restart the gateway
   * (into that newer intent) rather than park it. False when the record is
   * still this run's own stop, the one it started under, a stop, absent, or
   * unreadable.
   */
  restartRequested(): boolean {
    const now = this.read();
    if (now.status !== 'ok' || now.record?.desired !== 'running') {
      return false;
    }
    if (this.written && sameWecomDesiredRecord(now.record, this.written)) {
      return false;
    }
    if (this.observed.status === 'ok' && sameWecomDesiredRecord(now.record, this.observed.record)) {
      return false;
    }
    return true;
  }
}
