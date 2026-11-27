/**
 * The real gateway (`runWecomCommand`) against a fake managed core that checks
 * every request's signature against the credential it was started with:
 *  - a saved change of the core settings reaches the running core, and the
 *    model the gateway records for a new task is the one the core runs: the
 *    new one once the core took it, the old one while the core refuses it;
 *  - the Dashboard sees the refusal (runtime record verdict on the file on disk);
 *  - every request to the core is signed with the credential of this start,
 *    and that credential appears in no log line, runtime record, generation
 *    file or state file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
import { readWecomRuntime } from '../src/im/wecom/config/runtime.js';
import { wecomFleetConfigHash } from '../src/im/wecom/config/fleet-members.js';
import { nativeGatewayCoreProfilePath, NATIVE_GATEWAY_ROUTE_PATTERNS } from '../src/core/native-gateway-contract.js';
import { requestWecomSessionControl } from '../src/dashboard/wecom/gateway-control-client.js';
import { loadDashboardSecret } from '../src/dashboard/auth.js';
import { dashboardSecretPath } from '../src/core/dashboard-secret.js';
import { createHash } from 'node:crypto';
import { spawnTsEval } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

const SECRET_ENV = 'PROFILE_WECOM_SECRET';
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeSocket extends EventEmitter {
  sent: Array<{ cmd?: string }> = [];
  send(data: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    callback?.();
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ headers: frame.headers, errcode: 0 }))));
  }
  terminate() {
    this.emit('close');
  }
  frame(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

/** A ready core that records each request and whether its signature verifies with its own credential. */
function fakeCore(root: string): string {
  return [
    "const { createServer } = await import('node:http');",
    "const { appendFileSync, existsSync, writeFileSync } = await import('node:fs');",
    "const { createHmac, timingSafeEqual } = await import('node:crypto');",
    `const root = ${JSON.stringify(root)};`,
    `const profilePath = ${JSON.stringify(nativeGatewayCoreProfilePath())};`,
    "const credential = process.env.BOTMUX_NATIVE_GATEWAY_CORE_CREDENTIAL ?? '';",
    // Test-only: the test needs the value to look for it where it must not be.
    "writeFileSync(root + '/fake-core-credential', credential);",
    'const port = Number(process.env.BOTMUX_API_PORT);',
    'const signed = (req, path) => {',
    "  const ts = req.headers['x-botmux-cli-ts'], nonce = req.headers['x-botmux-cli-nonce'], sig = req.headers['x-botmux-cli-auth'];",
    "  if (!credential || typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') return false;",
    "  const expected = createHmac('sha256', credential).update(ts + ':' + nonce + ':' + req.method + ' ' + path + ' ' + port).digest();",
    "  const provided = Buffer.from(sig, 'base64url');",
    '  return provided.length === expected.length && timingSafeEqual(provided, expected);',
    '};',
    'createServer((req, res) => {',
    "  let body = '';",
    "  req.on('data', chunk => { body += chunk; });",
    "  req.on('end', () => {",
    "    const url = new URL(req.url, 'http://127.0.0.1');",
    "    appendFileSync(root + '/fake-core-requests.jsonl', JSON.stringify({ method: req.method, path: url.pathname, signed: signed(req, url.pathname), body }) + '\\n');",
    "    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };",
    "    if (req.method === 'POST' && url.pathname === profilePath) {",
    "      return existsSync(root + '/reject-profile') ? reply(400, { ok: false, error: 'invalid_core_profile' }) : reply(200, { ok: true, changed: true });",
    '    }',
    '    reply(503, { ok: false });',
    '  });',
    "}).listen(port, '127.0.0.1', () => {",
    "  console.log('[core-only] listening on 127.0.0.1:' + port + ' (bot ' + process.env.BOTMUX_API_ONLY_BOT + ', cli ' + process.env.BOTMUX_CORE_CLI + ')');",
    '});',
  ].join('\n');
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('a running gateway and its managed core', () => {
  it('hands saved core settings to the core, records the model the core runs, and signs with this start\'s credential only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-gateway-profile-'));
    roots.push(root);
    const port = await reserveWecomCorePort();
    const botId = `profile-${process.pid}`;
    const file = join(root, 'config.json');
    const configWith = (model: string) => JSON.stringify({
      botId,
      secretEnv: SECRET_ENV,
      coreUrl: `http://127.0.0.1:${port}`,
      allowedUsers: ['alice', 'bob'],
      stateDir: root,
      managedCore: { botId: 'local_profile_gateway', cli: 'codex', backend: 'pty', model, port, workingDirectory: root, stateDir: join(root, 'core-state') },
    });
    writeFileSync(file, configWith('model-a'));
    vi.stubEnv(SECRET_ENV, 'fake-secret');
    const lines: string[] = [];
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    let socket: FakeSocket | undefined;
    const running = runWecomCommand(['--config', file], {
      drainBudgetMs: 500,
      socketFactory: () => {
        socket = new FakeSocket();
        return socket as never;
      },
      coreSpawn: (_command: string, _args: string[], options: SpawnOptions) => {
        const core = spawnTsEval(fakeCore(root), options);
        children.push(core);
        return core;
      },
    });
    await vi.waitFor(() => expect(socket?.listenerCount('open')).toBe(1), { timeout: 30_000, interval: 20 });
    socket!.emit('open');
    await vi.waitFor(() => expect(socket!.sent.some(frame => frame.cmd === 'aibot_subscribe')).toBe(true));
    const credential = readFileSync(join(root, 'fake-core-credential'), 'utf8');
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const requests = () => existsSync(join(root, 'fake-core-requests.jsonl'))
      ? readFileSync(join(root, 'fake-core-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; path: string; signed: boolean; body: string })
      : [];
    const pushedModels = () => requests()
      .filter(request => request.method === 'POST' && request.path === nativeGatewayCoreProfilePath())
      .map(request => JSON.parse(request.body).env.BOTMUX_CORE_MODEL);
    const taskModel = (userId: string) => {
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
      return (Object.values(state.tasks) as Array<{ message: { userId: string }; model?: string }>)
        .find(task => task.message.userId === userId)?.model;
    };
    const message = (id: string, userId: string) => socket!.frame({
      cmd: 'aibot_msg_callback',
      headers: { req_id: `callback-${id}` },
      body: { msgid: id, chattype: 'single', from: { userid: userId }, msgtype: 'text', text: { content: 'task' } },
    });

    // Taken: a new task records the model the core now runs.
    writeFileSync(file, configWith('model-b'));
    await vi.waitFor(() => expect(pushedModels()).toContain('model-b'), { timeout: 30_000, interval: 50 });
    message('m1', 'alice');
    await vi.waitFor(() => expect(taskModel('alice')).toBe('model-b'), { timeout: 30_000, interval: 50 });

    // Refused: the core keeps model-b, and so does the gateway; the Dashboard can tell.
    writeFileSync(join(root, 'reject-profile'), '');
    const refused = configWith('model-c');
    writeFileSync(file, refused);
    await vi.waitFor(() => expect(pushedModels()).toContain('model-c'), { timeout: 30_000, interval: 50 });
    await vi.waitFor(() => expect(readWecomRuntime(botId)?.coreProfile).toEqual({
      configHash: wecomFleetConfigHash(refused), outcome: 'retrying',
    }), { timeout: 30_000, interval: 50 });
    message('m2', 'bob');
    await vi.waitFor(() => expect(taskModel('bob')).toBe('model-b'), { timeout: 30_000, interval: 50 });

    // A Dashboard session action: the gateway proves the core's boot before acting.
    const control = readWecomRuntime(botId)!.control!;
    const outcome = await requestWecomSessionControl({
      port: control.port,
      instanceId: control.instanceId,
      coreIdentity: createHash('sha256').update(JSON.stringify([join(root, 'core-state'), 'local_profile_gateway'])).digest('hex'),
      sessionId: 'fixture-session',
      operation: 'suspend',
      requestId: 'fixture-request',
      expectedCoreBootId: 'fixture-boot',
    }, loadDashboardSecret(dashboardSecretPath())!);
    expect(outcome).toMatchObject({ ok: false, error: 'stale_core_boot' });
    expect(requests().some(request => request.path === NATIVE_GATEWAY_ROUTE_PATTERNS.sourceIdentity)).toBe(true);

    // While it runs: the runtime record, the core's generation record and the state file.
    const evidence = [...filesUnder(join(homedir(), '.botmux')), join(root, 'state.json')];
    expect(evidence.some(path => path.endsWith('runtime.json'))).toBe(true);
    expect(evidence.some(path => /managed-core-[a-f0-9]{64}\.json$/.test(path))).toBe(true);
    expect(evidence.filter(path => readFileSync(path, 'utf8').includes(credential))).toEqual([]);

    socket!.frame({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } });
    await running;

    const seen = requests();
    expect(seen.some(request => request.path === '/api/trigger')).toBe(true);
    expect(seen.filter(request => !request.signed)).toEqual([]);
    expect(lines.filter(line => line.includes(credential))).toEqual([]);
    expect(filesUnder(join(homedir(), '.botmux')).filter(path => readFileSync(path, 'utf8').includes(credential))).toEqual([]);
  }, 120_000);
});
