/** flow 的磁盘布局（run 目录与宿主槽位文件），CLI 与 daemon 共用。 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { CONTROL_SOCKET_FILE } from './types.js';

export function flowRunsDir(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'flow-runs');
}

export function flowSlotsFile(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'flow-host-slots.json');
}

/** unix socket 路径上限（sun_path 108 字节，留余量）。 */
const UNIX_SOCKET_PATH_MAX = 100;

/**
 * 控制通道 socket 路径：默认放在 run 目录里；run 目录太深（数据目录路径长）时超过 sun_path 上限，
 * 退到 tmpdir 下按 runDir 哈希命名的短路径。runner 与 CLI 用同一函数推导，不需要额外记录。
 */
export function controlSocketPath(runDir: string): string {
  const inRun = join(runDir, CONTROL_SOCKET_FILE);
  if (Buffer.byteLength(inRun) <= UNIX_SOCKET_PATH_MAX) return inRun;
  const hash = createHash('sha256').update(runDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `botmux-flow-${hash}.sock`);
}
