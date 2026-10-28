import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { isBunRuntime, spawnNodeTsScript } from './helpers/ts-runner.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { handleSkillFeedbackCardAction } from '../src/im/lark/skill-feedback-card.js';
import { RiffHostTools, RIFF_HOST_TOOLS_ROUTE, executeRiffHostTool, parseRiffHostRequest,
  type RiffHostContext, type RiffHostBinding } from '../src/services/riff-host-tools.js';
import { callRiffHostTool, installRiffHostBinding, prepareRiffHostRequest, maybeRunRiffHostTool, restoreRiffHostAttachments } from '../src/cli/riff-host-tools.js';
import { assertCardPatchChat } from '../src/cli/card-dispatch.js';

const roots: string[] = [], servers: Server[] = [];
function root(): string { const r = mkdtempSync(join(tmpdir(), 'riff-host-test-')); roots.push(r); return r; }
const request = (argv = ['project', 'status'], operationId = 'operation-0001') => ({ argv, operationId });
function context(dataDir = root(), overrides: Partial<RiffHostContext> = {}): RiffHostContext {
  return { sessionId: 'session-1', turnId: 'turn-1', dataDir, workingDir: dataDir, env: { ...process.env }, isCurrent: () => true, ...overrides };
}
async function listen(gateway: RiffHostTools): Promise<string> {
  const s = createServer((req, res) => { void gateway.handle(req, res); });
  servers.push(s);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}${RIFF_HOST_TOOLS_ROUTE}`;
}
async function post(binding: RiffHostBinding, body = request()): Promise<Response> {
  return fetch(binding.url, { method: 'POST', headers: { authorization: `Bearer ${binding.token}` }, body: JSON.stringify(body) });
}
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('Riff host boundary', () => {
  it.each(['session-file', 'receipt-file'])('still binds when receipt storage is a stale file: %s', mode => {
    const ctx = context(), session = join(ctx.dataDir, 'sessions', ctx.sessionId);
    mkdirSync(mode === 'session-file' ? join(ctx.dataDir, 'sessions') : session, { recursive: true });
    writeFileSync(mode === 'session-file' ? session : join(session, 'riff-host-operations'), 'stale');
    expect(new RiffHostTools().bind('http://host/api/riff-host-tools', ctx).turnId).toBe(ctx.turnId);
  });

  it('keeps maintenance failures out of task binding and protects execution across the fault matrix', async () => {
    // Node's syncBuiltinESMExports provides real fs fault injection. Bun does
    // not update named built-in exports through this API; use Node explicitly.
    const child = spawnNodeTsScript(fileURLToPath(new URL('./fixtures/riff-host-maintenance.ts', import.meta.url)),
      [root()], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    let code: number | null;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timeout); }
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { mode: 'mkdir', status: 400, executed: 0, removed: false },
      { mode: 'readdir', status: 429, executed: 0, removed: false },
      { mode: 'stat', status: 429, executed: 0, removed: false },
      { mode: 'read', status: 429, executed: 0, removed: false },
      { mode: 'rm', status: 429, executed: 0, removed: false },
      { mode: 'race', status: 200, executed: 1, removed: true },
    ]);
  });

  it.each(['oc_test', 'oc_elsewhere', '__missing__'])('enforces the chat boundary in the real card patch CLI: %s', async chatId => {
    const directory = root(), app = 'cli_test';
    mkdirSync(join(directory, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(directory, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId: 'session-1', turnId: 'turn-1', procStart: readProcessStartIdentity(process.pid),
    }));
    const bots = join(directory, 'bots.json');
    writeFileSync(bots, JSON.stringify([{ larkAppId: app, larkAppSecret: 'test', cliId: 'riff', backendType: 'riff' }]));
    seedPersistedSessionRows(directory, app, { 'session-1': {
      sessionId: 'session-1', larkAppId: app, status: 'active', pid: process.pid, cliId: 'riff', backendType: 'riff',
      chatId: 'oc_test', rootMessageId: 'om_root', chatType: 'group', scope: 'thread', workingDir: directory,
    } });
    const result = await executeRiffHostTool(request(['card', 'patch', '--message-id', 'om_patch', '--card-json',
      JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'updated' }] } })]),
    context(directory, { cliPath: fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url)),
      env: { ...process.env, BOTS_CONFIG: bots, BOTMUX_LARK_APP_ID: app, BOTMUX_CHAT_ID: 'oc_test',
        BOTMUX_ROOT_MESSAGE_ID: 'om_root', BOTMUX_LARK_TOOL_BINDING: undefined, BOTMUX_TEST_PATCH_CHAT_ID: chatId,
        ...(isBunRuntime() ? {} : { NODE_OPTIONS: `--import=${createRequire(import.meta.url).resolve('tsx')}` }) } }));
    if (chatId === 'oc_test') {
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('"method":"PATCH"');
    } else {
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('riff_host_message_outside_session');
      expect(result.stdout).not.toContain('CAPTURE_REPLY=');
    }
  }, 30_000);

  it('refuses cards from another chat and fails closed when lookup fails', async () => {
    await expect(assertCardPatchChat('cli_test', 'om_card', 'oc_here', async () => 'oc_here')).resolves.toBeUndefined();
    await expect(assertCardPatchChat('cli_test', 'om_card', 'oc_here', async () => 'oc_elsewhere')).rejects.toThrow('outside_session');
    await expect(assertCardPatchChat('cli_test', 'om_card', 'oc_here', async () => null)).rejects.toThrow('outside_session');
    await expect(assertCardPatchChat('cli_test', 'om_card', 'oc_here', async () => { throw new Error('lookup failed'); })).rejects.toThrow();
  });

  it('expires old-turn receipts while retaining current-turn replay protection', async () => {
    const ctx = context(), directory = join(ctx.dataDir, 'sessions', ctx.sessionId, 'riff-host-operations');
    mkdirSync(directory, { recursive: true });
    const old = join(directory, `${'a'.repeat(64)}.json`), current = join(directory, `${'b'.repeat(64)}.json`);
    writeFileSync(old, JSON.stringify({ turnId: 'previous-turn', fingerprint: 'a'.repeat(64) }));
    writeFileSync(current, JSON.stringify({ turnId: ctx.turnId, fingerprint: 'b'.repeat(64) }));
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    utimesSync(old, ancient, ancient); utimesSync(current, ancient, ancient);
    const gateway = new RiffHostTools(); gateway.bind(await listen(gateway), ctx);
    expect(readdirSync(directory)).toEqual([`${'b'.repeat(64)}.json`]);
  });

  it('refuses more receipts instead of evicting a current-turn operation, then reclaims prior turns', async () => {
    const ctx = context(), directory = join(ctx.dataDir, 'sessions', ctx.sessionId, 'riff-host-operations');
    mkdirSync(directory, { recursive: true });
    for (let i = 0; i < 1500; i++) writeFileSync(join(directory, `${i.toString(16).padStart(64, '0')}.json`),
      JSON.stringify({ turnId: ctx.turnId, fingerprint: 'c'.repeat(64) }));
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const gateway = new RiffHostTools(execute), url = await listen(gateway);
    const binding = gateway.bind(url, ctx);
    expect((await post(binding)).status).toBe(429);
    expect(readdirSync(directory)).toHaveLength(1500);
    expect(execute).not.toHaveBeenCalled();
    const next = gateway.bind(url, { ...ctx, turnId: 'next-turn' });
    expect((await callRiffHostTool(next, request())).stdout).toBe('ok');
    expect(readdirSync(directory).length).toBeLessThan(1500);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts send aliases and stream operations without allowing host paths', async () => {
    expect(parseRiffHostRequest(request(['send', 'body', '--voice', '--no-mention'])).argv).toContain('--voice');
    const path = join(root(), 'image.png'); writeFileSync(path, 'image');
    const r = await prepareRiffHostRequest(['send', 'body', '--image', path, '--no-mention'], async () => { throw new Error('unexpected stdin'); });
    expect(parseRiffHostRequest(r).files).toHaveLength(1);
    expect(parseRiffHostRequest(request(['card', 'stream', 'open', '--message-id', 'om_card'])).argv[2]).toBe('open');
    expect(parseRiffHostRequest(request(['whiteboard', 'status'])).argv[1]).toBe('status');
    expect(() => parseRiffHostRequest(request(['whiteboard', 'read', '--id', 'other']))).toThrow();
  });
  it('delivers through the real host send path, indexes feedback and accepts a click without resending', async () => {
    const directory = root(), dataDir = join(directory, 'data'), app = 'cli_test', turnId = 'om_turn_host';
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId: 'session-1', turnId, procStart: readProcessStartIdentity(process.pid),
    }));
    const bots = join(directory, 'bots.json');
    writeFileSync(bots, JSON.stringify([{ larkAppId: app, larkAppSecret: 'test-secret', cliId: 'riff',
      backendType: 'riff', replyCardMode: 'legacy', feedback: { enabled: true, audience: 'requester' } }]));
    seedPersistedSessionRows(dataDir, app, { 'session-1': {
      sessionId: 'session-1', larkAppId: app, status: 'active', pid: process.pid, cliId: 'riff', backendType: 'riff',
      chatId: 'oc_test', rootMessageId: 'om_root', chatType: 'group', scope: 'thread', workingDir: directory,
      replyTargets: { [turnId]: { senderOpenId: 'ou_requester', updatedAt: new Date().toISOString(),
        participants: [{ openId: 'ou_requester', isBot: false }] } },
    } });
    const env = { ...process.env, BOTMUX_LARK_TOOL_BINDING: undefined, BOTS_CONFIG: bots, BOTMUX_LARK_APP_ID: app,
      BOTMUX_CHAT_ID: 'oc_test', BOTMUX_ROOT_MESSAGE_ID: 'om_root', BOTMUX_SESSION_SCOPE: 'thread',
      ...(isBunRuntime() ? {} : { NODE_OPTIONS: `--import=${createRequire(import.meta.url).resolve('tsx')}` }) };
    const gateway = new RiffHostTools();
    const binding = gateway.bind(await listen(gateway), context(dataDir, { turnId, env,
      cliPath: fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url)) }));
    const argv = ['send', '--no-mention', '--response-kind', 'final', 'Riff answer'];
    const first = await callRiffHostTool(binding, request(argv));
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout.split('\n').filter(l => l.startsWith('CAPTURE_REPLY='))).toHaveLength(1);
    const replay = await callRiffHostTool(binding, request(argv, 'operation-0002'));
    expect(replay.exitCode, replay.stderr).toBe(0);
    expect(replay.stdout).not.toContain('CAPTURE_REPLY=');
    const store = await SkillFeedbackStore.open(dataDir);
    try {
      const delivery = store.findDeliveryByPlatformMessage('lark', app, 'om_separate_message');
      expect(delivery).toMatchObject({ sessionId: 'session-1', turnId, requesterSubjectId: 'ou_requester', policy: { enabled: true } });
      expect(delivery?.baseCard).toBeDefined();
      const click = await handleSkillFeedbackCardAction({ context: { open_message_id: 'om_separate_message' },
        operator: { open_id: 'ou_requester' }, action: { value: { action: 'feedback_submit', result: 'conclusive_usable' } } }, app, { store });
      expect(click.card).toBeDefined();
      expect(store.listFeedbackRevisions(delivery!.deliveryId, 'ou_requester')).toHaveLength(1);
    } finally { store.close(); }
  }, 30_000);

  it.each([
    ['send', '--session-id', 'other', 'body'], ['send', '--chat-id=oc_other', 'body'],
    ['schedule', 'add', 'every 1h', 'prompt', '--lark-app-id', 'other'],
    ['send', '--content-file', '/etc/passwd'], ['card', 'patch', '--card-file=/etc/passwd'],
    ['restart'], ['plugin', 'install', 'anything'], ['board', 'attach', '1', '/etc/passwd'],
  ])('rejects remote host path/identity/command selection: %j', (...argv) => {
    expect(() => parseRiffHostRequest(request(argv))).toThrow();
  });

  it('packs sandbox files and stdin without making host filenames authoritative', async () => {
    const path = join(root(), 'answer.md'); writeFileSync(path, '答案');
    const r = await prepareRiffHostRequest(['send', '--content-file', path, '--no-mention', '--response-kind', 'final'], async () => { throw new Error('unexpected stdin'); });
    expect(r.argv).toEqual(['send', '--content-file', 'riff-upload:0', '--no-mention', '--response-kind', 'final']);
    expect(Buffer.from(r.files![0]!.dataBase64, 'base64').toString()).toBe('答案');
    expect(parseRiffHostRequest(r).files).toHaveLength(1);
    const stdin = await prepareRiffHostRequest(['send', '--no-mention'], async () => 'heredoc');
    expect(stdin.stdin).toBe('heredoc');
  });

  it.each(['--voice', '--text', '--card'])('keeps the body after the boolean send flag %s', async flag => {
    const read = vi.fn(async () => { throw new Error('unexpected stdin'); });
    const prepared = await prepareRiffHostRequest(['send', flag, 'answer', '--no-mention'], read);
    expect(prepared.argv).toEqual(['send', flag, 'answer', '--no-mention']);
    expect(read).not.toHaveBeenCalled();
  });

  it('uploads stream stdin as content rather than selecting a host file', async () => {
    const read = vi.fn(async () => 'line 1\nline 2');
    const prepared = await prepareRiffHostRequest(['card', 'stream', 'write', '--stream-id', `cs_${'a'.repeat(32)}`,
      '--element-id', 'progress', '--content-file', '-'], read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(parseRiffHostRequest(prepared).argv.at(-1)).toBe('riff-upload:0');
    expect(Buffer.from(prepared.files![0]!.dataBase64, 'base64').toString()).toBe('line 1\nline 2');
  });

  it('pins schedule creation to the host session working directory and refuses a missing directory', async () => {
    const directory = root(), fixture = join(directory, 'schedule.mjs');
    writeFileSync(fixture, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const argv = ['schedule', 'add', 'every 1h', 'prompt'];
    const result = await executeRiffHostTool(request(argv), context(directory, { cliPath: fixture }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([...argv, '--workdir', directory]);
    await expect(executeRiffHostTool(request(argv), context(directory, { cliPath: fixture, workingDir: undefined })))
      .rejects.toThrow('working_directory_unavailable');
  });

  it('keeps quoted-message reads constrained to the authenticated session chat', async () => {
    const directory = root(), fixture = join(directory, 'quoted.mjs');
    writeFileSync(fixture, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const result = await executeRiffHostTool(request(['quoted', 'om_same_chat']), context(directory, { cliPath: fixture }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['quoted', 'om_same_chat', '--remote-runner-session-tool']);
  });

  it('routes ask/auth/project/board to host IPC using the frozen turn', async () => {
    const directory = root(), dataDir = join(directory, 'data'), app = 'cli_test', turnId = 'om_current';
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId: 'session-1', turnId, procStart: readProcessStartIdentity(process.pid),
    }));
    const bots = join(directory, 'bots.json');
    writeFileSync(bots, JSON.stringify([{ larkAppId: app, larkAppSecret: 'test', cliId: 'riff' }]));
    seedPersistedSessionRows(dataDir, app, { 'session-1': {
      sessionId: 'session-1', larkAppId: app, status: 'active', pid: process.pid, cliId: 'riff', backendType: 'riff',
      chatId: 'oc_test', rootMessageId: 'om_root', chatType: 'group', scope: 'chat', workingDir: directory,
    } });
    const observed: Array<{ path: string; body: any }> = [];
    const ipc = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { res.writeHead(400); res.end(); return; }
      observed.push({ path: req.url!, body });
      const response = req.url === '/api/asks'
        ? { kind: 'answered', answers: [['yes']], by: 'ou_requester' }
        : req.url?.endsWith('/auth-status') ? { ok: true, status: 'ready' }
          : req.url?.endsWith('/project') ? { ok: true, project: { title: 'host project' } }
            : { ok: true, items: [] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
    });
    servers.push(ipc);
    await new Promise<void>(r => ipc.listen(0, '127.0.0.1', r));
    mkdirSync(join(dataDir, 'dashboard-daemons'));
    writeFileSync(join(dataDir, 'dashboard-daemons', `${app}.json`), JSON.stringify({
      larkAppId: app, ipcPort: (ipc.address() as { port: number }).port, lastHeartbeat: Date.now(),
    }));
    const env = { ...process.env, BOTMUX_LARK_TOOL_BINDING: undefined, BOTS_CONFIG: bots, BOTMUX_LARK_APP_ID: app, BOTMUX_CHAT_ID: 'oc_test',
      BOTMUX_SESSION_SCOPE: 'chat', BOTMUX_ROOT_MESSAGE_ID: '',
      ...(isBunRuntime() ? {} : { NODE_OPTIONS: `--import=${createRequire(import.meta.url).resolve('tsx')}` }) };
    const gateway = new RiffHostTools();
    const binding = gateway.bind(await listen(gateway), context(dataDir, { turnId, env,
      cliPath: fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url)) }));
    for (const [index, argv] of [
      ['ask', 'buttons', '--options', 'yes,no', 'question'],
      ['auth', 'wait', '--request-id', 'request-1', '--json'],
      ['project', 'status'], ['board', 'list', '--json'],
    ].entries()) {
      const result = await callRiffHostTool(binding, request(argv, `operation-ipc-${index}`));
      expect(result.exitCode, result.stderr).toBe(0);
    }
    expect(observed.find(r => r.path === '/api/asks')?.body).toMatchObject({ sessionId: 'session-1', originTurnId: turnId, larkAppId: app, chatId: 'oc_test' });
    expect(observed.map(r => r.path)).toEqual(expect.arrayContaining([
      '/api/sessions/session-1/auth-status', '/api/sessions/session-1/project', '/api/sessions/session-1/decision-board',
    ]));
  }, 30_000);

  it('executes with the owning worker as its marker ancestor and private upload copies', async () => {
    const dataDir = root(), fixture = join(dataDir, 'fixture.mjs');
    mkdirSync(join(dataDir, '.botmux-cli-pids'));
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'session-1', turnId: 'turn-1' }));
    writeFileSync(fixture, `import fs from 'node:fs'; import path from 'node:path';
      const argv=process.argv.slice(2), i=argv.indexOf('--content-file');
      const marker=JSON.parse(fs.readFileSync(path.join(process.env.SESSION_DATA_DIR,'.botmux-cli-pids',String(process.ppid)),'utf8'));
      console.log(JSON.stringify({argv, content:fs.readFileSync(argv[i+1],'utf8'), marker,
        session:process.env.BOTMUX_SESSION_ID, turn:process.env.BOTMUX_TURN_ID, bridge:process.env.BOTMUX_RIFF_HOST_BINDING ?? null}));`);
    const result = await executeRiffHostTool({ ...request(['send', '--content-file', 'riff-upload:0', '--no-mention']),
      files: [{ name: 'body.md', dataBase64: Buffer.from('content').toString('base64') }] },
    context(dataDir, { cliPath: fixture, env: { ...process.env, BOTMUX_RIFF_HOST_BINDING: 'untrusted' } }));
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed).toMatchObject({ content: 'content', session: 'session-1', turn: 'turn-1', bridge: null,
      marker: { sessionId: 'session-1', turnId: 'turn-1' } });
    expect(observed.argv[2]).not.toBe('riff-upload:0');
  });

  it('runs once for concurrent/replayed requests and returns the original result after gateway replacement', async () => {
    let complete!: () => void;
    const gate = new Promise<void>(r => { complete = r; });
    const execute = vi.fn(async () => { await gate; return { exitCode: 0, stdout: 'registered-on-host', stderr: '' }; });
    const gateway = new RiffHostTools(execute), ctx = context();
    const binding = gateway.bind(await listen(gateway), ctx);
    expect((await post(binding)).status).toBe(202);
    expect((await post(binding)).status).toBe(202);
    expect(execute).toHaveBeenCalledTimes(1);
    const conflict = await post(binding, request(['project', 'close']));
    expect(conflict.status).toBe(409);
    complete();
    const result = await callRiffHostTool(binding, request());
    expect(result.stdout).toBe('registered-on-host');
    const replacement = new RiffHostTools(execute);
    const next = replacement.bind(await listen(replacement), ctx);
    expect((await callRiffHostTool(next, request())).stdout).toBe('registered-on-host');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale turn, a rotated token and a terminal/view token without executing', async () => {
    const execute = vi.fn(), gateway = new RiffHostTools(execute);
    let current = true;
    const url = await listen(gateway), ctx = context(undefined, { isCurrent: () => current });
    const old = gateway.bind(url, ctx);
    gateway.bind(url, { ...ctx, turnId: 'turn-2' });
    expect((await post(old)).status).toBe(403);
    expect((await post({ ...old, token: 'x'.repeat(43) })).status).toBe(403);
    current = false;
    expect((await post(old)).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists an unknown receipt before execution and never re-executes after a crash', async () => {
    const execute = vi.fn(() => new Promise<never>(() => {}));
    const gateway = new RiffHostTools(execute), ctx = context();
    const binding = gateway.bind(await listen(gateway), ctx);
    await post(binding);
    const replacement = new RiffHostTools(vi.fn());
    const next = replacement.bind(await listen(replacement), ctx);
    expect((await post(next)).status).toBe(409);
  });

  it('reconciles a lost POST response by GET without sending the command twice', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(Response.json({ state: 'completed', result: { exitCode: 0, stdout: 'ok', stderr: '' } }));
    const result = await callRiffHostTool({ url: 'http://localhost/host', token: 'token', sessionId: 's', turnId: 't' }, request(), fetcher);
    expect(result.stdout).toBe('ok');
    expect(fetcher.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET']);
  });

  it('restores quoted attachments without corrupting JSON or replacing unrelated text', () => {
    const placeholder = 'riff-attachment:0';
    const result = restoreRiffHostAttachments({ exitCode: 0, stderr: '',
      stdout: JSON.stringify({ content: placeholder, attachments: [{ path: placeholder }] }),
      attachments: [{ placeholder, name: 'quoted"file.txt', type: 'file', dataBase64: Buffer.from('quoted bytes').toString('base64') }],
    });
    const parsed = JSON.parse(result.stdout);
    roots.push(join(parsed.attachments[0].path, '..'));
    expect(parsed.content).toBe(placeholder);
    expect(readFileSync(parsed.attachments[0].path, 'utf8')).toBe('quoted bytes');
  });

  it('refuses a damaged operation receipt without executing again', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const gateway = new RiffHostTools(execute), ctx = context();
    const binding = gateway.bind(await listen(gateway), ctx);
    await callRiffHostTool(binding, request());
    const directory = join(ctx.dataDir, 'sessions', ctx.sessionId, 'riff-host-operations');
    writeFileSync(join(directory, readdirSync(directory)[0]!), 'null');
    const replay = await post(binding);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'riff_host_receipt_unreadable' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps local invocations local and refuses a missing enabled binding', async () => {
    expect(await maybeRunRiffHostTool(['project', 'status'], async () => '', {})).toBe(false);
    await expect(maybeRunRiffHostTool(['project', 'status'], async () => '', {
      BOTMUX_SESSION_ID: 'session-1', BOTMUX_RIFF_HOST_TOOLS: '1', SESSION_DATA_DIR: root(),
    })).rejects.toThrow();
  });

  it('does not activate an old binding without this invocation explicitly enabling host tools', async () => {
    const env = { BOTMUX_SESSION_ID: 'session-1', SESSION_DATA_DIR: root() };
    const binding = { sessionId: 'session-1', turnId: 'turn', token: 'a'.repeat(43), url: 'http://127.0.0.1:1/api/riff-host-tools' };
    installRiffHostBinding(Buffer.from(JSON.stringify(binding)).toString('base64url'), env);
    expect(await maybeRunRiffHostTool(['project', 'status'], async () => '', env)).toBe(false);
    expect(await maybeRunRiffHostTool(['project', 'status'], async () => '', { ...env, BOTMUX_RIFF_HOST_TOOLS: '0' })).toBe(false);
  });

  it('installs a binding only for its own app-injected session', () => {
    const env = { BOTMUX_SESSION_ID: 'session-1', SESSION_DATA_DIR: root() };
    const b = { sessionId: 'other', turnId: 'turn', token: 'a'.repeat(43), url: 'http://localhost/api/riff-host-tools' };
    expect(() => installRiffHostBinding(Buffer.from(JSON.stringify(b)).toString('base64url'), env)).toThrow();
    b.sessionId = 'session-1';
    installRiffHostBinding(Buffer.from(JSON.stringify(b)).toString('base64url'), env);
    const dir = join(env.SESSION_DATA_DIR, 'riff-host-bindings');
    expect(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8'))).toEqual(b);
  });
});
