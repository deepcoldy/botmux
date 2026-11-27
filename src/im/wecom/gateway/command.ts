import { loadOrCreateDashboardSecret } from '../../../dashboard/auth.js';
import { dashboardSecretPath } from '../../../core/dashboard-secret.js';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FileLockTimeoutError, withFileLock } from '../../../utils/file-lock.js';
import { WecomBridge, type WecomSessionActionResult, type WecomSessionOperation } from './bridge.js';
import { removeStaleWecomStateTemps } from './bridge/state-store.js';
import { WecomHttpCore } from './core-client.js';
import { closeResidualClause, parseCloseResidual } from '../../../core/close-residual.js';
import { startWecomGatewayControl } from './gateway-control.js';
import { fetchDaemonIpc } from '../../../core/daemon-ipc-auth.js';
import {
  EXPECTED_CORE_BOOT_HEADER,
  nativeGatewayCoreProfilePath,
  nativeGatewaySessionActionPath,
  nativeGatewaySourceIdentityPath,
  type NativeGatewayCoreProfileResponse,
  type NativeGatewaySourceIdentity,
} from '../../../core/native-gateway-contract.js';
import { createWecomCoreProfileSync, WECOM_CORE_PROFILE_PUSH_TIMEOUT_MS } from './core-profile-sync.js';
import { WecomTransport, type WecomTransportOptions } from '../protocol/transport.js';
import type { WecomTerminalReason } from '../protocol/transport.js';

import { defaultWecomConfigFile, registerWecomConfig, wecomConfigId } from '../config/discovery.js';
import { createWecomRuntimePublisher } from '../config/runtime.js';
import { botmuxVersion } from '../../../utils/install-info.js';
import {
  WECOM_GATEWAY_DRAIN_BUDGET_MS,
  WECOM_GATEWAY_SHUTDOWN_MAX_MS,
  WECOM_GATEWAY_SUPERVISED_LOCK_WAIT_MS,
} from '../config/gateway-budgets.js';
import { wecomCoreLogBaseName, WECOM_GATEWAY_NO_RESTART_EXIT_CODE } from '../contract/fleet-member.js';
import {
  startWecomManagedCore,
  WecomManagedCoreSettingsError,
  type WecomManagedCoreHandle,
  type WecomManagedCoreOptions,
} from './managed-core.js';
import { wecomCoreGenerationFile } from './core-generation.js';
import {
  isWecomGatewayNotRetryable,
  takeWecomFleetMemberMarker,
  wecomGatewayExitCode,
  type WecomGatewayExitReason,
  type WecomGatewayNotRetryableReason,
} from './exit-status.js';
import { WecomGatewayDesiredStop } from './desired-stop.js';
import { installWecomGatewayFatalGuard } from './fatal-guard.js';
import { describeWecomStopReason } from '../contract/stop-reason.js';
import {
  parseWecomConfig,
  loadWecomSecret,
  WecomCredentialEnvMissingError,
  type WecomConfig,
} from '../config/config.js';
export { parseWecomConfig } from '../config/config.js';

export const WECOM_HELP = `用法: botmux wecom start|stop|restart <configId|成员名> [--json]（也可用 --config <JSON文件> 代替 configId）
      botmux wecom logs <configId|成员名> [--core] [--lines N] [--no-follow]
      botmux wecom identify [--config <文件>] [--output <新文件>]
start|stop|restart 交给 fleet：start 记为运行并拉起，stop 记为停止并停下（之后 botmux restart、开机自启不再拉起），restart 停下再拉起。
日志：网关日志并持续跟随；--core 看它的专用 core，--no-follow 只打印已有内容。
身份验证：identify 只验证私聊验证码，结果写私有文件，不改白名单。
添加机器人：在交互终端运行 botmux setup（已有机器人时先选「添加新机器人」），在「飞书应用来源」末尾的「企业微信」分区选「扫码创建新机器人」或「手动输入 BotID/Secret」，或在 Dashboard 的「添加机器人」里添加；完成后由 fleet 运行。
botmux wecom [--config <JSON文件>] 在前台运行一个网关，fleet 为每个连接执行的就是它：默认读取 ~/.botmux/wecom/config.json，并自动启动配置的专用本机 core。
旧 secretEnv / 外部 coreUrl 配置仍兼容；外部 core 需单独启动。
Secret 可从0600本地凭据文件读取，无需每次 export。一个 BotID 仅允许运行一个实例。
私聊、群内 @ 的文字对话按会话和真实 userid 隔离；群内回复公开。
网关控制命令: /status、/stop、/restart（下一条消息创建新会话）。
当前仅支持文字；图片/文件输入、话题及飞书专属能力尚未接入。
完整配置与启动方式: docs/wecom.md`;

/**
 * Run one Dashboard host-control operation (the gateway's `coreAction`) against
 * the dedicated core.
 *
 * Close and archive both use the core close route, which can close the row
 * LOCALLY yet leave a remote session, or a local subtree it cannot prove gone,
 * still running (`outcome: 'closed_with_residual'`). That is not a clean close:
 * log the residual and report `ok: false`, the same shape as a rejected request,
 * so controlSession records the intent as uncertain and the Dashboard receives a
 * non-success result instead of "completed".
 *
 * Restart, resume and suspend report `sessionGone` for exactly one answer: HTTP
 * 404 whose JSON body says `error: 'session_not_active'` — what those core
 * routes answer for a session that is no longer in the active registry
 * (closed). That refusal is definite: nothing happened. Every other failure
 * (another status, another or unreadable body, a timeout, no connection) stays
 * a plain `ok: false`, whose outcome controlSession treats as unknown.
 */
export async function requestWecomCoreSessionAction(input: {
  corePort: number;
  sessionId: string;
  operation: WecomSessionOperation;
  expectedCoreBootId?: string;
  /**
   * The key the request is signed with: the managed core's credential
   * (managed-core.ts). Omitted only by tests that inject `request`.
   */
  secret?: string;
  /** Injectable for tests; production uses the daemon-IPC authenticated fetch. */
  request?: typeof fetchDaemonIpc;
}): Promise<WecomSessionActionResult> {
  const { corePort, sessionId, operation, expectedCoreBootId, secret } = input;
  const fetchCore = input.request ?? fetchDaemonIpc;
  const request = (port: number, path: string, init: RequestInit) => fetchCore(port, path, init, secret);
  if (operation === 'interrupt') {
    throw new Error('exact_turn_required');
  }
  const init: RequestInit = {
    method: 'POST',
    body: '{}',
    headers: {
      'content-type': 'application/json',
      ...(expectedCoreBootId ? { [EXPECTED_CORE_BOOT_HEADER]: expectedCoreBootId } : {}),
    },
    signal: AbortSignal.timeout(25_000),
  };
  if (operation === 'close' || operation === 'archive') {
    const response = await request(corePort, nativeGatewaySessionActionPath(sessionId, 'close'), init);
    if (!response.ok) {
      return { ok: false };
    }
    const body = await response.json() as { ok?: boolean };
    const residual = parseCloseResidual(body);
    if (residual) {
      console.error(`[wecom] 会话 ${sessionId} 已在 core 本地关闭，但${closeResidualClause(residual)}`);
      return { ok: false };
    }
    return { ok: body.ok === true };
  }
  const paths = { delete: 'prune', restart: 'restart', resume: 'wake', suspend: 'suspend' } as const;
  const response = await request(corePort, nativeGatewaySessionActionPath(sessionId, paths[operation]), init);
  if (!response.ok) {
    return operation !== 'delete' && await sessionNotActive(response) ? { ok: false, sessionGone: true } : { ok: false };
  }
  const result = await response.json() as { ok?: boolean };
  return { ok: result.ok === true };
}

/** The core's answer is exactly 404 with a JSON body naming `session_not_active`; false for anything else. */
async function sessionNotActive(response: Response): Promise<boolean> {
  if (response.status !== 404) {
    return false;
  }
  try {
    const body: unknown = JSON.parse(await response.text());
    return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'session_not_active';
  } catch {
    return false;
  }
}

/** Test seams for {@link runWecomCommand}; production passes none. */
export interface WecomCommandDeps {
  socketFactory?: WecomTransportOptions['socketFactory'];
  coreSpawn?: WecomManagedCoreOptions['spawn'];
  supervisedLockWaitMs?: number;
  /** Shutdown drain bound; production uses WECOM_GATEWAY_DRAIN_BUDGET_MS. */
  drainBudgetMs?: number;
  fatalExit?: (code: number) => void;
}

/** Same redaction as every other gateway failure line: never echo values that may be credentials. */
function startFailureLine(error: unknown): string {
  const safe = error instanceof Error && !/secret|token|https?:/i.test(error.message);
  return `[wecom] 启动或运行失败: ${safe ? error.message : '请检查配置、凭据和连接'}`;
}

/** Resolves once `work` settles or `deadline` (epoch ms) passes, whichever is first; never rejects. */
async function settleBefore(work: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>(done => {
      timer = setTimeout(done, Math.max(0, deadline - Date.now()));
    }),
  ]);
  clearTimeout(timer);
}

/**
 * The gateway process. Exit codes: see exit-status.ts. Run as a fleet member
 * (WECOM_FLEET_MEMBER_ENV set) it also waits longer for the bot's instance
 * lock, so a previous generation still shutting down does not count as a
 * foreign instance, and it keeps its connection's desired state in step with
 * how it ends (desired-stop.ts).
 */
export async function runWecomCommand(args: string[], deps: WecomCommandDeps = {}): Promise<number> {
  const supervised = takeWecomFleetMemberMarker(process.env);
  // Supervised only, and known once the configuration path is resolved; a usage error never needs it.
  let desiredStop: WecomGatewayDesiredStop | undefined;
  /** A reason retrying cannot fix is known: record it now, not after the core stopped (desired-stop.ts). */
  const settleOn = (reason: WecomGatewayNotRetryableReason) => {
    desiredStop?.record(reason);
  };
  const exitCode = (reason: WecomGatewayExitReason) => {
    if (supervised && isWecomGatewayNotRetryable(reason) && desiredStop) {
      settleOn(reason);
      if (desiredStop.restartRequested()) {
        console.error('[wecom] 关停期间此连接被重新记为「运行」，交给 fleet 按新的意图重启');
        return wecomGatewayExitCode('failed', supervised);
      }
    }
    const code = wecomGatewayExitCode(reason, supervised);
    if (code === WECOM_GATEWAY_NO_RESTART_EXIT_CODE) {
      console.error('[wecom] 重试无法解决该错误，fleet 不会自动重启此连接；处理后请手动启动');
    }
    return code;
  };
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(WECOM_HELP);
    return 0;
  }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--config')) {
    console.error(WECOM_HELP);
    return exitCode('usage');
  }
  // Set inside the instance lock once a core may exist; a fatal error before that has nothing to stop.
  let stopCoreOnFatal: (() => Promise<void>) | undefined;
  let lockAcquired = false;
  const lockWaitMs = supervised
    ? deps.supervisedLockWaitMs ?? WECOM_GATEWAY_SUPERVISED_LOCK_WAIT_MS
    : 100;
  const removeFatalGuard = installWecomGatewayFatalGuard({
    stopCore: async () => {
      await stopCoreOnFatal?.();
    },
    deadlineMs: WECOM_GATEWAY_SHUTDOWN_MAX_MS,
    // A fatal error while shutting down for a reason retrying cannot fix keeps that reason's exit.
    exitCode: () => desiredStop?.reason ? exitCode(desiredStop.reason) : 1,
    exit: deps.fatalExit,
  });
  /** A supervised connection recorded as stopped: leave the record exactly as it is, it is the reason. */
  const recordedStopExit = (stopped: { reason?: string }) => {
    const why = stopped.reason ? `（${stopped.reason}）` : '';
    console.error(`[wecom] 此连接的期望状态为已停止${why}，不连接、不启动 core；需要时请显式启动`);
    return WECOM_GATEWAY_NO_RESTART_EXIT_CODE;
  };
  try {
    const configFile = args.length ? resolve(args[1]) : defaultWecomConfigFile();
    const configId = wecomConfigId(configFile);
    if (supervised) {
      desiredStop = new WecomGatewayDesiredStop(configId);
      const stopped = desiredStop.check();
      if (stopped) {
        return recordedStopExit(stopped);
      }
    }
    if (!existsSync(configFile)) {
      console.error('未找到企业微信配置。请先运行 botmux setup，在「飞书应用来源」的「企业微信」分区里添加机器人，或在 Dashboard 的「添加机器人」里添加。');
      return exitCode('not_configured');
    }
    let config: WecomConfig;
    try {
      config = parseWecomConfig(JSON.parse(readFileSync(configFile, 'utf8')));
    } catch (error) {
      console.error(startFailureLine(error));
      return exitCode('invalid_configuration');
    }
    let secret: string;
    try {
      secret = loadWecomSecret(config);
    } catch (error) {
      if (error instanceof WecomCredentialEnvMissingError && supervised) {
        // The variable's name, never a value (a name like WECOM_SECRET would trip
        // startFailureLine's redaction). A terminal run keeps its historical line.
        console.error(`[wecom] 启动失败: ${describeWecomStopReason('credential_env_missing', { credentialEnv: error.variable })}`);
      } else {
        console.error(startFailureLine(error));
      }
      return exitCode(error instanceof WecomCredentialEnvMissingError ? 'credential_env_missing' : 'invalid_configuration');
    }
    // The gateway is the only consumer. Never pass this credential to a core/CLI child.
    if (config.secretEnv) {
      delete process.env[config.secretEnv];
    }
    try {
      await registerWecomConfig(configFile);
    } catch {
      console.error('[wecom] 配置可运行，但Dashboard配置索引更新失败');
    }
    const identity = createHash('sha256').update(config.botId).digest('hex');
    const botRoot = join(homedir(), '.botmux', 'wecom', identity);
    mkdirSync(botRoot, { recursive: true, mode: 0o700 });
    let terminalFailure = false;
    let terminalReason: WecomTerminalReason | undefined;
    // Recorded as stopped while this run waited for the lock (desired-stop.ts).
    let stoppedWhileWaiting: { reason?: string } | undefined;
    await withFileLock(join(botRoot, 'instance'), async () => {
      lockAcquired = true;
      stoppedWhileWaiting = desiredStop?.check();
      if (stoppedWhileWaiting) {
        return;
      }
      const stateFile = join(config.stateDir ? resolve(config.stateDir) : botRoot, 'state.json');
      // Holding the instance lock, before the bridge reads or writes state.json:
      // no writer of this file is alive to own an intermediate left next to it.
      removeStaleWecomStateTemps(stateFile);
      let stopService = () => {};
      const transport: WecomTransport = new WecomTransport({
        botId: config.botId,
        secret,
        ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
        onCardEvent: event => bridge.receiveCardEvent(event),
        // A poisoned bridge retries nothing; its one line was logged when the state write failed.
        onError: () => {
          if (!bridge.poisoned) {
            console.error('[wecom] 连接或投递失败，等待重试');
          }
        },
        onConnectionState: connection => runtime.update({ connection }),
        onInboundEvent: event => runtime.inbound(event),
        onTerminalDisconnect: reason => {
          terminalFailure = true;
          terminalReason = reason;
          const messages = {
            replaced: '连接已被其他实例替换',
            authentication_failed: '企业微信认证被拒绝，请核对配置中的 BotID/Secret',
            reconnect_exhausted: '重连次数已耗尽，请检查网络后重新启动',
          };
          console.error(`[wecom] ${messages[reason]}`);
          // Stop first, then record: the core starts stopping at once, and the
          // record — which can wait seconds for its file's lock — overlaps with
          // that instead of holding it up (config/gateway-budgets.ts). The record
          // is still written before the drain, the wait for the core and the
          // instance lock's release: the shutdown goes on only after this
          // callback returns.
          stopService();
          if (reason === 'replaced' || reason === 'authentication_failed') {
            settleOn(reason);
          }
        },
      });
      let controlCoreBoot: string | undefined;
      const corePort = Number(new URL(config.coreUrl).port);
      // The managed core trusts this gateway by the credential of its start
      // (managed-core.ts), not by the machine's Dashboard secret; without a
      // running core there is nothing to sign for.
      const coreCredential = () => {
        if (!managed) {
          throw new Error('wecom_core_not_started');
        }
        return managed.credential;
      };
      const coreRequest = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        const headers = new Headers(init?.headers);
        if (controlCoreBoot) {
          headers.set(EXPECTED_CORE_BOOT_HEADER, controlCoreBoot);
        }
        return fetchDaemonIpc(corePort, url.pathname + url.search, { ...init, headers }, coreCredential());
      }) as typeof fetch;
      // A managed core takes every change of its settings without a restart:
      // a light timer of its own (not behind bridge.tick(), which can wait on
      // long result deliveries) and every new turn keep it up to date. The
      // settings the gateway itself acts on for the core (model, CLI, working
      // directory, passthrough commands) are the ones the core runs, never
      // ones it has not taken yet.
      const profileSync = createWecomCoreProfileSync({
        configFile,
        started: config,
        push: async profile => {
          const response = await coreRequest(`${config.coreUrl}${nativeGatewayCoreProfilePath()}`, {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ env: profile }),
            signal: AbortSignal.timeout(WECOM_CORE_PROFILE_PUSH_TIMEOUT_MS),
          });
          const body = response.ok ? await response.json() as Partial<NativeGatewayCoreProfileResponse> : undefined;
          if (body?.ok !== true) {
            throw new Error(`core_profile_rejected_${response.status}`);
          }
        },
        report: coreProfile => runtime.update({ coreProfile }),
        log: line => console.error(line),
      });
      const bridge: WecomBridge = new WecomBridge({
        botId: config.botId,
        connectionId: wecomConfigId(configFile),
        allowedUsers: config.allowedUsers,
        policy: () => {
          const latest = parseWecomConfig(JSON.parse(readFileSync(configFile, 'utf8')));
          if (latest.botId !== config.botId
            || latest.coreUrl !== config.coreUrl
            || latest.managedCore?.botId !== config.managedCore?.botId
            || latest.managedCore?.stateDir !== config.managedCore?.stateDir) {
            throw new Error('wecom_configuration_changed');
          }
          // What the core runs (the start configuration for an external core).
          const core = profileSync?.effective() ?? config.managedCore;
          return {
            ...latest.message,
            ...latest.native,
            commandTriggers: latest.commandTriggers,
            sessionMode: latest.sessionMode,
            sessionModeEpoch: latest.sessionModeEpoch,
            model: core?.model,
            cli: core?.cli,
            allowedUsers: latest.allowedUsers,
            blockedUsers: latest.blockedUsers,
            role: latest.role,
            // Gateway-side only (the prompt prefix, outbound address
            // sanitizing): the file's value applies at once.
            senderTag: latest.managedCore?.botConfig?.senderTag as boolean | undefined,
            hideLocalAddresses: latest.managedCore?.botConfig?.hideLocalAddresses as boolean | undefined,
            // The core checks both: a repository picked outside its root, or a
            // command it does not pass through, would be refused there.
            workingDirectory: core?.workingDirectory,
            customPassthroughCommands: core?.botConfig?.customPassthroughCommands as string[] | undefined,
          };
        },
        onAdmission: event => {
          runtime.admission(event);
          if (event.outcome === 'denied') {
            console.error('[wecom] 已收到消息，但发送者不在授权名单（未接纳任务）');
          }
        },
        // For the Dashboard, best effort: the record retries it on every refresh.
        onStateWriteFailure: failure => runtime.stateWriteFailure(failure),
        ...(config.managedCore
          ? {
            coreIdentity: createHash('sha256')
              .update(JSON.stringify([resolve(config.managedCore.stateDir), config.managedCore.botId]))
              .digest('hex'),
          }
          : {}),
        stateFile,
        transport,
        core: new WecomHttpCore(
          config.coreUrl,
          config.managedCore ? coreRequest : fetch,
          // A message sent right after a save already runs on the new settings;
          // a sync that fails still lets the turn go out, on the settings the core has.
          profileSync ? { beforeTrigger: () => profileSync.sync() } : {},
        ),
      });
      const runtime = createWecomRuntimePublisher(config.botId, configFile, { botmuxVersion: botmuxVersion() });
      let stopping = false;
      const coreAbort = new AbortController();
      let coreStarting: Promise<WecomManagedCoreHandle> | undefined;
      let managed: WecomManagedCoreHandle | undefined;
      let control: Awaited<ReturnType<typeof startWecomGatewayControl>> | undefined;
      let release!: () => void;
      const stopped = new Promise<void>(resolveStop => {
        release = resolveStop;
      });
      const stop = () => {
        if (stopping) {
          return;
        }
        stopping = true;
        profileSync?.stop();
        try {
          runtime.update({ phase: 'stopping' });
        } catch {
          /* connection evidence expires */
        }
        bridge.halt();
        // Cancels a core still starting, and starts stopping a running one: the
        // shutdown below drains while the core stops, then waits for it.
        coreAbort.abort();
        void transport.stop();
        release();
      };
      stopService = stop;
      stopCoreOnFatal = async () => {
        terminalFailure = true;
        stop();
        // An aborted start stops its own child before it settles.
        await coreStarting?.catch(() => undefined);
        await managed?.stop();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let running: Promise<void> = Promise.resolve();
      const tick = () => {
        desiredStop?.refresh();
        running = bridge.tick()
          .catch(() => {
            if (!bridge.poisoned) {
              console.error('[wecom] core 或结果投递暂不可用，将保留任务并重试');
            }
          })
          .finally(() => {
            if (!stopping) {
              timer = setTimeout(tick, 2000);
            }
          });
      };
      try {
        if (config.managedCore) {
          // Not for this gateway's own requests to the core (those carry the
          // core's credential): the control server below verifies the
          // Dashboard's requests with this secret, and so does the core for the
          // Dashboard's direct reads; both refuse everything without one.
          loadOrCreateDashboardSecret(dashboardSecretPath());
          // The fleet log directory, next to this gateway's own logs (`botmux wecom logs --core`).
          const logBase = join(homedir(), '.botmux', 'logs', wecomCoreLogBaseName(configId));
          coreStarting = startWecomManagedCore(config, {
            signal: coreAbort.signal,
            onExit: () => {
              terminalFailure = true;
              stop();
            },
            generation: { file: wecomCoreGenerationFile(botRoot, configId), configId },
            logFiles: { out: `${logBase}-out.log`, err: `${logBase}-err.log` },
            ...(deps.coreSpawn ? { spawn: deps.coreSpawn } : {}),
          });
          managed = await coreStarting.catch((error: unknown) => {
            if (error instanceof WecomManagedCoreSettingsError) {
              settleOn('invalid_configuration');
            }
            throw error;
          });
        }
        if (stopping) {
          return;
        }
        profileSync?.start();
        if (config.managedCore && runtime.instanceId) {
          const coreIdentity = createHash('sha256')
            .update(JSON.stringify([resolve(config.managedCore.stateDir), config.managedCore.botId]))
            .digest('hex');
          control = await startWecomGatewayControl({
            bridge,
            instanceId: runtime.instanceId,
            coreIdentity,
            verifyCoreBoot: async boot => {
              const response = await fetchDaemonIpc(corePort, nativeGatewaySourceIdentityPath(), {
                signal: AbortSignal.timeout(2000),
              }, coreCredential());
              if (!response.ok) {
                return false;
              }
              const proof = await response.json() as Partial<NativeGatewaySourceIdentity>;
              if (!proof.coreOnly
                || proof.coreBotId !== config.managedCore!.botId
                || proof.bootInstanceId !== boot
                || (controlCoreBoot && controlCoreBoot !== boot)) {
                return false;
              }
              controlCoreBoot = boot;
              return true;
            },
            coreAction: (sessionId, operation, expectedCoreBootId) => requestWecomCoreSessionAction({
              corePort,
              sessionId,
              operation,
              expectedCoreBootId,
              secret: coreCredential(),
            }),
          });
          try {
            runtime.update({ control: { port: control.port, instanceId: runtime.instanceId } });
          } catch {
            // Kept in the record: the next periodic rewrite publishes it.
            console.error('[wecom] 控制端口已启动，但Dashboard状态证据暂不可写');
          }
        }
        await transport.start(message => bridge.receive(message));
        try {
          runtime.update({ phase: 'running' });
        } catch {
          console.error('[wecom] 连接已建立，但Dashboard状态证据暂不可写');
        }
        console.log('[wecom] 已连接。当前支持文字对话；群聊回复对群成员公开。');
        if (!stopping) {
          tick();
        }
        await stopped;
      } catch (error) {
        if (!stopping) {
          throw error;
        }
      } finally {
        stopping = true;
        profileSync?.stop();
        bridge.halt();
        clearTimeout(timer);
        // The core is already stopping: stop() aborted its start signal. Drain the
        // dispatch tick, a settings sync and the control server meanwhile, then
        // wait for the core below. Bounded, so a hung dispatch or session action
        // cannot hold the gateway past its shutdown budget (config/gateway-budgets.ts).
        const drainDeadline = Date.now() + (deps.drainBudgetMs ?? WECOM_GATEWAY_DRAIN_BUDGET_MS);
        await settleBefore(running, drainDeadline);
        if (profileSync) {
          await settleBefore(profileSync.idle(), drainDeadline);
        }
        if (control) {
          await settleBefore(control.stop(), drainDeadline);
          control.terminate();
        }
        try {
          await transport.stop();
        } finally {
          try {
            await managed?.stop();
          } finally {
            runtime.stop();
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
          }
        }
      }
    }, { maxWaitMs: lockWaitMs });
    if (stoppedWhileWaiting) {
      return recordedStopExit(stoppedWhileWaiting);
    }
    if (terminalReason === 'replaced' || terminalReason === 'authentication_failed') {
      return exitCode(terminalReason);
    }
    return exitCode(terminalFailure ? 'failed' : 'stopped');
  } catch (error) {
    if (supervised && !lockAcquired && error instanceof FileLockTimeoutError) {
      const holder = error.holderPid ? `pid ${error.holderPid}` : '未知进程';
      console.error(`[wecom] 同一 BotID 的实例锁在 ${Math.round(lockWaitMs / 1000)} 秒内一直被${holder}占用（不是本连接的上一代网关）`);
      return exitCode('instance_busy');
    }
    // Never print raw network errors or config values (may contain credentials).
    console.error(startFailureLine(error));
    return exitCode(error instanceof WecomManagedCoreSettingsError ? 'invalid_configuration' : 'failed');
  } finally {
    removeFatalGuard();
  }
}
