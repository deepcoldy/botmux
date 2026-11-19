import { spawn } from 'node:child_process';
import { isCodexReasoningEffort, type CodexReasoningEffort } from './codex-reasoning-effort.js';

export interface TraexModelLoadSnapshot {
  loads: Map<string, number>;
  reasoningEfforts: Map<string, readonly CodexReasoningEffort[]>;
  /** Present only after a valid, nonempty catalog has been read to its end.
   * Absence is inconclusive, never evidence that a model was removed. */
  catalogModels?: ReadonlySet<string>;
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
 *
 * `onUnavailable` receives why a read returned null: how far the helper got
 * before a timeout, or which protocol step failed. Only fixed labels, exit
 * codes and error codes — never helper output, paths or environment.
 */
export async function readTraexModelLoadSnapshot(input: {
  cliBin: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUnavailable?: (reason: string) => void;
}): Promise<TraexModelLoadSnapshot | null> {
  if (input.signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const startedAtMs = Date.now();
    const child = spawn(input.cliBin, ['app-server', '--listen', 'stdio://'], {
      env: input.env, cwd: input.cwd, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    let bytes = 0;
    let buffer = '';
    let pages = 0;
    let stage = 'helper started, no reply yet';
    const cursors = new Set<string>();
    let nextId = 2;
    const snapshot: TraexModelLoadSnapshot = { loads: new Map(), reasoningEfforts: new Map() };
    const catalogModels = new Set<string>();
    const timeoutMs = input.timeoutMs ?? 8_000;
    const timeout = setTimeout(() => fail(`timed out after ${timeoutMs}ms (${stage})`), timeoutMs);
    function fail(reason: string) {
      if (settled) return;
      input.onUnavailable?.(`${reason}; ${Date.now() - startedAtMs}ms after launch`);
      finish(null);
    }
    function finish(result: TraexModelLoadSnapshot | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      child.stdin.end();
      child.kill('SIGTERM');
      const reap = setTimeout(() => child.kill('SIGKILL'), 1_000);
      reap.unref();
      child.once('exit', () => clearTimeout(reap));
      resolve(result);
    }
    function onAbort() { fail('aborted'); }
    function send(value: object) {
      if (!settled) child.stdin.write(`${JSON.stringify(value)}\n`, error => {
        if (error) fail(`stdin write failed (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
      });
    }
    function page(cursor?: string) {
      pages += 1;
      stage = `waiting for model/list page ${pages}`;
      send({ id: nextId, method: 'model/list', params: {
        includeHidden: true, forceRefresh: pages === 1, limit: 100,
        ...(cursor ? { cursor } : {}),
      } });
    }
    child.on('error', error => fail(`helper failed to start (${(error as NodeJS.ErrnoException).code ?? 'error'})`));
    child.on('exit', (code, signal) => fail(`helper exited (code=${code}, signal=${signal}) while ${stage}`));
    child.stdin.on('error', error => fail(`stdin failed (${(error as NodeJS.ErrnoException).code ?? 'error'})`));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (settled) return;
      if (bytes > 8 * 1024 * 1024) { fail('response exceeded 8 MiB'); return; }
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) { fail('initialize returned an error'); return; }
          send({ method: 'initialized', params: {} });
          page();
        } else if (message.id === nextId) {
          if (message.error) { fail(`model/list page ${pages} returned an error`); return; }
          const data = message.result?.data;
          if (!Array.isArray(data) || data.some((entry: unknown) =>
            !entry || typeof entry !== 'object' || Array.isArray(entry)
            || publicModelIdentities(entry as Record<string, any>).length === 0)) {
            fail(`model/list page ${pages} was malformed`); return;
          }
          for (const entry of data) {
            for (const identity of publicModelIdentities(entry)) catalogModels.add(identity);
          }
          const pageSnapshot = parseTraexModelLoadSnapshot(message.result);
          for (const [key, value] of pageSnapshot.loads) snapshot.loads.set(key, value);
          for (const [key, value] of pageSnapshot.reasoningEfforts) snapshot.reasoningEfforts.set(key, value);
          const cursor = message.result?.nextCursor;
          if (cursor !== undefined && cursor !== null
            && (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || pages >= 100)) {
            fail(`model/list page ${pages} had an invalid or repeated cursor`); return;
          }
          if (typeof cursor === 'string' && cursor) {
            cursors.add(cursor); nextId += 1; page(cursor);
          }
          else if (catalogModels.size > 0) finish({ ...snapshot, catalogModels });
          else fail('model/list returned an empty catalog');
        }
      }
    });
    input.signal?.addEventListener('abort', onAbort, { once: true });
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
