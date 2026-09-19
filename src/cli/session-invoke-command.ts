import { readFileSync } from 'node:fs';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { parseInvocation } from '../services/constrained-invocation/contract.js';

const USAGE = `botmux session invoke <start|result|cancel|capabilities> --bot <id> [--json]
  start --request-file <path> [--wait-ms <milliseconds>]
  result --request-id <id> [--wait-ms <milliseconds>]
  cancel --request-id <id>
The request deadline cancels native inference. --wait-ms only limits CLI waiting.`;

export function parseInvokeArgs(args: readonly string[]) {
  const operation = args[0];
  if (!['start', 'result', 'cancel', 'capabilities'].includes(operation)) throw new Error(USAGE);
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === '--json') continue;
    if (!['--bot', '--request-file', '--request-id', '--wait-ms'].includes(key) || flags[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(USAGE);
    flags[key] = args[++i];
  }
  if (!flags['--bot']) throw new Error('--bot is required');
  if (operation === 'start' && (!flags['--request-file'] || flags['--request-id'])) throw new Error(USAGE);
  if (operation !== 'start' && flags['--request-file']) throw new Error(USAGE);
  if (['result', 'cancel'].includes(operation) && !/^[A-Za-z0-9_-]{1,128}$/.test(flags['--request-id'] ?? '')) throw new Error('invalid_request_id');
  if (operation === 'capabilities' && flags['--request-id']) throw new Error(USAGE);
  const waitMs = Number(flags['--wait-ms'] ?? 0);
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 300_000 || (waitMs && !['start', 'result'].includes(operation))) throw new Error('invalid_wait_ms');
  return { operation, bot: flags['--bot'], requestFile: flags['--request-file'], requestId: flags['--request-id'], waitMs };
}
export async function cmdSessionInvoke(args: readonly string[]): Promise<number> {
  try {
    const parsed = parseInvokeArgs(args);
    const daemon = findOnlineDaemon(parsed.bot, resolveBotmuxDataDir());
    if (!daemon) throw new Error('daemon_not_online');
    let requestId = parsed.requestId;
    const base = '/api/headless/invocations';
    let path = base;
    let method = 'GET';
    let body: string | undefined;
    if (parsed.operation === 'start') {
      const request = parseInvocation(JSON.parse(readFileSync(parsed.requestFile, 'utf8')));
      requestId = request.requestId;
      method = 'POST'; body = JSON.stringify(request);
    } else if (parsed.operation === 'capabilities') path += '/capabilities';
    else {
      path += `/${encodeURIComponent(requestId)}`;
      if (parsed.operation === 'cancel') { path += '/cancel'; method = 'POST'; }
    }
    const call = async (target: string, verb = 'GET', data?: string) => {
      const response = await fetchDaemonIpc(daemon.ipcPort, target, {
        method: verb, body: data, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      const value = await response.json() as any;
      if (!response.ok) throw new Error(value.error ?? `HTTP_${response.status}`);
      return value;
    };
    let result = await call(path, method, body);
    const end = Date.now() + parsed.waitMs;
    while (result.result?.state === 'running' && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
      result = await call(`${base}/${encodeURIComponent(requestId)}`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.result && !['running', 'completed'].includes(result.result.state) ? 1 : 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'invocation_failed' })}\n`);
    return 1;
  }
}
