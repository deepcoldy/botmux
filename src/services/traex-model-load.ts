import { spawn } from 'node:child_process';
import { isCodexReasoningEffort, type CodexReasoningEffort } from './codex-reasoning-effort.js';

export interface TraexModelLoadSnapshot {
  loads: Map<string, number>;
  reasoningEfforts: Map<string, readonly CodexReasoningEffort[]>;
}

function publicModelIdentities(entry: Record<string, any>): string[] {
  return [entry.id, entry.model, entry.displayName]
    .filter((key): key is string => typeof key === 'string' && !!key.trim())
    .map(key => key.trim().toLowerCase());
}

/** Parse both queue capacity and the native model's supported reasoning
 * ladder from the same read-only model/list response. */
export function parseTraexModelLoadSnapshot(raw: unknown): TraexModelLoadSnapshot {
  const snapshot: TraexModelLoadSnapshot = { loads: new Map(), reasoningEfforts: new Map() };
  if (!raw || typeof raw !== 'object') return snapshot;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return snapshot;
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, any>;
    const identities = publicModelIdentities(entry);
    const percent = entry.businessMetadata?.load?.load_percent;
    if (Number.isInteger(percent) && percent >= 0 && percent <= 65_535) {
      for (const key of identities) snapshot.loads.set(key, percent);
    }
    const rawEfforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts
      : Array.isArray(entry.supported_reasoning_levels)
        ? entry.supported_reasoning_levels : [];
    const efforts = rawEfforts.flatMap((level: unknown) => {
      const candidate = typeof level === 'string' ? level
        : level && typeof level === 'object'
          ? (level as { reasoningEffort?: unknown; effort?: unknown }).reasoningEffort
            ?? (level as { effort?: unknown }).effort
          : undefined;
      return isCodexReasoningEffort(candidate) ? [candidate] : [];
    });
    if (efforts.length > 0) {
      const unique = [...new Set(efforts)];
      for (const key of identities) snapshot.reasoningEfforts.set(key, unique);
    }
  }
  return snapshot;
}

/** Public display identities only. Never match a provider routing code to an
 * allowlist entry: an alias must be advertised by the native model catalog. */
export function parseTraexModelLoads(raw: unknown): Map<string, number> {
  return parseTraexModelLoadSnapshot(raw).loads;
}

/**
 * Read-only native catalog request. It creates no thread/turn and sends no
 * inference prompt. Own and terminate the stdio helper; never start/restart
 * the user's shared daemon. Null means unavailable, never "zero load".
 */
export async function readTraexModelLoadSnapshot(input: {
  cliBin: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<TraexModelLoadSnapshot | null> {
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
    const snapshot: TraexModelLoadSnapshot = { loads: new Map(), reasoningEfforts: new Map() };
    const timeout = setTimeout(() => finish(null), input.timeoutMs ?? 8_000);
    function finish(result: TraexModelLoadSnapshot | null) {
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
          const pageSnapshot = parseTraexModelLoadSnapshot(message.result);
          for (const [key, value] of pageSnapshot.loads) snapshot.loads.set(key, value);
          for (const [key, value] of pageSnapshot.reasoningEfforts) snapshot.reasoningEfforts.set(key, value);
          const cursor = message.result?.nextCursor;
          if (typeof cursor === 'string' && cursor && !cursors.has(cursor)) {
            cursors.add(cursor); nextId += 1; page(cursor);
          }
          else finish(snapshot.loads.size || snapshot.reasoningEfforts.size ? snapshot : null);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'botmux-model-load', version: '1' },
      capabilities: { experimentalApi: true },
    } });
  });
}

export async function readTraexModelLoads(input: {
  cliBin: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<Map<string, number> | null> {
  const snapshot = await readTraexModelLoadSnapshot(input);
  return snapshot?.loads.size ? snapshot.loads : null;
}
