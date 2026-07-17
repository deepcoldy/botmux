import type { DashboardLocateResult } from '../shared/types.js';

const supportedDashboardProtocolVersion = 1;
const defaultCompatTimeoutMs = 3000;
const cliUpgradeHint = '请升级或切换全局 botmux CLI 后重启运行时；源码开发可执行 pnpm switch:here && botmux restart。也可以先在外部浏览器打开控制台。';

type DashboardCompatFailureReason = Extract<DashboardLocateResult, { ok: false }>['reason'];

export type DashboardCompatResult =
  | { ok: true }
  | { ok: false; reason: DashboardCompatFailureReason; message: string };

export type DashboardCompatFetch = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ValidateDashboardCompatOptions {
  fetch?: DashboardCompatFetch;
  timeoutMs?: number;
}

export async function validateDashboardCompat(
  dashboardUrl: string,
  options: ValidateDashboardCompatOptions = {},
): Promise<DashboardCompatResult> {
  let compatUrl: string;
  try {
    const parsed = new URL(dashboardUrl);
    // Preserve auth query params from dashboard URLs. Platform tunnel links use
    // `?t=...` before the hash; dropping it makes the compat probe look like an
    // old/incompatible CLI even when the local dashboard is current.
    parsed.pathname = '/__desktop/compat';
    parsed.hash = '';
    compatUrl = parsed.toString();
  } catch {
    return {
      ok: false,
      reason: 'unreachable',
      message: 'Dashboard URL 无效，无法校验 Desktop 兼容协议。',
    };
  }

  const fetchCompat = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchCompat) {
    return {
      ok: false,
      reason: 'unreachable',
      message: '当前运行环境无法请求 Dashboard 兼容协议。',
    };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? defaultCompatTimeoutMs;
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchCompat(compatUrl, { signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'incompatible',
        message: `当前 CLI 未提供 Desktop 兼容协议 ${new URL(compatUrl).pathname}（HTTP ${response.status}），${cliUpgradeHint}`,
      };
    }

    let manifest: unknown;
    try {
      manifest = await response.json();
    } catch {
      return {
        ok: false,
        reason: 'incompatible',
        message: `当前 CLI 返回的 Desktop 兼容信息格式不正确，${cliUpgradeHint}`,
      };
    }
    return validateCompatManifest(manifest);
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      message: error instanceof Error
        ? `Dashboard 兼容协议请求失败：${error.message}`
        : 'Dashboard 兼容协议请求失败。',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateCompatManifest(manifest: unknown): DashboardCompatResult {
  if (!isCompatManifestShape(manifest)) {
    return {
      ok: false,
      reason: 'incompatible',
      message: `当前 CLI 返回的 Desktop 兼容信息格式不正确，${cliUpgradeHint}`,
    };
  }

  if (manifest.dashboardProtocolVersion > supportedDashboardProtocolVersion) {
    return {
      ok: false,
      reason: 'incompatible',
      message: `当前 CLI dashboard 协议 v${manifest.dashboardProtocolVersion} 高于 Desktop 支持的 v${supportedDashboardProtocolVersion}，${cliUpgradeHint}`,
    };
  }

  if (!manifest.desktopShell.supported) {
    return {
      ok: false,
      reason: 'incompatible',
      message: `当前 CLI dashboard 不支持 Desktop shell，${cliUpgradeHint}`,
    };
  }

  return { ok: true };
}

function isCompatManifestShape(manifest: unknown): manifest is {
  schemaVersion: 1;
  product: 'botmux';
  runtimeVersion: string;
  dashboardProtocolVersion: number;
  desktopShell: { supported: boolean; minAppVersion?: string };
  features: string[];
  routes: string[];
} {
  if (!manifest || typeof manifest !== 'object') return false;
  const record = manifest as Record<string, unknown>;
  const desktopShell = record.desktopShell;
  // Keep the shape check strict enough to catch old/malformed runtimes before
  // the renderer embeds a dashboard that may not understand desktop shell mode.
  return record.schemaVersion === 1
    && record.product === 'botmux'
    && typeof record.runtimeVersion === 'string'
    && record.runtimeVersion.trim().length > 0
    && typeof record.dashboardProtocolVersion === 'number'
    && Number.isInteger(record.dashboardProtocolVersion)
    && record.dashboardProtocolVersion >= 1
    && Boolean(desktopShell)
    && typeof desktopShell === 'object'
    && typeof (desktopShell as Record<string, unknown>).supported === 'boolean'
    && isStringArray(record.features)
    && isStringArray(record.routes);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
