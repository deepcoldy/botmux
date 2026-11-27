/**
 * Keeps a managed core on the core settings of the gateway's configuration file
 * without restarting it.
 *
 * The core synthesizes its bot from a few environment keys
 * (config/managed-core-env.ts wecomManagedCoreProfileEnvironment) once, at
 * start. When the file's projection to those keys changes, this hands the new
 * projection to the running core (core/native-gateway-core-profile.ts), which
 * validates it as a whole and then uses it for new sessions. Sessions already
 * running keep theirs, except that a change of the CLI makes the core close the
 * sessions still on the previous one before it answers; the bridge moves the
 * next message of such a conversation to a new session (bridge/tick.ts
 * renewSession). A change to a setting only a restart applies
 * (config/restart-settings.ts) is not handed over, only reported.
 *
 * One sync reads the file, compares and, when needed, pushes. Syncs never
 * overlap: one requested while another runs runs again after it, reading the
 * file anew, so the last saved content wins. A failed push leaves the core on
 * the settings it had (it changes nothing unless it accepts all of them) and is
 * retried by the next sync; it never fails the caller. Each outcome is reported
 * with the hash of the file text it was decided on, the hash the Dashboard
 * compares with the file on disk (config/runtime.ts coreProfile).
 */
import { readFileSync } from 'node:fs';
import type { NativeGatewayCoreProfile } from '../../../core/native-gateway-contract.js';
import { parseWecomConfig, type WecomConfig } from '../config/config.js';
import { wecomFleetConfigHash } from '../config/fleet-members.js';
import { wecomManagedCoreProfileEnvironment, type WecomManagedCoreSettings } from '../config/managed-core-env.js';
import { wecomRestartOnlyChanges } from '../config/restart-settings.js';
import type { WecomCoreProfileEvaluation } from '../config/runtime.js';

/** How often a running gateway looks at its configuration file. */
export const WECOM_CORE_PROFILE_SYNC_MS = 2000;

/** Bound of one push; the core answers from memory. */
export const WECOM_CORE_PROFILE_PUSH_TIMEOUT_MS = 5000;

export interface WecomCoreProfileSyncOptions {
  configFile: string;
  /** The configuration the core was started with. */
  started: WecomConfig;
  /** Hand `profile` to the core. Resolves once the core took it, rejects otherwise. */
  push(profile: NativeGatewayCoreProfile): Promise<void>;
  /** Called with every evaluation that differs from the one before it. */
  report?(evaluation: WecomCoreProfileEvaluation): void;
  log?(line: string): void;
  /** Tests only. */
  readFile?(file: string): string;
}

/**
 * The sync of a configuration whose gateway launches its own core; undefined
 * for one that drives an external core, which keeps its settings as they are.
 */
export function createWecomCoreProfileSync(options: WecomCoreProfileSyncOptions): WecomCoreProfileSync | undefined {
  return options.started.managedCore ? new WecomCoreProfileSync(options) : undefined;
}

export class WecomCoreProfileSync {
  private applied: string;
  private effectiveCore: WecomManagedCoreSettings;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private looping = false;
  private reported: string | undefined;
  private unreadableLogged = false;

  constructor(private readonly options: WecomCoreProfileSyncOptions) {
    if (!options.started.managedCore) {
      throw new Error('wecom_external_core_configuration');
    }
    this.applied = JSON.stringify(wecomManagedCoreProfileEnvironment(options.started));
    this.effectiveCore = options.started.managedCore;
  }

  /** The managed core settings the core runs new sessions with now. */
  effective(): WecomManagedCoreSettings {
    return this.effectiveCore;
  }

  /** Bring the core up to date with the file. Never rejects. */
  sync(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
        } while (this.again && !this.stopped);
      } catch {
        /* once() handles its own failures; never fail a caller */
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /**
   * Sync now, then every WECOM_CORE_PROFILE_SYNC_MS after the previous sync
   * settled — its own timer, so a long result delivery never holds it up.
   */
  start(): void {
    const loop = () => {
      void this.sync().finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(loop, WECOM_CORE_PROFILE_SYNC_MS);
        }
      });
    };
    if (!this.stopped && !this.looping) {
      this.looping = true;
      loop();
    }
  }

  /** No sync or push starts after this; a push already sent may still complete. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Settles once no sync is running. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async once(): Promise<void> {
    let text: string;
    try {
      text = (this.options.readFile ?? (file => readFileSync(file, 'utf8')))(this.options.configFile);
      this.unreadableLogged = false;
    } catch {
      if (!this.unreadableLogged) {
        this.unreadableLogged = true;
        this.options.log?.('[wecom] 配置文件暂不可读，core 继续使用当前设置');
      }
      return;
    }
    const configHash = wecomFleetConfigHash(text);
    let latest: WecomConfig;
    let profile: NativeGatewayCoreProfile;
    try {
      latest = parseWecomConfig(JSON.parse(text));
      if (wecomRestartOnlyChanges(this.options.started, latest).length) {
        this.report({ configHash, outcome: 'restart_required' });
        return;
      }
      profile = wecomManagedCoreProfileEnvironment(latest);
    } catch {
      this.report({ configHash, outcome: 'retrying' });
      return;
    }
    const projected = JSON.stringify(profile);
    if (projected !== this.applied) {
      if (this.stopped) {
        return;
      }
      try {
        await this.options.push(profile);
      } catch {
        this.report({ configHash, outcome: 'retrying' });
        return;
      }
      this.applied = projected;
    }
    this.effectiveCore = latest.managedCore!;
    this.report({ configHash, outcome: 'applied' });
  }

  private report(evaluation: WecomCoreProfileEvaluation): void {
    const key = JSON.stringify(evaluation);
    if (key === this.reported) {
      return;
    }
    const previous = this.reported ? (JSON.parse(this.reported) as WecomCoreProfileEvaluation).outcome : undefined;
    this.reported = key;
    if (evaluation.outcome !== previous) {
      const lines = {
        applied: previous ? '[wecom] 新的 core 设置已生效，用于之后新建的会话' : undefined,
        restart_required: '[wecom] 配置中有只能重启连接才生效的改动（身份、凭据、core 端口或状态目录），重启后生效',
        retrying: '[wecom] 新的 core 设置暂未生效（配置无效或 core 未接受），core 继续使用当前设置，稍后重试',
      };
      const line = lines[evaluation.outcome];
      if (line) {
        this.options.log?.(line);
      }
    }
    try {
      this.options.report?.(evaluation);
    } catch {
      /* the record is evidence for the Dashboard; dispatch never depends on it */
    }
  }
}
