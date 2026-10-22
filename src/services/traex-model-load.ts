import { spawn } from 'node:child_process';

/** Public display identities only. Never match a provider routing code to an
 * allowlist entry: an alias must be advertised by the native model catalog. */
export function parseTraexModelLoads(raw: unknown): Map<string, number> {
  const loads = new Map<string, number>();
  if (!raw || typeof raw !== 'object') return loads;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return loads;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const metadata = entry.businessMetadata;
    const percent = metadata?.load?.load_percent;
    if (!Number.isInteger(percent) || percent < 0 || percent > 65_535) continue;
    for (const key of [entry.id, entry.model, entry.displayName]) {
      if (typeof key === 'string' && key.trim()) loads.set(key.trim().toLowerCase(), percent);
    }
  }
  return loads;
}

/**
 * Read-only native catalog request. It creates no thread/turn and sends no
 * inference prompt. Own and terminate the stdio helper; never start/restart
 * the user's shared daemon. Null means unavailable, never "zero load".
 */
export async function readTraexModelLoads(input: {
  cliBin: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<Map<string, number> | null> {
  return new Promise(resolve => {
    const child = spawn(input.cliBin, ['app-server', '--listen', 'stdio://'], {
      env: input.env, cwd: input.cwd, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    let bytes = 0;
    let buffer = '';
    let pages = 0;
    const cursors = new Set<string>();
    let nextId = 2;
    const loads = new Map<string, number>();
    const timeout = setTimeout(() => finish(null), 8_000);
    function finish(result: Map<string, number> | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill('SIGTERM');
      const reap = setTimeout(() => child.kill('SIGKILL'), 1_000);
      reap.unref();
      child.once('exit', () => clearTimeout(reap));
      resolve(result);
    }
    function send(value: object) {
      if (!settled) child.stdin.write(`${JSON.stringify(value)}\n`, error => {
        if (error) finish(null);
      });
    }
    function page(cursor?: string) {
      pages += 1;
      send({ id: nextId, method: 'model/list', params: {
        includeHidden: true, forceRefresh: pages === 1, limit: 100,
        ...(cursor ? { cursor } : {}),
      } });
    }
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (settled || bytes > 8 * 1024 * 1024) { finish(null); return; }
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) { finish(null); return; }
          send({ method: 'initialized', params: {} });
          page();
        } else if (message.id === nextId) {
          if (message.error) { finish(null); return; }
          for (const [key, value] of parseTraexModelLoads(message.result)) loads.set(key, value);
          const cursor = message.result?.nextCursor;
          if (typeof cursor === 'string' && cursor && !cursors.has(cursor)) {
            cursors.add(cursor); nextId += 1; page(cursor);
          }
          else finish(loads.size ? loads : null);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'botmux-model-load', version: '1' },
      capabilities: { experimentalApi: true },
    } });
  });
}
