export interface DashboardAskAnswerRequest {
  askId: string;
  larkAppId: string;
  selections: string[][];
  by?: string;
}

export type DashboardAskAnswerParseResult =
  | { ok: true; value: DashboardAskAnswerRequest }
  | { ok: false; error: 'askId_larkAppId_and_selections_required' | 'invalid_selections' };

export interface DashboardAskAnswerProxyResult {
  status: number;
  contentType: string;
  body: string;
}

export function parseDashboardAskAnswerRequest(raw: unknown): DashboardAskAnswerParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'askId_larkAppId_and_selections_required' };
  }
  const body = raw as Record<string, unknown>;
  const askId = typeof body.askId === 'string' ? body.askId.trim() : '';
  const larkAppId = typeof body.larkAppId === 'string' ? body.larkAppId.trim() : '';
  if (!askId || !larkAppId || !Array.isArray(body.selections)) {
    return { ok: false, error: 'askId_larkAppId_and_selections_required' };
  }
  if (!body.selections.every(
    selection => Array.isArray(selection) && selection.every(key => typeof key === 'string'),
  )) {
    return { ok: false, error: 'invalid_selections' };
  }
  return {
    ok: true,
    value: {
      askId,
      larkAppId,
      selections: body.selections as string[][],
      ...(typeof body.by === 'string' ? { by: body.by } : {}),
    },
  };
}

export async function proxyDashboardAskAnswer(
  request: DashboardAskAnswerRequest,
  proxyToDaemon: (
    larkAppId: string,
    path: string,
    init: RequestInit,
  ) => Promise<Response>,
): Promise<DashboardAskAnswerProxyResult> {
  try {
    const upstream = await proxyToDaemon(request.larkAppId, '/api/asks/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        askId: request.askId,
        selections: request.selections,
        by: request.by ?? 'desktop',
      }),
    });
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') ?? 'application/json',
      body: await upstream.text(),
    };
  } catch {
    return {
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'daemon_unavailable' }),
    };
  }
}
