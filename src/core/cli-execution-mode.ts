import { capabilitiesOf, capabilityOn, type TriggerUserAuthConfig } from '../services/trigger-user-auth.js';

export type CliExecutionMode = 'native' | 'managed';
export interface CliExecutionConfig {
  triggerUserAuth?: Pick<TriggerUserAuthConfig, 'enabled' | 'tools' | 'capabilities'> | null;
  larkToolBinding?: boolean;
}

/** 只根据宿主配置判断；关闭全部个人能力及应用绑定才是完整原生模式。 */
export function configuredCliExecutionMode(config: CliExecutionConfig): CliExecutionMode {
  return config.larkToolBinding === false && capabilitiesOf(config.triggerUserAuth).size === 0
    ? 'native' : 'managed';
}

/** 原生模式使用宿主登录；受管调度仍要求完整的个人工具隔离。 */
export function delegatedCliExecutionAllowed(config: CliExecutionConfig): boolean {
  return configuredCliExecutionMode(config) === 'native'
    || capabilityOn(config.triggerUserAuth, 'lark-user') && capabilityOn(config.triggerUserAuth, 'bytecloud');
}

export interface WorkerCliExecution {
  mode: CliExecutionMode;
  /** 实际启动进程的系统账号，不冒充 CLI 的平台登录账号。 */
  executor: { kind: 'os-user'; username: string; uid?: number };
}

export function workerCliExecution(config: CliExecutionConfig, boundLark: boolean,
  user: { username: string; uid: number }): WorkerCliExecution {
  return { mode: configuredCliExecutionMode({ ...config, larkToolBinding: boundLark }),
    executor: { kind: 'os-user', username: user.username,
      ...(Number.isSafeInteger(user.uid) && user.uid >= 0 ? { uid: user.uid } : {}) } };
}

export interface CliExecutionInfo {
  mode: CliExecutionMode | 'unknown';
  /** 当前发起/控制人是否通过宿主的操作权限核验；模式本身不授予权限。 */
  nativeAuthorized: boolean;
  executor?: WorkerCliExecution['executor'];
}

export function isWorkerCliExecution(value: unknown): value is WorkerCliExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const e = v.executor as Record<string, unknown> | undefined;
  return (v.mode === 'native' || v.mode === 'managed')
    && Object.keys(v).every(key => key === 'mode' || key === 'executor')
    && !!e && typeof e === 'object' && !Array.isArray(e) && e.kind === 'os-user'
    && typeof e.username === 'string' && e.username.length > 0 && e.username.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(e.username)
    && (e.uid === undefined || typeof e.uid === 'number' && Number.isSafeInteger(e.uid) && e.uid >= 0)
    && Object.keys(e).every(key => ['kind', 'username', 'uid'].includes(key));
}

export function isCliExecutionInfo(value: unknown): value is CliExecutionInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.nativeAuthorized !== 'boolean'
    || !Object.keys(v).every(key => ['mode', 'nativeAuthorized', 'executor'].includes(key))) return false;
  if (v.mode === 'unknown') return v.nativeAuthorized === false && v.executor === undefined;
  return isWorkerCliExecution({ mode: v.mode, executor: v.executor })
    && (v.mode === 'native' || v.nativeAuthorized === false);
}

/** 旧 worker、配置已切换或代次不一致均返回 unknown，不能用环境标记补齐。 */
export function resolveCliExecutionInfo(input: {
  config: CliExecutionConfig;
  workerPid?: number;
  workerGeneration?: number;
  report?: {
    workerPid: number; workerGeneration: number; conflict?: string;
    cliExecution?: WorkerCliExecution;
  };
  nativeAuthorized: boolean;
}): CliExecutionInfo {
  const { report } = input;
  const cli = report?.cliExecution;
  if (!report || report.conflict || report.workerPid !== input.workerPid
    || report.workerGeneration !== input.workerGeneration || !isWorkerCliExecution(cli)
    || cli.mode !== configuredCliExecutionMode(input.config)) {
    return { mode: 'unknown', nativeAuthorized: false };
  }
  return { mode: cli.mode, nativeAuthorized: cli.mode === 'native' && input.nativeAuthorized,
    executor: { ...cli.executor } };
}

export function sessionCliExecutionInfo(session: {
  worker?: { pid?: number } | null;
  workerGeneration?: number;
  reportedIdentityModel?: Parameters<typeof resolveCliExecutionInfo>[0]['report'];
  managedTurnOrigin?: { turnId?: string; identityTurnId?: string; callerOpenId?: string };
  scheduledControlActors?: Map<string, { openId: string }>;
  scheduledToolActors?: Map<string, { openId: string }>;
}, config: CliExecutionConfig, operatorOpenIds: readonly string[]): CliExecutionInfo {
  const origin = session.managedTurnOrigin;
  const turnId = origin?.identityTurnId ?? origin?.turnId ?? '';
  const caller = origin?.callerOpenId ?? session.scheduledControlActors?.get(turnId)?.openId
    ?? session.scheduledToolActors?.get(turnId)?.openId;
  return resolveCliExecutionInfo({ config, workerPid: session.worker?.pid,
    workerGeneration: session.workerGeneration, report: session.reportedIdentityModel,
    nativeAuthorized: !!caller && operatorOpenIds.includes(caller) });
}
