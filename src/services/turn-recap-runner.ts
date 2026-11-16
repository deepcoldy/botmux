/**
 * Runs the optional「本轮回顾」model recap in the worker: one print-mode call
 * of the session's own CLI (CliAdapter.recapModel), prompt on stdin, JSON on
 * stdout, bounded in time and output size.
 */
import { spawn } from 'node:child_process';
import { parseRecapModelOutput, type RecapModelResult } from './turn-recap.js';

/** Real calls took 3-45 s. */
export const RECAP_MODEL_TIMEOUT_MS = 120_000;
const STDOUT_MAX_BYTES = 1 << 20;

export interface RecapModelLaunch {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/** How the optional model recap runs for a CLI just spawned: its own binary
 * and env, outside any terminal. Only a plain local CLI qualifies — not one
 * in a sandbox or read isolation (its transcript stays inside), under the
 * host's mandatory credential isolation (no local process runs unconfined
 * there), behind a wrapper (the wrapper owns the launch), adopted, or on
 * another backend. */
export function recapModelLaunchFor(cli: {
  recapModel?: { args(systemPrompt: string): string[]; readonly env: Readonly<Record<string, string>> };
  systemPrompt: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  backend: string;
  sandboxed: boolean;
  readIsolated: boolean;
  wrapped: boolean;
  adopted: boolean;
  credentialIsolated: boolean;
}): RecapModelLaunch | undefined {
  if (!cli.recapModel || cli.sandboxed || cli.readIsolated || cli.credentialIsolated || cli.wrapped || cli.adopted) return undefined;
  if (cli.backend !== 'pty' && cli.backend !== 'tmux') return undefined;
  return {
    bin: cli.bin,
    args: cli.recapModel.args(cli.systemPrompt),
    env: { ...cli.env, ...cli.recapModel.env },
    ...(cli.cwd ? { cwd: cli.cwd } : {}),
  };
}

export function runRecapModel(
  launch: RecapModelLaunch,
  prompt: string,
  timeoutMs = RECAP_MODEL_TIMEOUT_MS,
): Promise<RecapModelResult | { error: string }> {
  return new Promise(resolve => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const child = spawn(launch.bin, launch.args, {
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      env: launch.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const finish = (outcome: RecapModelResult | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const stop = (error: string) => {
      child.kill('SIGKILL');
      finish({ error });
    };
    const timer = setTimeout(() => stop(`no answer in ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    timer.unref?.();
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_MAX_BYTES) stop('output too large');
      else chunks.push(chunk);
    });
    child.on('error', error => finish({ error: error.message }));
    child.on('close', () => finish(parseRecapModelOutput(Buffer.concat(chunks).toString('utf8'))));
    child.stdin!.on('error', () => { /* an early exit is reported by 'close' */ });
    child.stdin!.end(prompt);
  });
}
