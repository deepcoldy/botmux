// 平台绑定状态：存在 ~/.botmux/platform.json，记录这台机器绑到了哪个平台。
import { readFileSync, existsSync } from 'node:fs';
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
