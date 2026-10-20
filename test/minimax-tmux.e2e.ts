import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { createMinimaxAdapter } from '../src/adapters/cli/minimax.js';
import { collectNativePrint } from '../src/services/constrained-invocation/print-process.js';
import { applySessionOwnerEnv } from '../src/utils/child-env.js';
import { normalizeFinalUsage } from '../src/services/codex-app-runner-protocol.js';

const executable = process.env.BOTMUX_MCODE_E2E_BIN;
const enabled = !!executable && process.env.BOTMUX_MCODE_TMUX_E2E === '1';

it.skipIf(!enabled)('real mcode through tmux pipe: tools, owner, usage and exact resume after runner rebuild', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mcode-tmux-')));
  const cwd = join(root, 'work'); const home = join(root, 'home'); const dataDir = join(root, 'data');
  for (const dir of [cwd, home, dataDir]) mkdirSync(dir, { mode: 0o700 });
  // Own only this session; never kill the shared server or touch daemon panes.
  const sessionName = `bmx-mcode-check-${randomUUID().slice(0, 8)}`;
  const requests: any[] = [];
  let tools = 0;
  const server = createServer(async (req, res) => {
    const body = await readRequestBodyJson<any>(req);
    if (!body) { res.writeHead(400).end(); return; }
    requests.push(body);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'fixture ready' }, finish_reason: 'stop' }] }));
      return;
    }
    const history = JSON.stringify(body.messages);
    const tool = tools === 0 && history.includes('TMUX_FIRST_TURN') ? 'first'
      : tools === 1 && history.includes('TMUX_SECOND_TURN') ? 'resume' : undefined;
    if (tool) tools++;
    const deltas = tool ? [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `${tool}-call`, type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: tool === 'first'
          ? 'printf tmux-tool-ok > proof.txt; printf "%s" "$BOTMUX_OWNER_OPEN_ID" > owner.txt'
          : 'cat proof.txt > resume.txt' }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'TMUX_MCODE_OK' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of deltas) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', ...delta })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  let backend: TmuxPipeBackend | undefined;
  let transcript = '';
  const records = () => [...transcript.matchAll(/\x1b\]777;botmux:(\w+):([A-Za-z0-9+/=]+)\x07/g)]
    .map(match => ({ kind: match[1], payload: JSON.parse(Buffer.from(match[2], 'base64').toString()) }));
  const waitFor = async (check: () => boolean, timeout = 40_000) => {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw new Error(`tmux runner timed out: ${transcript.slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    // Explicit environment keeps real provider credentials and daemon keys out.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(),
      MINIMAX_DATA_DIR: dataDir, MAVIS_DATA_DIR: dataDir, MCODE_PROVIDER_API_KEY: 'synthetic-local-only' };
    applySessionOwnerEnv(env, 'ou_tmux_fixture_owner');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    await collectNativePrint(executable!, ['provider', 'add', '--name', 'Fixture', '--base-url', url,
      '--api-format', 'openai-completions', '--model', 'fixture-model', '--use'],
    { cwd, env, input: '' }, AbortSignal.timeout(30_000));
    const adapter = createMinimaxAdapter(executable!);
    const start = async (nativeSessionId?: string) => {
      transcript = '';
      backend = new TmuxPipeBackend(sessionName, { createSession: true, ownsSession: true });
      backend.onData(data => { transcript += data; });
      const args = adapter.buildArgs({ sessionId: sessionName, workingDir: cwd, env,
        resume: !!nativeSessionId, resumeSessionId: nativeSessionId });
      if (nativeSessionId) expect(args[args.indexOf('--native-session-id') + 1]).toBe(nativeSessionId);
      backend.spawn(adapter.resolvedBin, args, { cwd, env, cols: 120, rows: 40, strictEnv: true });
      // Startup may precede pipe-pane subscription. Check the pane for ready;
      // turn/final records must come through the daemon's actual raw pipe path.
      await waitFor(() => TmuxBackend.hasSession(sessionName)
        && execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], { encoding: 'utf8', timeout: 5000 }).includes('runner ready'));
    };
    const send = async (content: string, turnId: string) => {
      const result = await adapter.writeInput(backend!, content, { turnId });
      expect(result?.submitted).toBe(true);
      await waitFor(() => records().some(record => record.kind === 'final' && record.payload.turnId === turnId));
      const final = records().find(record => record.kind === 'final' && record.payload.turnId === turnId)!.payload;
      expect(final.content).toBe('TMUX_MCODE_OK');
      expect(normalizeFinalUsage(final.usage)).toBeTruthy();
    };
    await start();
    await send('TMUX_FIRST_TURN: use bash to create proof.txt and owner.txt', 'first');
    expect(readFileSync(join(cwd, 'proof.txt'), 'utf8')).toBe('tmux-tool-ok');
    expect(readFileSync(join(cwd, 'owner.txt'), 'utf8')).toBe('ou_tmux_fixture_owner');
    const nativeSessionId = records().find(record => record.kind === 'thread')?.payload.threadId;
    expect(nativeSessionId).toBeTruthy();
    const before = requests.length;
    backend!.destroySession();
    await waitFor(() => !TmuxBackend.hasSession(sessionName), 5000);
    await start(nativeSessionId);
    await send('TMUX_SECOND_TURN: use bash to copy proof.txt to resume.txt', 'second');
    // The restored thread marker is emitted at boot, before pipe subscription;
    // the explicit ID above and prior model history below prove exact restore.
    expect(readFileSync(join(cwd, 'resume.txt'), 'utf8')).toBe('tmux-tool-ok');
    expect(JSON.stringify(requests.slice(before))).toContain('TMUX_FIRST_TURN');
    expect(JSON.stringify(requests.slice(before))).toContain('TMUX_SECOND_TURN');
    expect(tools).toBe(2);
  } finally {
    backend?.destroySession();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
