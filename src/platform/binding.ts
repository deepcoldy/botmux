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
