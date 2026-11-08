/** Owner-authenticated bridge for both phases of stopping a session.
 * Suspension preserves the session; exact interrupt ends only its current turn.
 * The daemon retains backend, ownership and worker-generation checks.
 */
export async function proxySessionStopControl(
  method: string | undefined,
  pathname: string,
  deps: {
    ownerOf(sessionId: string): string | undefined;
    proxyToDaemon(appId: string, route: string, init: RequestInit): Promise<Response>;
  },
): Promise<Response | null> {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/(suspend|turns\/([^/]+)\/interrupt)$/);
  if (method !== 'POST' || !match) return null;
  let sessionId: string, suffix: string;
  try {
    sessionId = decodeURIComponent(match[1]);
    suffix = match[2] === 'suspend' ? 'suspend' : `turns/${encodeURIComponent(decodeURIComponent(match[3]))}/interrupt`;
  }
  catch { return Response.json({ ok: false, error: 'invalid_identity' }, { status: 400 }); }
  const owner = deps.ownerOf(sessionId);
  if (!owner) return Response.json({ ok: false, error: 'unknown_session' }, { status: 404 });
  return deps.proxyToDaemon(owner,
    `/api/sessions/${encodeURIComponent(sessionId)}/${suffix}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}
