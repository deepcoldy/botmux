/**
 * Lark OpenAPI 网关：per-larkAppId 的全局限流 + 429 退避重试 + 熔断器。
 *
 * 背景：client.ts 原本只有 per-session 串行队列，挡不住多会话卡片更新风暴
 * （50 会话 × 0.5 QPS PATCH ≈ 25 QPS 打同一 app 配额），且 429/失败被调用方
 * 静默 catch。本模块在 client.ts 的写原语内部收口，不改变任何函数签名与调用方
 * 语义：gate 内部重试后仍失败则抛原始错误，调用方无感知。
 *
 * 三层机制（均以 larkAppId 为 key，多 bot 互不影响）：
 *   1. Token bucket —— 默认 15 QPS / burst 15，把多会话并发写平滑到 app 配额内；
 *      等待 >100ms 打 warn 日志（带 larkAppId + op），让限流可见。
 *   2. 429/瞬时错误指数退避重试 —— 默认最多 3 次（500ms 起，上限 8s），尊重
 *      Retry-After / x-ogw-ratelimit-reset 头（取 max，cap 到 32s）。
 *   3. 熔断器 —— 30s 窗口内连续 5 次失败跳闸，跳闸期间所有写快速失败
 *      （LarkCircuitOpenError）；30s 后半开探测一次，成功即恢复（info 日志），
 *      失败则重新跳闸。
 *
 * 与 ask-card.ts 的关系：ask-card 的 classifyAskDispatchError + broker backoff
 * 是业务层重试（gate 失败之后），本模块是 HTTP 层重试（错误到达调用方之前）。
 * 分类逻辑镜像 ask-card 的核心规则但自包含，不互相导入。
 *
 * 配置：resolveLarkGateConfig 每次调用直接读 env（live getter，无需重启即可
 * 调 QPS）。env 旋钮：BOTMUX_LARK_QPS、BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS、
 * BOTMUX_LARK_GATE_CIRCUIT_FAILURE_THRESHOLD、
 * BOTMUX_LARK_GATE_CIRCUIT_PROBE_INTERVAL_MS。
 */
import { logger } from '../../utils/logger.js';

export interface LarkGateConfig {
  /** token bucket 填充速率（req/s），默认 15。 */
  qps: number;
  /** 桶容量，默认 = qps。 */
  burst: number;
  /** 429/瞬时错误最大重试次数，默认 3。 */
  retryMaxAttempts: number;
  /** 退避基数（ms），默认 500。 */
  retryBaseMs: number;
  /** 退避上限（ms），默认 8000。 */
  retryMaxMs: number;
  /** 熔断阈值（连续失败次数），默认 5。 */
  circuitFailureThreshold: number;
  /** 失败计数窗口（ms），默认 30000。 */
  circuitWindowMs: number;
  /** 熔断后半开探测间隔（ms），默认 30000。 */
  circuitProbeIntervalMs: number;
}

/** 瞬时 Lark 业务码：即使 HTTP 4xx 也值得重试（频控/后端抖动）。 */
const TRANSIENT_LARK_CODES = new Set([230049, 230020, 99991400]);

function positiveFinite(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const v = Math.floor(positiveFinite(raw, fallback));
  return v >= min ? v : fallback;
}

/**
 * 读 env 构建 gate 配置。每次调用都重新读 process.env（或传入的 env），
 * 所以 daemon 运行期间改 env 即可调 QPS，无需重启。非法值回退默认。
 */
export function resolveLarkGateConfig(env: NodeJS.ProcessEnv = process.env): LarkGateConfig {
  const qps = positiveFinite(env.BOTMUX_LARK_QPS, 15);
  return {
    qps,
    burst: qps,
    retryMaxAttempts: nonNegativeInt(env.BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS, 3),
    retryBaseMs: 500,
    retryMaxMs: 8000,
    circuitFailureThreshold: positiveInt(env.BOTMUX_LARK_GATE_CIRCUIT_FAILURE_THRESHOLD, 5, 1),
    circuitWindowMs: 30_000,
    circuitProbeIntervalMs: nonNegativeInt(env.BOTMUX_LARK_GATE_CIRCUIT_PROBE_INTERVAL_MS, 30_000),
  };
}

/** 熔断器跳闸期间由 executeWithLarkGate 直接抛出：写操作未触达网络。 */
export class LarkCircuitOpenError extends Error {
  constructor(readonly larkAppId: string, readonly openedAt: number) {
    super(`Lark circuit open for ${larkAppId} (opened at ${new Date(openedAt).toISOString()})`);
    this.name = 'LarkCircuitOpenError';
  }
}

// ─── Token bucket ─────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  constructor(
    private readonly capacity: number,
    private readonly refillRatePerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }
  /** 距下一个令牌可用的等待 ms；0 = 现在就有。 */
  waitTimeMs(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillRatePerSec) * 1000);
  }
  consume(now: number): void {
    this.refill(now);
    this.tokens -= 1;
  }
  private refill(now: number): void {
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
      this.lastRefillMs = now;
    }
  }
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

interface CircuitState {
  status: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  windowStartMs: number;
  openedAtMs: number;
}

function newCircuit(now: number): CircuitState {
  return { status: 'closed', consecutiveFailures: 0, windowStartMs: now, openedAtMs: 0 };
}

// ─── 模块级 per-app 状态 ──────────────────────────────────────────────────────

const buckets = new Map<string, TokenBucket>();
const circuits = new Map<string, CircuitState>();

function getBucket(larkAppId: string, cfg: LarkGateConfig): TokenBucket {
  let bucket = buckets.get(larkAppId);
  if (!bucket) {
    bucket = new TokenBucket(cfg.burst, cfg.qps);
    buckets.set(larkAppId, bucket);
  }
  return bucket;
}

function getCircuit(larkAppId: string): CircuitState {
  let circuit = circuits.get(larkAppId);
  if (!circuit) {
    circuit = newCircuit(Date.now());
    circuits.set(larkAppId, circuit);
  }
  return circuit;
}

/** 测试隔离：清空所有 app 的 bucket / 熔断器状态。 */
export function __testOnly_resetLarkGate(): void {
  buckets.clear();
  circuits.clear();
}

// ─── 错误分类（镜像 ask-card.classifyAskDispatchError，自包含） ────────────────

/** 提取 Lark 业务码：axios response.data.code / 顶层 code / 消息尾部 (code: NNN)。 */
function extractLarkBusinessCode(err: unknown): number | undefined {
  const e = err as {
    response?: { data?: { code?: number } };
    code?: unknown;
    message?: string;
  } | null | undefined;
  const structured = e?.response?.data?.code ?? e?.code;
  if (typeof structured === 'number' && Number.isFinite(structured)) return structured;
  const message = typeof e?.message === 'string' ? e.message : '';
  const m = /\(code:\s*(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/**
 * 判断错误是否值得重试：
 *   - 命中 TRANSIENT_LARK_CODES 的业务码 → 重试（即使 HTTP 4xx）
 *   - axios 形态：无 response（网络错误）→ 重试；429 / 5xx → 重试；其他 4xx → 不重试
 *   - 非 axios 且无瞬时码（MessageWithdrawnError、LarkTransportDisabledError 等
 *     确定性错误）→ 不重试
 */
export function isRetryableLarkError(err: unknown): boolean {
  const code = extractLarkBusinessCode(err);
  if (code !== undefined && TRANSIENT_LARK_CODES.has(code)) return true;

  const e = err as {
    isAxiosError?: boolean;
    name?: string;
    config?: unknown;
    response?: { status?: number };
    status?: number;
  } | null | undefined;
  const looksAxios = !!e && (
    e.isAxiosError === true
    || e.name === 'AxiosError'
    || (!!e.config && (!!e.response || e.status != null))
  );
  if (!looksAxios) return false;
  const status = e.response?.status ?? e.status;
  if (status === undefined) return true; // 网络错误（无 response）
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return false;
}

/** 从 Retry-After / x-ogw-ratelimit-reset 头解析等待 ms（头值单位为秒）。 */
function retryAfterHeaderMs(err: unknown): number | undefined {
  const e = err as {
    response?: { headers?: Record<string, unknown> };
    headers?: Record<string, unknown>;
  } | null | undefined;
  const headers = e?.response?.headers ?? e?.headers;
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After']
    ?? headers['x-ogw-ratelimit-reset'] ?? headers['X-Ogw-Ratelimit-Reset'];
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

function computeBackoffMs(cfg: LarkGateConfig, attempt: number, err: unknown): number {
  const base = Math.min(cfg.retryBaseMs * 2 ** attempt, cfg.retryMaxMs);
  const headerMs = retryAfterHeaderMs(err);
  if (headerMs === undefined) return base;
  return Math.min(Math.max(base, headerMs), cfg.retryMaxMs * 4);
}

// ─── 等待 / 中止 ───────────────────────────────────────────────────────────────

function gateAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  // Node 22 的默认 abort reason 是 DOMException 且 instanceof Error 为 true，
  // 不判掉会透出 'This operation was aborted' 而非网关自己的错误语义。
  // 调用方显式 abort(err) 传入的自定义 reason 仍然原样透传。
  if (reason instanceof Error && reason.constructor.name !== 'DOMException') return reason;
  const err = new Error('lark-gate operation aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(gateAbortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(gateAbortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireToken(
  larkAppId: string,
  op: string,
  cfg: LarkGateConfig,
  signal?: AbortSignal,
): Promise<void> {
  const bucket = getBucket(larkAppId, cfg);
  for (;;) {
    if (signal?.aborted) throw gateAbortError(signal);
    const now = Date.now();
    const waitMs = bucket.waitTimeMs(now);
    if (waitMs === 0) {
      bucket.consume(now);
      return;
    }
    // 限流等待可见：>100ms 的等待打 warn（带 larkAppId + op），让多会话
    // 卡片更新风暴在日志里可观测，而不是静默排队。
    if (waitMs > 100) {
      logger.warn(`[lark-gate] ${larkAppId} rate-limit wait ${waitMs}ms op=${op}`);
    }
    await sleep(waitMs, signal);
  }
}

function recordFailure(
  circuit: CircuitState,
  larkAppId: string,
  op: string,
  cfg: LarkGateConfig,
  now: number,
): void {
  if (circuit.status === 'half-open') {
    // 探测请求失败 → 立即重新跳闸，探测时钟重置。
    circuit.status = 'open';
    circuit.openedAtMs = now;
    circuit.consecutiveFailures += 1;
    logger.warn(`[lark-gate] ${larkAppId} circuit OPEN after ${circuit.consecutiveFailures} failures op=${op}`);
    return;
  }
  if (now - circuit.windowStartMs > cfg.circuitWindowMs) {
    // 窗口外的失败不累计：旧失败已过期，重新开窗口。
    circuit.windowStartMs = now;
    circuit.consecutiveFailures = 1;
  } else {
    circuit.consecutiveFailures += 1;
  }
  if (circuit.consecutiveFailures >= cfg.circuitFailureThreshold) {
    circuit.status = 'open';
    circuit.openedAtMs = now;
    logger.warn(`[lark-gate] ${larkAppId} circuit OPEN after ${circuit.consecutiveFailures} failures op=${op}`);
  }
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 在 per-app 限流/熔断网关内执行一次 Lark 写操作。
 *
 * 流程：熔断器检查（open 且未到探测间隔 → 快速失败；到期 → half-open 放行）→
 * token bucket 获取令牌 → 执行 fn → 成功则清零失败计数（half-open → closed）；
 * 失败且可重试 → 指数退避（尊重 Retry-After 头）后重试；不可重试或重试耗尽 →
 * 累计失败计数（可能触发熔断）并抛原始错误。
 *
 * 不传 signal 的调用方行为与直接调用 fn 完全一致（除限流/重试引入的延迟外）。
 */
export async function executeWithLarkGate<T>(
  larkAppId: string,
  op: string,
  fn: () => Promise<T>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const cfg = resolveLarkGateConfig();
  const signal = options?.signal;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw gateAbortError(signal);
    const now = Date.now();
    const circuit = getCircuit(larkAppId);
    if (circuit.status === 'open') {
      if (now - circuit.openedAtMs < cfg.circuitProbeIntervalMs) {
        throw new LarkCircuitOpenError(larkAppId, circuit.openedAtMs);
      }
      circuit.status = 'half-open';
    }
    await acquireToken(larkAppId, op, cfg, signal);
    // acquireToken 的 await 会让出事件循环——调用方的 abort() 可能在这期间
    // 到达。此处必须复查：已 aborted 的 signal 上后注册的监听不会触发，
    // 不提前抛出会让 fn 内的请求永远挂起。
    if (signal?.aborted) throw gateAbortError(signal);
    try {
      const result = await fn();
      circuit.consecutiveFailures = 0;
      if (circuit.status === 'half-open') {
        circuit.status = 'closed';
        logger.info(`[lark-gate] ${larkAppId} circuit closed (recovered) op=${op}`);
      }
      return result;
    } catch (err) {
      if (isRetryableLarkError(err) && attempt < cfg.retryMaxAttempts) {
        const backoffMs = computeBackoffMs(cfg, attempt, err);
        attempt += 1;
        logger.warn(`[lark-gate] ${larkAppId} retry ${attempt}/${cfg.retryMaxAttempts} op=${op} backoff=${backoffMs}ms`);
        if (signal?.aborted) throw gateAbortError(signal);
        await sleep(backoffMs, signal);
        continue;
      }
      recordFailure(circuit, larkAppId, op, cfg, Date.now());
      throw err;
    }
  }
}
