import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import { config } from '../src/config.js';
import { prepareLarkToolEnv, larkToolBindingPath, type LarkToolBinding } from '../src/core/lark-tool-binding.js';
import { spawnTsScript } from './helpers/ts-runner.js';

let dir: string, previousDataDir: string, ipc: IpcServerHandle | undefined, session: any, binding: LarkToolBinding;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ipc-lark-tool-')); previousDataDir = config.session.dataDir; config.session.dataDir = dir;
  binding = prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: dir, sessionId: 'tool-session', appId: 'cli_bound' });
  session = {
    session: { sessionId: 'tool-session', status: 'active', replyTargets: { om_turn: { senderOpenId: 'ou_sender' } } },
    larkAppId: 'cli_bound', chatId: 'oc_chat', worker: { killed: false },
    managedTurnOrigin: { turnId: 'om_turn', capability: 'cap', callerOpenId: 'ou_sender' },
  };
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'tool-session' ? session : undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret' } } as any);
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue({ openId: 'ou_sender', type: 'user' } as any);
  vi.spyOn(tokens, 'resolveUserToken').mockResolvedValue('bound-user-token');
  setIpcAuthSecret('host-test-key');
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  await ipc?.close(); ipc = undefined; config.session.dataDir = previousDataDir;
  setIpcAuthSecret(null); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
});
async function request(mode: string, accessKey = binding.accessKey) {
  return fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/lark-tool-identity`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': accessKey },
    body: JSON.stringify({ mode }),
  });
}
describe('session application identity route', () => {
  it('binds bot and current user without requiring triggerUserAuth configuration', async () => {
    const bot = await request('bot'); const raw = await bot.text();
    expect(bot.status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true, appId: 'cli_bound', mode: 'bot', credential: 'bound-secret' });
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    const user = await request('user');
    expect(await user.json()).toEqual({ ok: true, appId: 'cli_bound', mode: 'user', credential: 'bound-user-token' });
    expect(tokens.resolveUserToken).toHaveBeenCalledWith('cli_bound', 'bound-secret', 'feishu', 'ou_sender');
  });
  it('rejects another session key and an application mismatch', async () => {
    expect((await request('bot', '00'.repeat(32))).status).toBe(403);
    session.larkAppId = 'cli_other';
    expect((await request('bot')).status).toBe(403);
  });
  it('uses the same user path on macOS without process attestation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appId: 'cli_bound', mode: 'user', credential: 'bound-user-token' });
  });
  it('authorizes the same app on macOS through the installed session entry', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(identities, 'getIdentity').mockReturnValue({ openId: 'ou_sender', type: 'user', source: 'sender' } as any);
    const poll = vi.fn(async () => ({ status: 'ready' as const, token: 'authorized-token' }));
    vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({ authUrl: 'https://example.com/app-authorization',
      scopes: ['sheets:spreadsheet:read'], expiresIn: 300, poll });
    const post = (action: string, body: object) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey }, body: JSON.stringify(body),
    });
    const response = await post('auth-request', { scopes: ['sheets:spreadsheet:read'] });
    expect(response.status).toBe(200);
    const request = await response.json() as { requestId: string };
    expect(tokens.requestUserAuthorization).toHaveBeenCalledWith('cli_bound', 'bound-secret', 'feishu',
      ['sheets:spreadsheet:read'], 'ou_sender', expect.any(Function));
    const ready = await post('auth-status', { requestId: request.requestId });
    expect(await ready.json()).toEqual({ ok: true, status: 'ready' });
  });
  it('requires the current user’s grant and never uses the machine account', async () => {
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    expect(await (await request('user')).json()).toMatchObject({ ok: false, error: expect.stringContaining('cli_bound') });
    session.managedTurnOrigin.callerOpenId = undefined;
    vi.mocked(tokens.resolveUserToken).mockClear();
    expect((await request('user')).status).toBe(403);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    expect((await request('bot')).status).toBe(200);
  });
  it('does not return a credential when the user resolver crosses a turn boundary', async () => {
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => { session.managedTurnOrigin.turnId = 'om_later'; return 'wrong-turn-token'; });
    const response = await request('user');
    expect(response.status).toBe(409); expect(await response.text()).not.toContain('wrong-turn-token');
  });
  it('runs the real tool process with only the selected application credentials', async () => {
    const real = join(dir, 'real-lark');
    writeFileSync(real, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$LARKSUITE_CLI_APP_ID" "$LARKSUITE_CLI_APP_SECRET" "$LARKSUITE_CLI_USER_ACCESS_TOKEN" "$*"\n'); chmodSync(real, 0o755);
    binding.realBinary = real; writeFileSync(larkToolBindingPath(dir, 'tool-session'), JSON.stringify(binding), { mode: 0o600 });
    const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawnTsScript(join(process.cwd(), 'src/lark-tool-runner.ts'), ['--binding', larkToolBindingPath(dir, 'tool-session'), '--', ...args], {
        env: { ...process.env, BOTMUX_DAEMON_IPC_PORT: String(ipc!.port), LARKSUITE_CLI_APP_ID: 'cli_wrong', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'wrong-user' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = ''; child.stdout!.on('data', b => out += b); child.stderr!.on('data', b => err += b);
      child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
    });
    const bot = await run(['docs', '+fetch']); expect(bot.code, bot.err).toBe(0);
    expect(bot.out).toBe('cli_bound|bound-secret||docs +fetch --as bot');
    const user = await run(['docs', '+fetch', '--as=user']); expect(user.code, user.err).toBe(0);
    expect(user.out).toBe('cli_bound||bound-user-token|docs +fetch --as user');
  });
});
