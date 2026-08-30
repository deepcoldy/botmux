import type { OpenPlatformAutomationResult } from './open-platform-automation.js';

type OpenPlatformAutomationSuccess = Extract<OpenPlatformAutomationResult, { ok: true }>;
type OpenPlatformAutomationFailure = Extract<OpenPlatformAutomationResult, { ok: false }>;

export type SetupOpenPlatformOutcome =
  | { status: 'skipped' }
  | { status: 'ready'; result: OpenPlatformAutomationSuccess }
  | { status: 'ready_with_warnings'; result: OpenPlatformAutomationSuccess }
  | { status: 'manual'; result: OpenPlatformAutomationFailure }
  | { status: 'failed'; result: OpenPlatformAutomationFailure };

/**
 * Translate the low-level Open Platform response into setup completion
 * semantics. Lark's SDK compatibility path is intentionally manual because the
 * Feishu Web console automation does not apply there; it must not be reported
 * as a failed Feishu one-click setup.
 */
export function classifySetupOpenPlatformOutcome(
  result: OpenPlatformAutomationResult,
): Exclude<SetupOpenPlatformOutcome, { status: 'skipped' }> {
  if (!result.ok) {
    return result.reason === 'unsupported_brand'
      ? { status: 'manual', result }
      : { status: 'failed', result };
  }
  // redirect 白名单没写成功也算 warning：它不阻断建 bot，但缺了它 authorize 直接
  // 20029（群聊模式 p2pMode=group / 会话群标签 / `/login` 全都授权不了）。历史实现
  // 把这种「建好了但一授权就失败」的 bot 报成纯 ready，用户只能等踩坑才发现。
  //
  // 例外：`publishSkipped` 说明本次「配置本就齐全、无变更 → 有意跳过发版」。这条
  // 短路分支里 versionId 必为空、importedScopeCount 必为 0（真发了 scope/update 就
  // 会置 mutated 而不走短路），两者都是**预期结果**而非缺陷——不排除的话，一次完全
  // 健康的重启自检会被恒判成 ready_with_warnings。
  const publishSkipped = result.publishSkipped === true;
  const hasWarnings = Boolean(
    result.scopeWarning
    || result.eventWarning
    || (result.scopeCount === 0 && !publishSkipped)
    || result.skippedScopeCount > 0
    || (!result.versionId && !publishSkipped)
    // 版本提交后回读发现它仍是草稿（或回读本身失败）。**必须计入 warning**：
    // scope 都写进清单了、但版本没真提交 ⟹ 权限一项都不生效，而 CLI / scripted
    // JSON 路径若报 `ready` 就是**假绿灯**——恰好是这次线上事故的形态（commit 回
    // code=0 而版本停在草稿态）。daemon 自愈路径自己 warn + DM 了，别的调用方靠这里。
    || result.versionWarning
    || !result.redirectConfigured
    || result.redirectWarning
  );
  return { status: hasWarnings ? 'ready_with_warnings' : 'ready', result };
}

/** Critical Feishu automation failures leave a persisted but not-yet-ready bot. */
export function blocksSetupBotStart(outcome: SetupOpenPlatformOutcome): boolean {
  return outcome.status === 'failed';
}

const SESSION_RETRY_REASONS = new Set([
  'missing_session',
  'invalid_session',
  'login_failed',
  'qr_expired',
  'timeout',
  'missing_csrf',
]);

/** Build a retry command only when rerunning automation can make progress. */
export function setupOpenPlatformRetryCommand(
  appId: string,
  outcome: SetupOpenPlatformOutcome,
): string | undefined {
  if (outcome.status !== 'failed') return undefined;
  const switchAccount = SESSION_RETRY_REASONS.has(outcome.result.reason) ? ' --switch-account' : '';
  return `botmux setup configure ${appId}${switchAccount}`;
}

/**
 * Scripted JSON callers must never receive an unexpected QR, including BYO
 * credential mode. The one-scan create path also reuses the session it just
 * acquired so it never scans twice.
 */
export function scriptedSetupOpenPlatformReuseOnly(options: {
  json: boolean;
  createApp: boolean;
  compatibilityMode: boolean;
  brand: 'feishu' | 'lark';
}): boolean {
  if (options.brand !== 'feishu') return false;
  return options.json || (options.createApp && !options.compatibilityMode);
}

/** Secret-free JSON representation used by scripted setup output. */
export function setupOpenPlatformOutcomeJson(outcome: SetupOpenPlatformOutcome): Record<string, unknown> {
  if (outcome.status === 'skipped') return { status: outcome.status };
  const { ok: _ok, ...details } = outcome.result;
  return { status: outcome.status, ...details };
}
