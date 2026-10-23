import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectNativePrint } from '../src/services/constrained-invocation/print-process.js';
import { runMcodeExec } from '../src/services/mcode-exec.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const executable = process.env.BOTMUX_MCODE_E2E_BIN;
const enabled = !!executable && process.env.BOTMUX_MCODE_LONG_E2E === '1';
// Opt-in real time coverage of the former 600-second ceiling. Keep the normal
// unit/e2e legs fast; an accelerated fake timer cannot establish native policy.
const PROBE_DURATION_MS = 610_000;

async function probe(resume: boolean): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mcode-long-')));
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  for (const dir of [cwd, home, dataDir]) mkdirSync(dir, { mode: 0o700 });
  const streams = new Set<ReturnType<typeof setInterval>>();
  let longRequests = 0;
  let streamedChunks = 0;
  let streamElapsedMs = 0;
  const server = createServer(async (req, res) => {
    const body = await readRequestBodyJson<any>(req);
    if (!body) { res.writeHead(400).end(); return; }
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }));
      return;
    }
    const long = JSON.stringify(body.messages).includes('LONG_EXEC_PROBE');
    if (long) ++longRequests;
    res.setHeader('content-type', 'text/event-stream');
    const chunk = (content: string, finish: boolean) => res.write(`data: ${JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model',
      choices: [{ index: 0, delta: { content }, finish_reason: finish ? 'stop' : null }],
    })}\n\n`);
    if (!long) { chunk('SEED_OK', true); res.end('data: [DONE]\n\n'); return; }
    const startedAt = performance.now();
    chunk('LONG_BEGIN', false);
    // Stream real model deltas throughout the measured interval, then release
    // the completion. This exercises native exec, not a mock ACP subprocess.
    const timer = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= PROBE_DURATION_MS) {
        streamElapsedMs = elapsed;
        clearInterval(timer); streams.delete(timer);
        chunk('LONG_EXEC_OK', true); res.end('data: [DONE]\n\n');
      } else {
        ++streamedChunks; chunk('.', false);
        if (streamedChunks % 60 === 0) console.info(JSON.stringify({
          probe: 'native-exec-progress', resume, streamElapsedMs: elapsed, streamedChunks,
        }));
      }
    }, 1000);
    streams.add(timer);
    res.once('close', () => { clearInterval(timer); streams.delete(timer); });
  });
  let child: ReturnType<typeof spawnTsScript> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const env = { ...process.env, HOME: home, MINIMAX_DATA_DIR: dataDir, MAVIS_DATA_DIR: dataDir,
      MCODE_PROVIDER_API_KEY: 'synthetic-local-only' };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete env[name as keyof typeof env];
    }
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    await collectNativePrint(executable!, ['provider', 'add', '--name', 'Fixture', '--base-url', url,
      '--api-format', 'openai-completions', '--model', 'fixture-model', '--use'],
    { cwd, env, input: '' }, AbortSignal.timeout(30_000));
    const seed = resume ? await runMcodeExec({ executable: executable!, cwd, env,
      content: 'SEED', permission: 'full' }, AbortSignal.timeout(30_000)) : undefined;
    child = spawnTsScript(resolve('src/minimax-runner.ts'), ['--mcode-bin', executable!,
      '--cwd', cwd, '--data-dir', dataDir, '--transport', 'exec',
      ...(seed ? ['--native-session-id', seed.sessionId] : [])], { env });
    closed = new Promise(r => child!.once('close', r));
    let stdout = ''; let stderr = '';
    child.stderr!.on('data', data => { stderr += data.toString(); });
    const startedAt = performance.now();
    const final = await new Promise<Record<string, any>>((resolveFinal, reject) => {
      const timer = setTimeout(() => reject(new Error(`exec probe deadline: ${stderr}`)), PROBE_DURATION_MS + 60_000);
      const onClose = () => { clearTimeout(timer); reject(new Error(`runner exited before final: ${stderr}`)); };
      child!.once('close', onClose);
      child!.stdout!.on('data', data => {
        stdout += data.toString();
        const marker = stdout.match(/\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/);
        if (!marker) return;
        clearTimeout(timer); child!.off('close', onClose);
        resolveFinal(JSON.parse(Buffer.from(marker[1], 'base64').toString()));
      });
      child!.stdin!.write(`::botmux-minimax:${Buffer.from(JSON.stringify({ type: 'message',
        content: 'LONG_EXEC_PROBE', replyTurnId: 'long-exec' })).toString('base64')}\n`);
    });
    expect(final.errorCode).toBeUndefined();
    expect(final.turnId).toBe('long-exec');
    expect(final.content).toMatch(/^LONG_BEGIN\.+LONG_EXEC_OK$/);
    expect(longRequests).toBe(1); // retries must not conceal a native timeout
    expect(streamElapsedMs).toBeGreaterThanOrEqual(PROBE_DURATION_MS);
    expect(streamedChunks).toBeGreaterThan(0);
    const thread = stdout.match(/\x1b\]777;botmux:thread:([A-Za-z0-9+/=]+)\x07/);
    expect(thread).not.toBeNull();
    if (seed) expect(JSON.parse(Buffer.from(thread![1], 'base64').toString()).threadId).toBe(seed.sessionId);
    console.info(JSON.stringify({ probe: 'native-exec-long', runtime: process.versions.bun ? 'bun' : 'node',
      resume, elapsedMs: performance.now() - startedAt, streamElapsedMs, streamedChunks, longRequests }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const kill = setTimeout(() => child!.kill('SIGKILL'), 5000);
      child.kill('SIGTERM'); await closed; clearTimeout(kill);
    }
    for (const timer of streams) clearInterval(timer);
    await new Promise<void>(r => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(!enabled)('real mcode exec crosses ten minutes without a turn budget, fresh and resumed', async () => {
  const results = await Promise.allSettled([probe(false), probe(true)]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}, PROBE_DURATION_MS + 120_000);
