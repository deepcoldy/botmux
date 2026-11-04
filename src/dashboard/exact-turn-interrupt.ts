/** Owner-authenticated Dashboard bridge to the daemon's exact-turn interrupt.
 * The daemon still checks the live trigger and worker generation atomically.
 */
export async function proxyExactTurnInterrupt(
  method: string | undefined,
  pathname: string,
  deps: {
    ownerOf(sessionId: string): string | undefined;
    proxyToDaemon(appId: string, route: string, init: RequestInit): Promise<Response>;
  },
): Promise<Response | null> {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/interrupt$/);
  if (method !== 'POST' || !match) return null;
  let sessionId: string, triggerId: string;
  try { sessionId = decodeURIComponent(match[1]); triggerId = decodeURIComponent(match[2]); }
  catch { return Response.json({ ok: false, error: 'invalid_identity' }, { status: 400 }); }
  const owner = deps.ownerOf(sessionId);
  if (!owner) return Response.json({ ok: false, error: 'unknown_session' }, { status: 404 });
  return deps.proxyToDaemon(owner,
    `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(triggerId)}/interrupt`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}
