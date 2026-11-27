/**
 * `botmux wecom logs <configId|成员名> [--core] [--lines N] [--no-follow]`
 * (or `--config <file>` instead of the target): the log files of one WeCom
 * connection. `botmux logs` covers the Feishu daemons and stays as it is.
 *
 * The target is resolved like `botmux wecom start|stop|restart` resolve theirs
 * (findWecomConnection: id, configuration file or member name, and the same
 * message for a connection that is not registered), but from the registry
 * alone: the desired-state file is not read, so the logs stay readable when
 * that file is the problem. The file names come from where the files are written:
 *  - the gateway's: the supervisor opens `<logDir>/<logBaseName>-{out,err}.log`
 *    (FleetBotSpec.logBaseName), and a WeCom member's logBaseName is the
 *    connection's member name (core/fleet-wecom-members.ts);
 *  - with `--core`, those the gateway opens for its dedicated core, named by
 *    wecomCoreLogBaseName (gateway/command.ts), in the same directory.
 *
 * Output as `botmux logs` gives it: `tail -n <lines>` (50 by default) over the
 * files that exist, with tail's own `==> file <==` banners, then following
 * them with `tail -F` across the supervisor's rotation and reopen;
 * `--no-follow` prints the backlog and exits. `-f` is accepted and is the
 * default.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readWecomConfigPaths, wecomConfigId, wecomRoot } from '../../im/wecom/config/discovery.js';
import { isWecomFleetMemberName } from '../../im/wecom/config/fleet-member-name.js';
import type { WecomFleetConnection } from '../../im/wecom/config/fleet-members.js';
import { wecomCoreLogBaseName, wecomFleetMemberName } from '../../im/wecom/contract/fleet-member.js';
import { findWecomConnection, type WecomConnectionTarget } from './fleet-lifecycle.js';

export const WECOM_LOGS_USAGE = `用法: botmux wecom logs <configId|成员名> [--core] [--lines N] [--no-follow]
      botmux wecom logs --config <配置文件> [--core] [--lines N] [--no-follow]
  打印该企业微信连接的网关日志（<成员名>-out.log / -err.log）最后 N 行（默认 50），之后持续跟随
  （tail -F，跨 supervisor 的日志轮转），与 botmux logs 相同
  --core       改看网关为它的专用 core 写的日志
  --lines N    先打印的行数
  --no-follow  只打印已有内容后退出（-f 也接受，等同默认）
configId 是配置文件绝对路径的 sha256（64 位十六进制）；成员名是 botmux status 里的 wecom-<12 位>。`;

const CONFIG_ID = /^[0-9a-f]{64}$/;
const DEFAULT_LINES = '50';

export interface WecomLogsRequest {
  target: WecomConnectionTarget;
  core: boolean;
  lines: string;
  follow: boolean;
}

export type WecomLogsParse =
  | { ok: true; request: WecomLogsRequest }
  | { ok: false; help: boolean; message: string };

/** Parse the arguments after `botmux wecom logs`. */
export function parseWecomLogsArgs(args: readonly string[], cwd: string = process.cwd()): WecomLogsParse {
  const usage = (help = false): WecomLogsParse => ({ ok: false, help, message: WECOM_LOGS_USAGE });
  const targets: WecomConnectionTarget[] = [];
  let core = false;
  // Like `botmux logs`: follows unless --no-follow, whatever else is given.
  let noFollow = false;
  let lines = DEFAULT_LINES;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') return usage(true);
    if (arg === '--core') {
      core = true;
    } else if (arg === '--no-follow') {
      noFollow = true;
    } else if (arg === '-f' || arg === '--follow') {
      // The default; accepted for those who type it.
    } else if (arg === '--lines') {
      const value = args[++index];
      if (value === undefined || !/^\d+$/.test(value)) return usage();
      lines = value;
    } else if (arg === '--config') {
      const file = args[++index];
      if (!file || file.startsWith('-')) return usage();
      targets.push({ kind: 'file', file: resolve(cwd, file) });
    } else if (CONFIG_ID.test(arg)) {
      targets.push({ kind: 'id', configId: arg });
    } else if (isWecomFleetMemberName(arg)) {
      targets.push({ kind: 'member', name: arg });
    } else {
      return usage();
    }
  }
  if (targets.length !== 1) return usage();
  return { ok: true, request: { target: targets[0]!, core, lines, follow: !noFollow } };
}

/** A registered connection as far as its logs go. */
export type WecomLogConnection = Pick<WecomFleetConnection, 'configId' | 'file' | 'memberName'>;

/**
 * The registered connections from the registry alone — the same paths, ids
 * and member names the fleet's list (listWecomFleetConnections) derives, without
 * reading the desired-state file it also needs. Throws when the registry
 * cannot be read.
 */
export function listRegisteredWecomConnections(root: string = wecomRoot()): WecomLogConnection[] {
  return readWecomConfigPaths(root, true).map(file => {
    const configId = wecomConfigId(file);
    return { configId, file, memberName: wecomFleetMemberName(configId) };
  });
}

/** The two log files of `connection`'s gateway, or with `core` of its dedicated core. */
export function wecomLogFiles(connection: WecomLogConnection, logDir: string, core: boolean): string[] {
  const base = core ? wecomCoreLogBaseName(connection.configId) : connection.memberName;
  return [join(logDir, `${base}-out.log`), join(logDir, `${base}-err.log`)];
}

export interface WecomLogsDeps {
  /** listRegisteredWecomConnections; throws when the registry cannot be read. */
  listConnections(): WecomLogConnection[];
  /** For the message when it cannot be read. */
  registryPath: string;
  /** The fleet log directory (core/fleet-runtime.ts fleetLogDir). */
  logDir(): Promise<string>;
  exists(path: string): boolean;
  /** Run `tail` with these arguments, its output going to ours; resolves with its exit code. */
  tail(args: string[]): Promise<number>;
  error(line: string): void;
  log(line: string): void;
}

export async function runWecomLogsCommand(args: string[], deps: WecomLogsDeps = productionWecomLogsDeps()): Promise<number> {
  const parsed = parseWecomLogsArgs(args);
  if (!parsed.ok) {
    if (parsed.help) {
      deps.log(parsed.message);
      return 0;
    }
    deps.error(parsed.message);
    return 2;
  }
  const { request } = parsed;
  let connections: WecomLogConnection[];
  try {
    connections = deps.listConnections();
  } catch (err) {
    deps.error(`❌ 企业微信连接登记表无法读取：${deps.registryPath}（${err instanceof Error ? err.message : String(err)}）。`);
    return 1;
  }
  const found = findWecomConnection(connections, request.target);
  if (!found.ok) {
    deps.error(`❌ ${found.message}`);
    return 1;
  }
  const { connection } = found;
  const candidates = wecomLogFiles(connection, await deps.logDir(), request.core);
  const files = candidates.filter(file => deps.exists(file));
  if (files.length === 0) {
    const why = request.core
      ? '这个连接可能没有专用 core，或它的 core 还没有启动过'
      : 'fleet 可能还没有启动过这个连接的网关';
    deps.error(`❌ 没有找到 ${connection.memberName} 的${request.core ? '专用 core ' : '网关'}日志（${candidates.join(' / ')}）：${why}。`);
    return 1;
  }
  const tailArgs = request.follow
    ? ['-n', request.lines, '-F', ...files]
    : ['-n', request.lines, ...files];
  return deps.tail(tailArgs);
}

export function productionWecomLogsDeps(): WecomLogsDeps {
  const root = wecomRoot();
  return {
    listConnections: () => listRegisteredWecomConnections(root),
    registryPath: join(root, 'config-registry.json'),
    logDir: async () => (await import('../../core/fleet-runtime.js')).fleetLogDir(),
    exists: existsSync,
    tail: tailArgs => new Promise<number>(done => {
      const child = spawn('tail', tailArgs, { stdio: 'inherit' });
      child.on('error', err => {
        console.error(`❌ 无法运行 tail：${err instanceof Error ? err.message : err}`);
        done(1);
      });
      child.on('exit', code => done(code ?? 0));
    }),
    error: line => console.error(line),
    log: line => console.log(line),
  };
}
