import { connect } from 'node:net';
import {
  isLiteralLoopbackHost,
  isTcpPort,
  type LiteralLoopbackHost,
} from './loopback-target.js';
import {
  resolvePreviewPortOwner,
  safePreviewPortOwnerProof,
  verifyPreviewPortOwner,
  type PreviewPortOwnerFailure,
  type PreviewPortOwnerProof,
} from './preview-port-owner.js';

export const PREVIEW_ROUTE_PREFIX = '/preview';
/**
 * Reserved path segment that introduces the sandboxed content stream:
 * `/preview/<sessionId>/__botmux_preview_content/<capability>/…`.
 *
 * It is a path segment rather than a query flag on purpose. The preview
 * document is served into an opaque-origin sandbox, so its own relative
 * subresources and WebSockets carry no dashboard cookie; a capability that
 * lives in the path is inherited by every relative URL the app resolves,
 * while a query flag would be dropped by the first `./app.js`.
 */
export const PREVIEW_CONTENT_SEGMENT = '__botmux_preview_content';
export const PREVIEW_PROBE_TIMEOUT_MS = 750;

/** DNS names are deliberately excluded: resolving even `localhost` would add a
 * rebinding/configuration surface to an SSRF boundary. */
export type PreviewLoopbackHost = LiteralLoopbackHost;

export interface SessionPreviewTarget {
  host: PreviewLoopbackHost;
  port: number;
  registeredAt: string;
  /**
   * P1-12：注册那一刻「谁在持有这个端口」的证明。没有它就只有一次 TCP connect 的
   * 事实，代理无法分辨自己连的是本会话的 dev server 还是端口号被回收后顶上来的
   * 任意本机进程，所以它是必填字段——老版本写下的、缺证明的 target 在这里直接归零
   * （fail closed，会话重新 `botmux preview <port>` 即可）。
   */
  owner: PreviewPortOwnerProof;
  /**
   * P1-13：注册时的 worker 代次。worker 换代（refork / 切 CLI / adopt / exit）会
   * 原子清掉 target，这个字段是「万一漏清」时的第二道判据，也是注册路由 probe
   * await 之后做 CAS 复核的锚点。
   */
  workerGeneration: number;
}

export interface SessionPreviewDescriptor {
  path: string;
  registeredAt: string;
}

export function isPreviewPort(value: unknown): value is number {
  return isTcpPort(value);
}

export function isPreviewLoopbackHost(value: unknown): value is PreviewLoopbackHost {
  return isLiteralLoopbackHost(value);
}

/** Re-validate persisted/SSE data at every trust boundary. Invalid legacy or
 * attacker-shaped objects collapse to undefined and are never dialled. */
export function safeSessionPreviewTarget(value: unknown): SessionPreviewTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isPreviewLoopbackHost(raw.host) || !isPreviewPort(raw.port)) return undefined;
  if (typeof raw.registeredAt !== 'string') {
    return undefined;
  }
  const registeredAt = new Date(raw.registeredAt);
  if (Number.isNaN(registeredAt.valueOf()) || registeredAt.toISOString() !== raw.registeredAt) {
    return undefined;
  }
  const owner = safePreviewPortOwnerProof(raw.owner);
  if (!owner) return undefined;
  if (!Number.isSafeInteger(raw.workerGeneration) || (raw.workerGeneration as number) < 0) {
    return undefined;
  }
  return {
    host: raw.host,
    port: raw.port,
    registeredAt: raw.registeredAt,
    owner,
    workerGeneration: raw.workerGeneration as number,
  };
}

/**
 * P1-1：一次注册的指纹。空串表示「这个会话此刻没有合法的预览目标」。
 *
 * host:port 不足以当身份：端口被回收后重注册、worker 换代后在同一端口重注册，都会
 * 产生同一个 host:port，但那是另一次注册、另一个进程。registeredAt（ISO 串，天然可
 * 当 revision）、workerGeneration、以及 owner 三元证明合起来才唯一确定「哪一次」。
 */
export function sessionPreviewFingerprint(previewTarget: unknown): string {
  const target = safeSessionPreviewTarget(previewTarget);
  if (!target) return '';
  return [
    target.host,
    target.port,
    target.registeredAt,
    target.workerGeneration,
    target.owner.pid,
    target.owner.procStart,
    target.owner.inode,
  ].join('|');
}

/** P1-1：两个 target 是不是同一次注册（见 `sessionPreviewFingerprint`）。 */
export function sameSessionPreviewTarget(
  a: SessionPreviewTarget,
  b: SessionPreviewTarget,
): boolean {
  return sessionPreviewFingerprint(a) === sessionPreviewFingerprint(b);
}

/**
 * P1-12：目标是否仍由注册时那个进程持有。probe 之后与**每次代理落地之前**都要过
 * 这一关；`changed`/`unverifiable` 一律按失效处理（返回 false），调用方负责清 target
 * 并广播 `preview: null`。
 */
export function sessionPreviewTargetStillOwned(
  target: SessionPreviewTarget,
  opts: { procRoot?: string } = {},
): boolean {
  return verifyPreviewPortOwner({
    host: target.host,
    port: target.port,
    proof: target.owner,
    ...(opts.procRoot !== undefined ? { procRoot: opts.procRoot } : {}),
  }) === 'ok';
}

/**
 * Riff 矩阵：哪些会话后端的 Web 服务在 daemon 的 loopback 上**根本不可能**出现。
 *
 * riff 是远端 sandbox——CLI 与它启动的 dev server 都跑在远程主机上，daemon 这一侧
 * 的 127.0.0.1 上永远没有对应监听。此时必须明确回 `preview_unsupported`，而不是
 * 让它落进 `preview_unreachable` 冒充「偶发故障」让用户反复重试；前端据此隐藏入口。
 * pty / tmux / zellij / herdr / zmx 都是本机后端，行为不变。
 */
export function previewBackendSupported(backendType: unknown): boolean {
  return backendType !== 'riff';
}

export function sessionPreviewPath(sessionId: string): string {
  return `${PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}/`;
}

/** Base path of the sandboxed content stream. Every relative URL the framed
 *  app resolves stays under it, which is how the capability survives without
 *  cookies or query strings. */
export function sessionPreviewContentPath(sessionId: string, capability: string): string {
  return `${sessionPreviewPath(sessionId)}${PREVIEW_CONTENT_SEGMENT}/${capability}/`;
}

export function sessionPreviewDescriptor(
  sessionId: string,
  value: unknown,
): SessionPreviewDescriptor | undefined {
  const target = safeSessionPreviewTarget(value);
  if (!target) return undefined;
  return {
    path: sessionPreviewPath(sessionId),
    registeredAt: target.registeredAt,
  };
}

function probeOne(host: PreviewLoopbackHost, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    socket.unref?.();
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export type SessionPreviewProbeError =
  | 'invalid_port'
  /** 没有任何 loopback 地址上有人监听这个端口。 */
  | 'preview_unreachable'
  /** 有人在监听，但拿不到「属于本会话」的持有证明 → fail closed。 */
  | 'preview_owner_unverified';

export type SessionPreviewProbeResult =
  | { ok: true; target: SessionPreviewTarget }
  | { ok: false; error: SessionPreviewProbeError; reason?: PreviewPortOwnerFailure };

/**
 * Validate that a caller-selected port is reachable through a literal loopback
 * address AND held by a process inside this session's lineage. With no
 * requested host, IPv4 is preferred and IPv6 is a fallback so
 * `botmux preview <port>` works for either bind family.
 *
 * P1-12：可达性与归属是两件事，两件都必须成立才产出 target——connect 通过只说明
 * 「此刻这个号码上有人」，`resolvePreviewPortOwner` 才回答「那个人是不是本会话的
 * 进程」。归属拿不到时宁可没有预览，也不给出一条指向不明进程的代理路由。
 */
export async function probeSessionPreviewTarget(input: {
  port: number;
  host?: PreviewLoopbackHost;
  timeoutMs?: number;
  now?: () => Date;
  /** 会话血缘的根 pid（worker fork pid / CLI pid / adopt CLI pid）。 */
  ownerPids: Array<number | undefined>;
  /** 注册时的 worker 代次，随 target 落盘供后续 CAS 与换代清理比对。 */
  workerGeneration: number;
  /** 测试注入的假 procfs 根；生产恒为 '/proc'。 */
  procRoot?: string;
}): Promise<SessionPreviewProbeResult> {
  if (!isPreviewPort(input.port)) return { ok: false, error: 'invalid_port' };
  const timeoutMs = input.timeoutMs ?? PREVIEW_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return { ok: false, error: 'invalid_port' };
  const hosts: PreviewLoopbackHost[] = input.host ? [input.host] : ['127.0.0.1', '::1'];
  let ownerFailure: PreviewPortOwnerFailure | undefined;
  for (const host of hosts) {
    if (!await probeOne(host, input.port, timeoutMs)) continue;
    const owner = resolvePreviewPortOwner({
      host,
      port: input.port,
      ownerPids: input.ownerPids,
      ...(input.procRoot !== undefined ? { procRoot: input.procRoot } : {}),
    });
    if (!owner.ok) {
      ownerFailure = owner.reason;
      continue;
    }
    return {
      ok: true,
      target: {
        host,
        port: input.port,
        registeredAt: (input.now?.() ?? new Date()).toISOString(),
        owner: owner.proof,
        workerGeneration: input.workerGeneration,
      },
    };
  }
  return ownerFailure === undefined
    ? { ok: false, error: 'preview_unreachable' }
    : { ok: false, error: 'preview_owner_unverified', reason: ownerFailure };
}
