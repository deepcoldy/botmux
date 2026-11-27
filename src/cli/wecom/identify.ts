import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, writeFileSync, fchmodSync, fsyncSync, closeSync, unlinkSync, lstatSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FileLockTimeoutError, withFileLock } from '../../utils/file-lock.js';
import type { WecomTransportOptions } from '../../im/wecom/protocol/transport.js';
import { runIdentityChallenge, type WecomIdentityTransport } from '../../im/wecom/protocol/identity-challenge.js';
import { loadWecomSecret, parseWecomConfig } from '../../im/wecom/config/config.js';
import { defaultWecomConfigFile, wecomConfigId, wecomRoot } from '../../im/wecom/config/discovery.js';
import { readWecomFleetDesiredState, wecomDesiredStateOf } from '../../im/wecom/config/fleet-desired-state.js';
import { wecomBotRoot } from '../../im/wecom/config/runtime.js';

/**
 * `botmux wecom identify`: verify which userid a person has on this bot, before
 * it is configured into an allow list. The challenge itself is shared with the
 * Dashboard's scan-to-create pairing (im/wecom/protocol/identity-challenge.ts).
 * src/cli.ts dispatches here directly: identify loads none of the gateway.
 */

export interface WecomVerifiedIdentity { userid: string; verifiedAt: string; configId: string; configDigest: string }

/**
 * The bot's instance lock is held: its gateway is running, and identify shares
 * that lock. `fleetManaged`: the connection is recorded as running under the
 * fleet, so stopping the gateway by hand would only make the supervisor start
 * it again — it has to be stopped (and later started) through the fleet.
 */
export class WecomIdentifyGatewayRunningError extends Error {
  constructor(readonly configId: string, readonly fleetManaged: boolean) {
    super('wecom_identify_gateway_running');
    this.name = 'WecomIdentifyGatewayRunningError';
  }
}

/** What to tell the person when the gateway holds the lock. Identify never
 *  stops or starts anything itself. */
export function wecomIdentifyGatewayRunningMessage(error: WecomIdentifyGatewayRunningError): string {
  if (error.fleetManaged) {
    return '[wecom identify] 这个连接正由 fleet 运行，网关占着机器人的单活锁，identify 拿不到；未修改配置或白名单。\n'
      + `  先执行 \`botmux wecom stop ${error.configId}\`，完成验证后再执行 \`botmux wecom start ${error.configId}\`。`;
  }
  return '[wecom identify] 这个机器人的网关正在运行（终端或其他进程），占着单活锁，identify 拿不到；未修改配置或白名单。\n'
    + '  先正常停止那个网关，再重新运行 identify。';
}

function recordedAsFleetRunning(configId: string): boolean {
  const snapshot = readWecomFleetDesiredState();
  return snapshot.status === 'ok' && wecomDesiredStateOf(snapshot, configId) === 'running';
}
export interface WecomIdentifyOptions {
  configFile: string;
  outputFile: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  write: (message: string) => void;
  createTransport?: (options: WecomTransportOptions) => WecomIdentityTransport;
  challenge?: () => string;
}
function requireAbsent(file: string): void {
  try {
    lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('wecom_identify_output_exists');
}
function writePrivateIdentity(file: string, identity: WecomVerifiedIdentity): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(identity)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const directory = openSync(dirname(file), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        unlinkSync(file);
      } catch { /* never overwrite a pre-existing result */ }
    }
    throw error;
  }
}
/** One authenticated, exact, single-chat challenge. No core, bridge, task, or ACL writes. */
export async function identifyWecomIdentity(options: WecomIdentifyOptions): Promise<void> {
  const file = resolve(options.configFile);
  const output = resolve(options.outputFile);
  requireAbsent(output);
  const snapshot = readFileSync(file, 'utf8');
  const config = parseWecomConfig(JSON.parse(snapshot));
  const secret = loadWecomSecret(config);
  if (config.secretEnv) delete process.env[config.secretEnv];
  const botRoot = wecomBotRoot(config.botId);
  mkdirSync(botRoot, { recursive: true, mode: 0o700 });
  const identifyUnderLock = async (): Promise<void> => {
    options.write('[wecom identify] 正在认证；不会启动 core、任务或修改配置。');
    const verified = await runIdentityChallenge({
      botId: config.botId, secret, signal: options.signal, timeoutMs: options.timeoutMs,
      createTransport: options.createTransport, challenge: options.challenge,
      onConnectionError: () => options.write('[wecom identify] 连接暂不可用，等待恢复。'),
      onChallenge: challenge => {
        options.write('请用要授权的账号直接私聊该机器人，只发送以下完整验证码；不要发到群聊：');
        options.write(challenge);
      },
    });
    if (readFileSync(file, 'utf8') !== snapshot) throw new Error('wecom_identify_configuration_changed');
    writePrivateIdentity(output, {
      ...verified,
      configId: wecomConfigId(file),
      configDigest: createHash('sha256').update(snapshot).digest('hex'),
    });
    options.write('[wecom identify] 身份已验证并保存到私有结果文件；白名单尚未修改。');
    options.write(`结果文件：${output}`);
  };
  // A running gateway holds the bot's instance lock for its whole life, so it
  // makes this fail, as it always has; only the explanation tells a connection
  // the fleet runs apart from one run elsewhere.
  let locked = false;
  try {
    await withFileLock(join(botRoot, 'instance'), async () => {
      locked = true;
      await identifyUnderLock();
    }, { maxWaitMs: 100 });
  } catch (error) {
    if (locked || !(error instanceof FileLockTimeoutError)) throw error;
    const configId = wecomConfigId(file);
    throw new WecomIdentifyGatewayRunningError(configId, recordedAsFleetRunning(configId));
  }
}
export const WECOM_IDENTIFY_HELP = `用法: botmux wecom identify [--config <文件>] [--output <新文件>]
本命令与网关共用单活锁，先停止同一机器人的网关：由 fleet 运行的连接用 botmux wecom stop <configId>，验证完再 botmux wecom start <configId>；在终端前台运行的网关在原终端正常停止。
认证后生成一次性私聊验证码，只接受完整匹配的单聊文字，2分钟超时。
不启动core、不执行任务、不修改白名单、不向企微发送消息。
结果仅写入独占0600新文件，终端不会打印userid。默认保存到 ~/.botmux/wecom/identities/。
wecom-cli whoami 的授权真人ID不保证与智能机器人callback userid同域；请以本命令验证的身份为准。`;
export async function runWecomIdentifyCommand(args: string[]): Promise<number> {
  if (args.some(value => ['--help', '-h'].includes(value))) {
    console.log(WECOM_IDENTIFY_HELP);
    return 0;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  try {
    let file = defaultWecomConfigFile();
    let output = join(wecomRoot(), 'identities', `${randomUUID()}.json`);
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index += 2) {
      if (!['--config', '--output'].includes(args[index]) || seen.has(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) {
        console.error(WECOM_IDENTIFY_HELP);
        return 2;
      }
      seen.add(args[index]);
      if (args[index] === '--config') {
        file = resolve(args[index + 1]);
      } else {
        output = resolve(args[index + 1]);
      }
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await identifyWecomIdentity({
      configFile: file,
      outputFile: output,
      signal: abort.signal,
      write: message => console.log(message),
    });
    return 0;
  } catch (error) {
    if (error instanceof WecomIdentifyGatewayRunningError) {
      console.error(wecomIdentifyGatewayRunningMessage(error));
      return 1;
    }
    const code = abort.signal.aborted
      ? 'wecom_identify_cancelled'
      : error instanceof Error && /^wecom_identify_[a-z_]+$/.test(error.message) ? error.message : 'wecom_identify_failed';
    console.error(`[wecom identify] ${code}；未修改配置或白名单。`);
    return code === 'wecom_identify_cancelled' ? 130 : 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
