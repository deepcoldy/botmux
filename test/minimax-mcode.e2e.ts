import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runMcodeExec } from '../src/services/mcode-exec.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';
import { collectNativePrint } from '../src/services/constrained-invocation/print-process.js';
import * as pty from '../src/utils/pty.js';
import { applySessionOwnerEnv } from '../src/utils/child-env.js';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import { createMinimaxAdapter } from '../src/adapters/cli/minimax.js';

const sandbox = process.env.BOTMUX_MCODE_SANDBOX_E2E === '1';
const executable = process.env.BOTMUX_MCODE_E2E_BIN;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(!executable)('real mcode: executes a shell tool, preserves owner and resumes exact native history', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mcode-native-'))); roots.push(root);
  const cwd = join(root, 'work'); const dataDir = join(root, 'data'); const home = join(root, 'home');
  for (const dir of [cwd, dataDir, home]) mkdirSync(dir, { mode: 0o700 });
  const requests: any[] = [];
  let toolSent = false;
  let nativeExecutable = executable!;
  const adapter = createMinimaxAdapter(executable!);
  const adapterArgs = adapter.buildArgs({ sessionId: 'mcode-native', resume: false, env: { MINIMAX_DATA_DIR: dataDir } });
  const nodeBin = adapterArgs.includes('--node-bin') ? adapterArgs[adapterArgs.indexOf('--node-bin') + 1] : undefined;
  const readonlyRoots = adapter.sandboxReadonlyPaths?.() ?? [];
  let cleanupSandbox: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const body = await readRequestBodyJson<any>(req);
    if (!body) { res.writeHead(400).end(); return; }
    requests.push(body);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'fixture ready' }, finish_reason: 'stop' }] })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = !toolSent && JSON.stringify(body.messages).includes('NATIVE_TOOL_TEST');
    if (tool) {
      toolSent = true;
      // Keep a real initialized native runtime/SQLite open beyond 90 seconds.
      if (sandbox) await new Promise(r => setTimeout(r, 95_000));
    }
    const deltas = tool ? [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'proof-call', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'printf mcode-tool-ok > proof.txt; printf "%s" "$BOTMUX_OWNER_OPEN_ID" > owner.txt'
          + (sandbox ? `; if test -w '${readonlyRoots[0]!.replace(/'/g, "'\\''")}'; then printf writable; else printf readonly; fi > sandbox-readonly.txt` : '') }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'NATIVE_MCODE_OK' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ];
    for (const delta of deltas) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', ...delta })}\n\n`);
    res.end('data: [DONE]\n\n');
  }); servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, HOME: home, MINIMAX_DATA_DIR: dataDir, MAVIS_DATA_DIR: dataDir,
    MCODE_PROVIDER_API_KEY: 'synthetic-local-only', BOTMUX_OWNER_OPEN_ID: 'ou_native_owner', __OWNER_OPEN_ID: 'ou_wrong' };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name as keyof typeof env];
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await collectNativePrint(executable!, ['provider', 'add', '--name', 'Fixture', '--base-url', url,
    '--api-format', 'openai-completions', '--model', 'fixture-model', '--use'], { cwd, env, input: '' }, AbortSignal.timeout(30_000));
  if (sandbox) {
    const canonicalRoot = realpathSync(root);
    expect(readonlyRoots.length).toBeGreaterThan(0);
    const plan = prepareDirectSandbox({ sessionId: 'mcode-native', dataDir: join(root, 'botmux'),
      policy: { rules: [
        { path: '/usr', access: 'readOnly', source: 'internal' },
        { path: '/etc', access: 'readOnly', source: 'internal' },
        { path: canonicalRoot, access: 'readWrite', source: 'internal' },
        ...readonlyRoots.map(path => ({ path: realpathSync(path), access: 'readOnly' as const, source: 'internal' as const })),
        ...(adapter.sandboxExtraExecPaths?.() ?? []).map(path => ({ path: dirname(realpathSync(path)), access: 'readOnly' as const, source: 'adapter' as const })),
        ...(adapter.authPaths ?? []).map(path => ({ path: realpathSync(path), access: 'readWrite' as const, source: 'adapter' as const })),
      ], net: true, writeRegexes: [] }, chdir: realpathSync(cwd), home: realpathSync(home),
      cliBin: nodeBin ?? realpathSync(executable!), cliArgs: nodeBin ? [realpathSync(executable!)] : [], tempDir: join(root, 'temp'),
    });
    expect(plan, 'file sandbox must be available for this opt-in native verification').not.toBeNull();
    cleanupSandbox = plan!.cleanup;
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    nativeExecutable = join(root, 'sandbox-mcode');
    writeFileSync(nativeExecutable, `#!/bin/sh\nexec ${[plan!.bin, ...plan!.args].map(quote).join(' ')} "$@" 2>${quote(join(root, 'sandbox-stderr.log'))}\n`, { mode: 0o700 });
    Object.assign(env, plan!.env);
  }
  const events: any[] = [];
  try {
  let first: { content: string; sessionId: string };
  if (sandbox) {
    // The adapter sandbox contract also requires a real PTY lifetime >90s.
    // Redirect native stdin from a file so PTY echo/EOF do not alter the input.
    const inputFile = join(root, 'prompt.txt');
    writeFileSync(inputFile, 'NATIVE_TOOL_TEST: create proof.txt using bash');
    applySessionOwnerEnv(env, env.BOTMUX_OWNER_OPEN_ID);
    const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const ptyCommand = [nativeExecutable, 'exec', '--input', '-', '--cwd', cwd,
      '--output-format', 'stream-json', '--permission', 'full', '--timeout', '150000ms'].map(shellQuote).join(' ');
    const terminal = pty.spawn('/bin/sh', ['-c', `exec ${ptyCommand} < ${shellQuote(inputFile)}`],
    { cwd, env: env as Record<string, string>, name: 'xterm-256color', cols: 120, rows: 40 });
    let transcript = '';
    terminal.onData(chunk => { transcript += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('native sandbox PTY timed out')); }, 160_000);
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0) resolve(); else reject(new Error(`native sandbox PTY exit ${exitCode}: ${transcript}`));
      });
    });
    for (const line of transcript.split(/\r?\n/).filter(line => line.trim())) events.push(JSON.parse(line));
    const completed = events.find(event => event.type === 'exec.completed')?.result;
    expect(completed?.status).toBe('succeeded');
    first = { content: completed.output, sessionId: completed.sessionId };
  } else {
    first = await runMcodeExec({ executable: nativeExecutable, cwd, env, content: 'NATIVE_TOOL_TEST: create proof.txt using bash',
      permission: 'full', timeoutMs: 30_000, onEvent: event => events.push(event) }, AbortSignal.timeout(40_000));
  }
  expect(first.content).toBe('NATIVE_MCODE_OK');
  expect(readFileSync(join(cwd, 'proof.txt'), 'utf8')).toBe('mcode-tool-ok');
  expect(readFileSync(join(cwd, 'owner.txt'), 'utf8')).toBe('ou_native_owner');
  if (sandbox) expect(readFileSync(join(cwd, 'sandbox-readonly.txt'), 'utf8')).toBe('readonly');
  expect(events.some(event => event.item?.type === 'tool_call')).toBe(true);
  expect(requests.some(req => req.tools?.some((tool: any) => tool.function?.name === 'bash'))).toBe(true);
  const before = requests.length;
  const second = await runMcodeExec({ executable: nativeExecutable, cwd, env, content: 'NATIVE_SECOND_TURN\nKeep prior history.',
    nativeSessionId: first.sessionId, permission: 'smart', timeoutMs: 30_000 }, AbortSignal.timeout(40_000));
  expect(second.sessionId).toBe(first.sessionId); expect(second.content).toBe('NATIVE_MCODE_OK');
  expect(JSON.stringify(requests.slice(before))).toContain('NATIVE_TOOL_TEST');
  expect(JSON.stringify(requests.slice(before))).toContain('NATIVE_SECOND_TURN');
  } catch (error) {
    const stderrPath = join(root, 'sandbox-stderr.log');
    if (sandbox && existsSync(stderrPath)) throw new Error(`${String(error)}: ${readFileSync(stderrPath, 'utf8')}`);
    throw error;
  } finally { cleanupSandbox?.(); }
}, sandbox ? 200_000 : 90_000);
