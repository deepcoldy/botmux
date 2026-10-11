import type { BackendType, SessionProbe } from '../adapters/backend/types.js';

/** core-only 对外暴露的最小会话输入；刻意不包含 token、socket、Prompt 或环境变量。 */
export interface CoreOnlyHostFactsInput {
  /** Botmux 逻辑会话 id。 */
  readonly sessionId: string;
  /** 会话持久化状态。 */
  readonly sessionStatus: 'active' | 'closed';
  /** 本次会话冻结的 CLI id；历史会话无法确认时为 null。 */
  readonly cli: string | null;
  /** 本次会话冻结的后端；历史会话无法确认时为 null。 */
  readonly backend: BackendType | null;
  /** CLI 原生 session/thread id；尚未形成或无法确认时为 null。 */
  readonly nativeSessionId: string | null;
  /** Botmux 当前逻辑 turn id；它不是 CLI native turn id。 */
  readonly activeTurnId: string | null;
  /** 当前 daemon 是否仍持有本会话 worker。 */
  readonly workerPresent: boolean;
  /** worker 是否已完成当前 generation 的 init。 */
  readonly workerReady: boolean;
  /** 当前 worker generation；未形成时为 null。 */
  readonly workerGeneration: number | null;
  /** 持久后端的权威三态探测；非持久后端或无坐标时为 null。 */
  readonly backingProbe: SessionProbe | null;
}

/**
 * core-only 会话宿主事实。
 *
 * 该结构只描述 Botmux 已观察到的会话事实，不表示模型任务完成，也不授予终端写权限。
 */
export interface CoreOnlyHostFacts {
  /** 固定协议版本；新增字段必须保持向后兼容。 */
  readonly protocolVersion: 1;
  /** Botmux 逻辑会话 id。 */
  readonly sessionId: string;
  /** 当前 CLI id；历史数据缺失时为 null。 */
  readonly cli: string | null;
  /** 当前后端；历史数据缺失时为 null。 */
  readonly backend: BackendType | null;
  /** Botmux 会话行状态。 */
  readonly sessionStatus: 'active' | 'closed';
  /** 会话宿主可证明的存活状态；unknown 绝不能被调用方当作 missing。 */
  readonly liveness: SessionProbe;
  /** worker 生命周期事实；不含 PID、端口或访问 token。 */
  readonly worker: {
    readonly present: boolean;
    readonly ready: boolean;
    readonly generation: number | null;
  };
  /** CLI 原生身份与 Botmux 逻辑 turn；nativeTurnId 尚未跨 worker 安全发布。 */
  readonly native: {
    readonly sessionId: string | null;
    readonly activeTurnId: string | null;
    readonly nativeTurnId: null;
  };
}

/**
 * 将 daemon 内部状态投影为可公开的只读事实。
 *
 * 持久后端只信任它自己的三态探测；PTY 等非持久后端仅在 live worker 已 ready 时报告
 * exists，其余情况一律 unknown，避免把“当前没有 worker 引用”误称为底层进程已消失。
 */
export function projectCoreOnlyHostFacts(input: CoreOnlyHostFactsInput): CoreOnlyHostFacts {
  const liveness: SessionProbe = input.backingProbe
    ?? (input.workerPresent && input.workerReady ? 'exists' : 'unknown');
  return {
    protocolVersion: 1,
    sessionId: input.sessionId,
    cli: input.cli,
    backend: input.backend,
    sessionStatus: input.sessionStatus,
    liveness,
    worker: {
      present: input.workerPresent,
      ready: input.workerReady,
      generation: input.workerGeneration,
    },
    native: {
      sessionId: input.nativeSessionId,
      activeTurnId: input.activeTurnId,
      nativeTurnId: null,
    },
  };
}
