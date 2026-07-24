import { fetchDaemonIpc } from '../../core/daemon-ipc-auth.js';
import { findOnlineDaemon } from '../../utils/daemon-discovery.js';
import type { CodexNotifierOutboxItem } from './outbox.js';
import type { CodexNotifierDisposition } from './outbox-worker.js';

export interface CodexNotifierEmitterDeps {
  findDaemon?: typeof findOnlineDaemon;
  fetchDaemon?: typeof fetchDaemonIpc;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 通过 Host HMAC 把 outbox 事件交给入队时选定的 Bot daemon。 */
export async function emitCodexNotifierOutboxItem(
  item: CodexNotifierOutboxItem,
  deps: CodexNotifierEmitterDeps = {},
): Promise<CodexNotifierDisposition> {
  const daemon = (deps.findDaemon ?? findOnlineDaemon)(item.targetBotAppId);
  if (!daemon) throw new Error(`target_daemon_offline:${item.targetBotAppId}`);
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? 15_000);
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, timeoutSignal])
    : timeoutSignal;
  const response = await (deps.fetchDaemon ?? fetchDaemonIpc)(
    daemon.ipcPort,
    '/api/codex-notifier/events',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
      signal,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`daemon_emit_failed:${response.status}:${text.slice(0, 300)}`);
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('daemon_emit_response_invalid');
  }
  if (body?.status !== 'accepted' && body?.status !== 'duplicate') {
    throw new Error('daemon_emit_disposition_invalid');
  }
  return body.status;
}
