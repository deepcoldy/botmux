/**
 * Pending ask-hooks over the dashboard bridge (aggregated from daemons).
 */
import type { DashboardEndpoint } from './botmux-dashboard-client'

export type BridgePendingAsk = {
  askId: string
  sessionId: string
  larkAppId: string
  chatId: string
  rootMessageId: string | null
  botName?: string
  questions: Array<{
    prompt: string
    multiSelect: boolean
    options: Array<{ key: string; label: string }>
  }>
  deadlineAt: number
  createdAt: number
  hostId: string
  hostLabel: string
}

function authHeaders(token: string | null): Record<string, string> {
  if (!token) return {}
  return {
    Cookie: `botmux_dashboard_token=${token}`,
    Authorization: `Bearer ${token}`
  }
}

export async function fetchPendingAsks(
  endpoint: DashboardEndpoint,
  host: { hostId: string; hostLabel: string }
): Promise<
  | { ok: true; asks: BridgePendingAsk[] }
  | { ok: false; reason: string; message: string }
> {
  const url = new URL('/api/asks/pending', endpoint.baseUrl)
  if (endpoint.token) url.searchParams.set('t', endpoint.token)
  let res: Response
  try {
    res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', ...authHeaders(endpoint.token) }
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      message: error instanceof Error ? error.message : 'unreachable'
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: 'http_error',
      message: `GET /api/asks/pending → ${res.status}`
    }
  }
  const body = (await res.json().catch(() => ({}))) as { asks?: unknown[] }
  const asks: BridgePendingAsk[] = []
  for (const raw of body.asks ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    if (typeof a.askId !== 'string' || typeof a.sessionId !== 'string') continue
    asks.push({
      askId: a.askId,
      sessionId: a.sessionId,
      larkAppId: typeof a.larkAppId === 'string' ? a.larkAppId : '',
      chatId: typeof a.chatId === 'string' ? a.chatId : '',
      rootMessageId: typeof a.rootMessageId === 'string' ? a.rootMessageId : null,
      botName: typeof a.botName === 'string' ? a.botName : undefined,
      questions: Array.isArray(a.questions) ? (a.questions as BridgePendingAsk['questions']) : [],
      deadlineAt: typeof a.deadlineAt === 'number' ? a.deadlineAt : 0,
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0,
      hostId: host.hostId,
      hostLabel: host.hostLabel
    })
  }
  return { ok: true, asks }
}

export async function answerPendingAsk(
  endpoint: DashboardEndpoint,
  args: {
    askId: string
    selections: string[][]
    larkAppId?: string
    by?: string
  }
): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const url = new URL('/api/asks/answer', endpoint.baseUrl)
  if (endpoint.token) url.searchParams.set('t', endpoint.token)
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        ...authHeaders(endpoint.token)
      },
      body: JSON.stringify({
        askId: args.askId,
        selections: args.selections,
        larkAppId: args.larkAppId,
        by: args.by ?? 'desktop'
      })
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      message: error instanceof Error ? error.message : 'unreachable'
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      reason: 'answer_failed',
      message: text.slice(0, 200) || `HTTP ${res.status}`
    }
  }
  return { ok: true }
}
