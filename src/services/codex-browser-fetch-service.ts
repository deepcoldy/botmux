/** Runs only in the installed Codex runtime's trusted process. Authentication,
 * destination restrictions and token refresh remain owned by that runtime. */
interface FetchMessage {
  url: string;
  method: string;
  headers: [string, string][];
  body?: string;
}

export async function handleRpc(request: { method: string; params: FetchMessage }): Promise<unknown> {
  if (request.method !== 'fetch') throw new Error('Unsupported browser fetch operation');
  const runtime = (globalThis as unknown as { nodeRepl: { fetch: typeof fetch } }).nodeRepl;
  const { url, method, headers, body } = request.params;
  const response = await runtime.fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: Buffer.from(body, 'base64') }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: Buffer.from(await response.arrayBuffer()).toString('base64'),
  };
}
