/** Host-only `botmux device ...` command surface. */
import { hostname } from 'node:os';
import { readPlatformBinding, type PlatformBinding } from './binding.js';
import {
  isManagedAgentHostCommandContext,
} from './host-command-context.js';
import {
  deviceCredentialIsolationSupported,
  ensureDeviceCredentialIsolationMarker,
} from './device-isolation.js';
import {
  activateDeviceCredentialIsolation,
  DeviceIsolationDaemonActivationError,
} from './device-isolation-activation-client.js';
import {
  DeviceCredentialError,
  readDeviceCredentials,
  readDevicePublicStatus,
  type DeviceCredentialPathOptions,
  type DevicePublicStatus,
} from './device.js';
import {
  clearStoredDeviceCredentials,
  DeviceEnrollmentClient,
  DeviceProtocolError,
  enrollStoredDeviceCredentials,
  type DeviceEnrollmentApi,
} from './device-enroll.js';
export type { DeviceEnrollmentApi } from './device-enroll.js';

export interface DeviceCommandDependencies extends DeviceCredentialPathOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  startPid?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readBinding?: () => PlatformBinding | null;
  createClient?: (issuer: string) => DeviceEnrollmentApi;
  hostName?: () => string;
  isAgentContext?: () => boolean;
  now?: () => Date;
  isolationSupported?: () => boolean;
  ensureIsolationMarker?: () => { created: boolean; path: string };
  activateIsolation?: () => Promise<{ activated: boolean; daemonCount: number }>;
}

const DEVICE_USAGE = `用法:
  botmux device enroll [--name <设备名>]
  botmux device status [--json]
  botmux device logout

这些命令只能从宿主终端运行，botmux 管理的 AI CLI 会话内一律拒绝。`;

/**
 * UX guard for accidental invocation from a managed AI CLI. The mandatory OS
 * credential mask is the actual security boundary; this early check only
 * provides a clearer error. Never trust child-controlled SESSION_DATA_DIR/HOME
 * when consulting the daemon breadcrumb and PID markers.
 */
export function isManagedAgentDeviceCommandContext(
  options: Pick<DeviceCommandDependencies, 'env' | 'dataDir' | 'startPid'> = {},
): boolean {
  return isManagedAgentHostCommandContext(options);
}

function parseEnrollName(args: string[]): { ok: true; name?: string } | { ok: false } {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name') {
      const value = args[++i];
      if (!value || value.startsWith('-')) return { ok: false };
      name = value;
      continue;
    }
    if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
      if (!name) return { ok: false };
      continue;
    }
    return { ok: false };
  }
  return { ok: true, ...(name !== undefined ? { name } : {}) };
}

function validDeviceName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function formatDeviceExpiry(deviceExp: number): string {
  const date = new Date(deviceExp);
  return Number.isNaN(date.getTime()) ? String(deviceExp) : date.toISOString();
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof DeviceCredentialError
    || error instanceof DeviceProtocolError
    || error instanceof DeviceIsolationDaemonActivationError
  ) {
    return error.message;
  }
  // Do not reflect arbitrary transport/parser errors: third-party code may
  // accidentally include a bearer or response body in Error.message.
  return '设备操作失败；请检查平台连接和本地凭证文件后重试';
}

export function serializeDevicePublicStatus(status: DevicePublicStatus): string {
  return JSON.stringify(status);
}

export async function runDeviceCommand(
  args: string[],
  dependencies: DeviceCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const subcommand = (args[0] ?? 'status').toLowerCase();
  const rest = args.slice(1);

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    stdout(DEVICE_USAGE);
    return 0;
  }
  if (!['enroll', 'status', 'logout'].includes(subcommand)) {
    stderr(DEVICE_USAGE);
    return 2;
  }

  const inAgent = dependencies.isAgentContext
    ? dependencies.isAgentContext()
    : isManagedAgentDeviceCommandContext(dependencies);
  if (inAgent) {
    stderr('❌ botmux device 命令只能在宿主终端执行；AI CLI 会话不能读取或修改设备凭证。');
    return 2;
  }

  const pathOptions: DeviceCredentialPathOptions = {
    ...(dependencies.homeDir !== undefined ? { homeDir: dependencies.homeDir } : {}),
    ...(dependencies.filePath !== undefined ? { filePath: dependencies.filePath } : {}),
  };

  try {
    if (subcommand === 'status') {
      if (rest.some(arg => arg !== '--json')) {
        stderr(DEVICE_USAGE);
        return 2;
      }
      const status = readDevicePublicStatus(pathOptions);
      if (rest.includes('--json')) {
        stdout(serializeDevicePublicStatus(status));
      } else if (!status.enrolled) {
        stdout('未注册 desktop device。运行 `botmux device enroll` 开始注册。');
      } else {
        stdout('✓ Desktop device 已注册');
        stdout(`  平台: ${status.issuer}`);
        stdout(`  绝对到期: ${formatDeviceExpiry(status.deviceExp)}`);
        stdout(`  本地凭证更新时间: ${status.savedAt}`);
      }
      return 0;
    }

    if (subcommand === 'logout') {
      if (rest.length > 0) {
        stderr(DEVICE_USAGE);
        return 2;
      }
      if (readDeviceCredentials(pathOptions)) {
        (dependencies.ensureIsolationMarker ?? (() => ensureDeviceCredentialIsolationMarker({
          ...(dependencies.homeDir !== undefined ? { homeDir: dependencies.homeDir } : {}),
          ...(dependencies.now ? { now: dependencies.now } : {}),
        })))();
      }
      const removed = await clearStoredDeviceCredentials(pathOptions);
      if (removed) {
        stdout('✓ 已删除本机 desktop device 凭证。');
        stdout('  这不会替代服务端吊销；若凭证可能泄露，请同时在平台设备管理页吊销该设备。');
      } else {
        stdout('本机没有 desktop device 凭证，无需退出。');
      }
      return 0;
    }

    const parsed = parseEnrollName(rest);
    if (!parsed.ok) {
      stderr(DEVICE_USAGE);
      return 2;
    }
    const deviceName = validDeviceName(parsed.name ?? (dependencies.hostName ?? hostname)());
    if (!deviceName) {
      stderr('设备名不能为空、不能包含控制字符，且最长 80 个字符。');
      return 2;
    }
    const isolationSupported = (dependencies.isolationSupported
      ?? deviceCredentialIsolationSupported)();
    if (!isolationSupported) {
      stderr('本机无法建立 mandatory device credential isolation；Windows 本期不支持，macOS 需要 sandbox-exec，Linux 需要 bubblewrap。拒绝注册。');
      return 1;
    }
    if (readDeviceCredentials(pathOptions)) {
      stderr('本机已有 desktop device 凭证；如需换平台或重新注册，请先执行 `botmux device logout`。');
      return 1;
    }
    const binding = (dependencies.readBinding ?? readPlatformBinding)();
    if (!binding) {
      stderr('本机尚未绑定平台。请先从平台网页复制并执行 `botmux bind <凭证>`。');
      return 1;
    }

    const activation = await (dependencies.activateIsolation ?? (() =>
      activateDeviceCredentialIsolation({
        ...(dependencies.homeDir !== undefined ? { homeDir: dependencies.homeDir } : {}),
        ...(dependencies.now ? { now: dependencies.now } : {}),
      })))();
    if (activation.activated) {
      stdout(`✓ 已冻结并清退 ${activation.daemonCount} 个 daemon 的旧本地 CLI，会话后续将在凭证隔离下冷启动。`);
    }

    const client = (dependencies.createClient ?? ((issuer: string) => new DeviceEnrollmentClient(issuer)))(
      binding.platformUrl,
    );
    const stored = await enrollStoredDeviceCredentials({
      client,
      machineToken: binding.machineToken,
      deviceName,
      ...pathOptions,
      ...(dependencies.now ? { now: dependencies.now } : {}),
      onGrantReady: () => {
        stdout('已向机器 owner 发送飞书确认，请在 5 分钟内确认本次 desktop device 注册…');
      },
    });
    stdout('✓ Desktop device 注册完成，凭证已安全写入本机（0600）。');
    stdout(`  平台: ${stored.issuer}`);
    stdout(`  绝对到期: ${formatDeviceExpiry(stored.deviceExp)}`);
    return 0;
  } catch (error) {
    stderr(`❌ ${safeErrorMessage(error)}`);
    return 1;
  }
}
