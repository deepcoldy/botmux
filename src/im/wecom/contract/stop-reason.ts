/**
 * What each reason on a gateway's own `stopped` record means, in the words both
 * `botmux wecom start|stop|restart` and the Dashboard show. One table, so the
 * two never explain the same stopped connection differently.
 *
 * Pure: no process code, no file access (the Dashboard server and the CLI both
 * import it; see test/wecom-import-boundaries.test.ts).
 */
import type { WecomDesiredStopReason } from '../config/fleet-desired-state.js';

/** What a caller may add to the sentence; it reads the configuration itself. */
export interface WecomStopReasonContext {
  /**
   * The NAME of the configuration's credential environment variable
   * (`secretEnv`), for `credential_env_missing`. Never pass its value.
   */
  credentialEnv?: string;
}

/** Same shape the configuration parser accepts for `secretEnv`. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function credentialEnvMissing(context: WecomStopReasonContext): string {
  const name = context.credentialEnv && ENV_NAME.test(context.credentialEnv) ? ` ${context.credentialEnv} ` : '';
  return `配置引用的凭据环境变量${name}在 fleet 的运行环境里不存在或为空；`
    + '请在设置了该变量的终端里执行 botmux restart，或把配置改为使用凭据文件';
}

const STOP_REASON_TEXT: Record<WecomDesiredStopReason, (context: WecomStopReasonContext) => string> = {
  replaced: () => '同一个 BotID 已在别处连接，本连接被顶替',
  authentication_failed: () => '企业微信拒绝了该机器人的认证',
  invalid_configuration: () => '配置无效',
  credential_env_missing: credentialEnvMissing,
  not_configured: () => '配置文件或凭据缺失',
  instance_busy: () => '该机器人的实例锁被 fleet 之外的进程占用',
};

export function describeWecomStopReason(
  reason: WecomDesiredStopReason,
  context: WecomStopReasonContext = {},
): string {
  return STOP_REASON_TEXT[reason]?.(context) ?? reason;
}
