// 平台绑定状态：存在 ~/.botmux/platform.json，记录这台机器绑到了哪个平台。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface PlatformBinding {
  /** 平台对外地址，如 https://botmux.bytedance.net 或本地 http://localhost:8000 */
  platformUrl: string;
  /** 本机稳定标识（重绑保持不变） */
  machineId: string;
  /** 隧道凭证（自包含签名，平台验签） */
  machineToken: string;
  /** 机器展示名（默认机器名） */
  name?: string;
  /** 本机所属的平台团队（成员关系下沉到部署本地，平台零存储靠各机上报重组） */
  teams?: PlatformTeam[];
  /** 与平台通信固定走的 IP 协议族。bind 时默认路径不通、单协议族兜底成功后记下，
   *  之后隧道等所有平台连接默认走它；缺省表示跟随系统默认解析。 */
  ipFamily?: 4 | 6;
}

export interface PlatformTeam {
  teamId: string;
  teamName: string;
}

export const PLATFORM_BINDING_PATH = join(homedir(), '.botmux', 'platform.json');

export function readPlatformBinding(): PlatformBinding | null {
  try {
    if (!existsSync(PLATFORM_BINDING_PATH)) return null;
    const obj = JSON.parse(readFileSync(PLATFORM_BINDING_PATH, 'utf8'));
    if (obj && typeof obj.platformUrl === 'string' && typeof obj.machineToken === 'string' && typeof obj.machineId === 'string') {
      return obj as PlatformBinding;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function writePlatformBinding(b: PlatformBinding): void {
  atomicWriteFileSync(PLATFORM_BINDING_PATH, JSON.stringify(b, null, 2), { mode: 0o600 });
}

/**
 * 解绑：删除本地平台绑定文件（~/.botmux/platform.json）。
 * 平台侧 owner 点了「解绑」并吊销了 machine token 后，daemon 收到 unbound 消息时调用，
 * 把本地凭证清干净——下次 `botmux bind` 重新写入即可重新绑定。文件不存在视为已清理。
 */
export function clearPlatformBinding(): void {
  try {
    if (existsSync(PLATFORM_BINDING_PATH)) rmSync(PLATFORM_BINDING_PATH);
  } catch {
    /* ignore */
  }
}

/**
 * 绑定平台后，本机对外可达的「机器子域」基址 `https://m-<machineId>.<平台域名>`，
 * 平台会把该子域经隧道反代回本机 dashboard。域名从 binding.platformUrl 运行时推导
 * （公开仓库不写死平台域名）；前缀 `m-` 是平台约定。未绑定返回 null。
 */
export function platformMachineBaseUrl(): string | null {
  const b = readPlatformBinding();
  if (!b) return null;
  try {
    const u = new URL(b.platformUrl);
    return `${u.protocol}//m-${b.machineId}.${u.host}`;
  } catch {
    return null;
  }
}

/** 更新本机平台团队列表并落盘（读最新 binding 防覆盖其它字段）。返回更新后的列表。 */
export function setPlatformTeams(teams: PlatformTeam[]): PlatformTeam[] {
  const b = readPlatformBinding();
  if (!b) return [];
  b.teams = teams;
  writePlatformBinding(b);
  return teams;
}

/** 更新与平台通信的 IP 协议族偏好并落盘（隧道运行期换族成功后自愈式记忆）。 */
export function setPlatformIpFamily(family: 4 | 6 | undefined): void {
  const b = readPlatformBinding();
  if (!b) return;
  if (family === undefined) delete b.ipFamily;
  else b.ipFamily = family;
  writePlatformBinding(b);
}
