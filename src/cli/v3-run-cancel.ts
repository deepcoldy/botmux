/** Small testable transport seam for `botmux workflow cancel`. */

import {
  postWorkflowDaemonMutation,
  type WorkflowDaemonMutationResponse,
} from '../workflows/v3/daemon-ipc-client.js';

export interface V3RunCancelDaemonResult {
  ok: true;
  runId: string;
  status: 'cancelling' | 'cancelled' | 'succeeded' | 'failed';
  cancelRequestId?: string;
  alreadyRequested?: boolean;
  alreadyTerminal?: boolean;
}

export class V3RunCancelDaemonError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`cancel 失败 (HTTP ${status}): ${responseBody}`);
    this.name = 'V3RunCancelDaemonError';
  }
}

export type V3RunCancelCliOptions =
  | { ok: true; reason?: string; larkAppId?: string }
  | { ok: false; error: string };

/** Strict parser for the destructive cancel verb. Unknown/duplicate flags and
 * flag-shaped values fail before authority lookup or any durable mutation. */
export function parseV3RunCancelCliOptions(args: string[]): V3RunCancelCliOptions {
  let reason: string | undefined;
  let larkAppId: string | undefined;
  const seen = new Set<'reason' | 'bot'>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const matched = token === '--reason' || token.startsWith('--reason=')
      ? { key: 'reason' as const, flag: '--reason' }
      : token === '--bot' || token.startsWith('--bot=')
        ? { key: 'bot' as const, flag: '--bot' }
        : undefined;
    if (!matched) return { ok: false, error: `未知或多余参数：${token}` };
    if (seen.has(matched.key)) return { ok: false, error: `参数重复：${matched.flag}` };
    seen.add(matched.key);

    const raw = token === matched.flag
      ? args[++i]
      : token.slice(matched.flag.length + 1);
    if (raw === undefined || raw.startsWith('--') || !raw.trim()) {
      return { ok: false, error: `${matched.flag} 需要非空值` };
    }
    if (matched.key === 'reason') reason = raw.trim();
    else larkAppId = raw.trim();
  }
  return {
    ok: true,
    ...(reason ? { reason } : {}),
    ...(larkAppId ? { larkAppId } : {}),
  };
}

/** Validate a daemon cancel response regardless of which transport carried it
 * (signed-envelope host path or session relay). Throws V3RunCancelDaemonError
 * on HTTP failure or a malformed success body. */
export function parseV3RunCancelDaemonResponse(
  response: WorkflowDaemonMutationResponse,
): V3RunCancelDaemonResult {
  const text = response.bodyRaw;
  if (!response.ok) throw new V3RunCancelDaemonError(response.status, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new V3RunCancelDaemonError(response.status, 'daemon 返回了无法解析的成功响应');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok !== true) {
    throw new V3RunCancelDaemonError(response.status, 'daemon 返回了无效的成功响应');
  }
  const result = parsed as Partial<V3RunCancelDaemonResult>;
  if (
    typeof result.runId !== 'string' ||
    !['cancelling', 'cancelled', 'succeeded', 'failed'].includes(String(result.status))
  ) {
    throw new V3RunCancelDaemonError(response.status, 'daemon 成功响应缺少有效 runId/status');
  }
  return result as V3RunCancelDaemonResult;
}

export async function postV3RunCancel(input: {
  daemon: {
    larkAppId: string;
    ipcPort: number;
    bootInstanceId?: string;
    workflowIpcProtocol?: string;
  };
  runId: string;
  reason?: string;
  secret?: string;
  secretPath?: string;
  fetchImpl?: typeof fetch;
  timestamp?: string;
  nonce?: string;
}): Promise<V3RunCancelDaemonResult> {
  const response: WorkflowDaemonMutationResponse = await postWorkflowDaemonMutation({
    daemon: input.daemon,
    runId: input.runId,
    mutation: 'cancel',
    body: input.reason ? { reason: input.reason } : {},
    ...(input.secret ? { secret: input.secret } : {}),
    ...(input.secretPath ? { secretPath: input.secretPath } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    ...(input.nonce ? { nonce: input.nonce } : {}),
  });
  return parseV3RunCancelDaemonResponse(response);
}

export function formatV3RunCancelCliSuccess(result: V3RunCancelDaemonResult): string {
  if (result.alreadyTerminal) {
    return result.status === 'cancelled'
      ? `⏹️ v3 run "${result.runId}" 已取消。`
      : `ℹ️ v3 run "${result.runId}" 已是终态（${result.status}），未写入取消请求。`;
  }
  return result.alreadyRequested
    ? `⏳ v3 run "${result.runId}" 的取消请求已存在，正在收敛。`
    : `⏹️ v3 run "${result.runId}" 的取消请求已持久化，正在中断活动节点并收敛。`;
}
