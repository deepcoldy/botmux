import { StringDecoder } from 'node:string_decoder';
import { spawnOwnedModelProcess } from './native-process.js';

/** Bounded, owned native print process. stdin is data, never command arguments. */
export async function collectNativePrint(executable: string, args: string[], runtime: {
  cwd: string; env: NodeJS.ProcessEnv; input: string; onLine?: (line: string) => void;
}, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const child = spawnOwnedModelProcess(executable, args, runtime);
  let bytes = 0;
  let output = '';
  let pending = '';
  let failure: Error | undefined;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const decoder = new StringDecoder('utf8');
  const kill = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
  };
  const fail = (error: Error) => {
    failure ??= error;
    kill('SIGTERM');
    hardKill ??= setTimeout(() => kill('SIGKILL'), 1000);
  };
  const abort = () => fail(new Error('invocation_aborted'));
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8_000_000) fail(new Error('native_output_limit'));
  };
  child.stdout.on('data', (chunk: Buffer) => {
    count(chunk);
    if (failure) return;
    const text = decoder.write(chunk); output += text;
    if (!runtime.onLine) return;
    pending += text;
    let end: number;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { runtime.onLine(line); } catch (error) { fail(error instanceof Error ? error : new Error('native_protocol_invalid')); break; }
    }
  });
  child.stderr.on('data', count);
  child.stdin.on('error', () => fail(new Error('native_transport_closed')));
  child.on('error', () => fail(new Error('native_spawn_failed')));
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort(); else child.stdin.end(runtime.input);
    const code = await exited;
    if (failure) throw failure;
    if (code !== 0) throw new Error('native_inference_failed');
    output += decoder.end();
    if (runtime.onLine && pending.trim()) runtime.onLine(pending);
    return output;
  } finally {
    signal.removeEventListener('abort', abort);
    if (hardKill) clearTimeout(hardKill);
  }
}
