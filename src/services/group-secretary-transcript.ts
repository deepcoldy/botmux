/**
 * 群秘书取证：经本机 daemon IPC 读某个会话最近几条对话（insight conversation，
 * 已由 services/insight 做脱敏投影，raw 命令与输出不进结构）。
 *
 * 只对本机 daemon 有效；拿不到（会话不存在、daemon 离线、超时、CLI 无 transcript）
 * 时返回 undefined，由调用方按「没有证据」处理，绝不回退旧缓存。
 */
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';

export interface SecretaryTranscriptLine {
  role: string;
  text: string;
}

const TIMEOUT_MS = 5_000;
const MAX_LINE_CHARS = 600;

async function getJson(port: number, path: string, secret: string | undefined): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetchDaemonIpc(port, path, { signal: controller.signal }, secret);
    if (!res.ok) return undefined;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function pickTranscriptLines(messages: unknown, limit: number): SecretaryTranscriptLine[] {
  if (!Array.isArray(messages)) return [];
  const out: SecretaryTranscriptLine[] = [];
  for (const m of messages) {
    const text = typeof m?.text === 'string' ? m.text.trim() : '';
    if (!text) continue;
    const role = typeof m?.role === 'string' ? m.role : 'unknown';
    out.push({ role, text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text });
  }
  return out.slice(-limit);
}

export async function fetchSessionRecentTranscript(
  larkAppId: string | undefined,
  sessionId: string,
  limit = 4,
): Promise<SecretaryTranscriptLine[] | undefined> {
  if (!larkAppId) return undefined;
  try {
    const daemon = listOnlineDaemons().find(d => d.larkAppId === larkAppId);
    if (!daemon) return undefined;
    let secret: string | undefined;
    try { secret = loadDaemonIpcSecret(); } catch { secret = undefined; }
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/insight?detail=conversation`;
    const head = await getJson(daemon.ipcPort, `${base}&offset=0&limit=1`, secret);
    const total = Number(head?.conversation?.total);
    if (!head?.ok || !Number.isFinite(total) || total <= 0) return undefined;
    // 多取几条：工具调用等没有正文的条目会被过滤掉。
    const window = Math.max(limit * 10, 40);
    const tail = await getJson(daemon.ipcPort, `${base}&offset=${Math.max(0, total - window)}&limit=${window}`, secret);
    if (!tail?.ok) return undefined;
    const lines = pickTranscriptLines(tail.conversation?.messages, limit);
    return lines.length ? lines : undefined;
  } catch {
    return undefined;
  }
}
