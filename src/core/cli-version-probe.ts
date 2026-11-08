import { execFileSync } from 'node:child_process';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import {
  runtimeInstallationKey,
  type CliRuntimeInstallationInput,
} from '../adapters/cli/runtime.js';
import type { CliAdapter, CliId } from '../adapters/cli/types.js';

/**
 * 按需 CLI 版本探测，补 daemon `refreshCliVersion` 只探测 bot 级安装的缺口。
 *
 * 按会话选 CLI（`/cli`，落在 `session.cliLaunchSnapshot`）和冷恢复的会话可能跑在
 * 与 bot 配置不同的「生效安装」上；它的 `runtimeInstallationKey` 从没被探测过，
 * worker-pool 里 `getCurrentCliVersion(key)` 只能拿到 `'unknown'`，于是版本门控 flag
 * （如 opencode v1 的 `--auto`）被静默跳过，它本来要修的托管轮次卡死在这些入口依旧复现。
 *
 * 设计约束（与 daemon 探测对齐）：
 *  - 同步 `execFileSync`，5s 超时；只在键缺失时探一次，结果进本模块缓存，
 *    失败也记 60s 负缓存，避免二进制缺失时每个新会话都白等 5s；
 *  - 任何失败一律回落 `'unknown'`，调用方按「flag 不受支持」处理，绝不抛错阻断建会话。
 */
const VERSION_PROBE_TTL_MS = 60_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;

const probedVersions = new Map<string, string>();
const lastProbeAt = new Map<string, number>();

/** 只依赖适配器的版本探测：成功返回归一化版本号，任何失败返回 'unknown'，绝不抛错。 */
export function probeCliVersion(
  adapter: Pick<CliAdapter, 'resolvedBin' | 'versionCommand'>,
): string {
  try {
    if (!adapter.resolvedBin && !adapter.versionCommand) return 'unknown';
    const command = adapter.versionCommand?.() ?? { bin: adapter.resolvedBin, args: ['--version'] };
    const raw = execFileSync(command.bin, command.args, {
      encoding: 'utf-8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
    }).trim();
    const version = raw.replace(/^[^0-9]*/, '');
    return !version || version === 'unknown' ? 'unknown' : version;
  } catch {
    return 'unknown';
  }
}

/**
 * 取一个具体安装的 CLI 版本：
 *  1. `getKnown(key)` 命中（daemon 已探测）→ 直接用，新鲜度由 daemon 的 60s 缓存负责；
 *  2. 本模块探过且成功 → 返回缓存值；
 *  3. 探测失败在 TTL 内 → 直接 'unknown'（负缓存，不重复阻塞）；
 *  4. 否则现场探一次并缓存。
 *
 * `getKnown` 由调用方注入（worker-pool 的 `getCurrentCliVersion`），避免本模块反向依赖
 * worker-pool 形成循环引用。
 */
export function ensureCliVersion(
  input: CliRuntimeInstallationInput,
  getKnown: (runtimeKey: string) => string,
): string {
  if (!input.cliId) return 'unknown';
  const key = runtimeInstallationKey(input);
  const known = getKnown(key);
  if (known && known !== 'unknown') return known;

  const cached = probedVersions.get(key);
  if (cached !== undefined) return cached;

  const now = Date.now();
  if (now - (lastProbeAt.get(key) ?? 0) < VERSION_PROBE_TTL_MS) return 'unknown';
  lastProbeAt.set(key, now);

  let version = 'unknown';
  try {
    version = probeCliVersion(
      createCliAdapterSync(input.cliId as CliId, input.cliPathOverride ?? undefined),
    );
  } catch {
    // 适配器都构造不出来时同样按「未探测」处理，绝不让建会话失败。
    version = 'unknown';
  }
  if (version !== 'unknown') probedVersions.set(key, version);
  return version;
}

/** 测试辅助：清空本模块的探测缓存（正常代码路径不需要）。 */
export function resetCliVersionProbeCacheForTest(): void {
  probedVersions.clear();
  lastProbeAt.clear();
}
