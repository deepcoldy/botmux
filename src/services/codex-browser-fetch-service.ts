import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** Keep handleRpc self-contained: its compiled function body is embedded by
 * static import, then materialized for the separate trusted runtime process.
 * Never pass a checkout or Bun virtual filesystem path to that process. */
export function materializeBrowserFetchService(): { path: string; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'botmux-browser-fetch-'));
  const path = join(directory, 'codex-browser-fetch-service.mjs');
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    writeFileSync(path, `export const handleRpc = ${handleRpc.toString()};\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    return { path, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
