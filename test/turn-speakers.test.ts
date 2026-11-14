import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { chooseTurnSpeaker } from '../src/core/turn-speakers.js';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { forgetProvenIdentityContent, renderIdentityWrapper, writeSessionIdentity } from '../src/core/cli-identity.js';
import { prepareLarkToolEnv, type LarkToolBinding } from '../src/core/lark-tool-binding.js';
import { parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as larkClient from '../src/im/lark/client.js';
import * as bytedcliAuth from '../src/services/bytedcli-auth.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { config } from '../src/config.js';
import type { TrustedCaller } from '../src/types.js';

const human = (openId: string): TrustedCaller => ({ requestUserOpenId: openId, requestLarkAppId: 'cli_turn', senderType: 'user' });

describe('turn speakers on the active turn authority', () => {
  it('keeps every human whose message joined the turn, the first one included, ', () => {
    const authority = new ActiveTurnAuthority();
    expect(authority.reserve({ turnId: 'm1', caller: human('ou_first') })).toBe(true);
    authority.markStarted({ turnId: 'm1', caller: human('ou_first') });
    authority.adoptEnvelopePreservingPrincipal({ turnId: 'm2', caller: human('ou_second') });
    expect(authority.speakers()).toEqual([{ openId: 'ou_first', turnId: 'm1' }, { openId: 'ou_second', turnId: 'm2' }]);
    // The first speaker's identity stays the turn's principal; a repeat speaker moves to the end.
    expect(authority.identity().caller?.requestUserOpenId).toBe('ou_first');
    authority.adoptEnvelopePreservingPrincipal({ turnId: 'm3', caller: human('ou_first') });
    expect(authority.speakers()).toEqual([{ openId: 'ou_second', turnId: 'm2' }, { openId: 'ou_first', turnId: 'm3' }]);
  });
  it('pairs a speaker restored from a marker with its own message turn, not the envelope turn', () => {
    // The marker names the preserved principal (A) under a later envelope turn (B's) and keeps A's turn as identityTurnId.
    const reserved = new ActiveTurnAuthority();
    reserved.reserve({ turnId: 'mB', identityTurnId: 'mA', caller: human('ou_a') });
    expect(reserved.speakers()).toEqual([{ openId: 'ou_a', turnId: 'mA' }]);
    const started = new ActiveTurnAuthority();
    started.reserve({ turnId: 'm0', caller: human('ou_a') });
    started.markStarted({ turnId: 'mB', identityTurnId: 'mA', caller: human('ou_a') });
    expect(started.speakers()).toEqual([{ openId: 'ou_a', turnId: 'mA' }]);
  });
  it('starts over with the next turn and never counts bots or schedules as speakers', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'm1', caller: { ...human('ou_bot'), senderType: 'bot' } });
    expect(authority.speakers()).toEqual([]);
    authority.clear();
    authority.reserve({ turnId: 'm2', caller: { ...human('ou_owner'), source: 'schedule_creator', taskId: 't' } });
    expect(authority.speakers()).toEqual([]);
  });
  it('defaults to the turn principal whatever the speakers, and accepts only a named speaker otherwise', () => {
    const a = { openId: 'ou_a', turnId: 'm1' }, b = { openId: 'ou_b', turnId: 'm2' };
    expect(chooseTurnSpeaker(a, [a, b], undefined)).toEqual({ ok: true, speaker: a });
    expect(chooseTurnSpeaker(a, [b, a], undefined)).toEqual({ ok: true, speaker: a });
    expect(chooseTurnSpeaker(a, undefined, undefined)).toEqual({ ok: true, speaker: a });
    expect(chooseTurnSpeaker(undefined, [a, b], undefined)).toEqual({ ok: true });
    expect(chooseTurnSpeaker(a, [a, b], 'ou_b')).toEqual({ ok: true, speaker: b });
    expect(chooseTurnSpeaker(a, [a, b], 'ou_x')).toEqual({ ok: false });
    expect(chooseTurnSpeaker(a, undefined, 'ou_a')).toEqual({ ok: false });
  });
});

describe('BOTMUX_AS on the identity routes', () => {
  let dir: string, previousDataDir: string, ipc: IpcServerHandle, session: any, binding: LarkToolBinding;
  const SECOND_TURN = 'om_second';
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'turn-speakers-')); previousDataDir = config.session.dataDir; config.session.dataDir = dir;
    binding = prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: dir, sessionId: 'speaker-session', appId: 'cli_turn' });
    session = {
      session: { sessionId: 'speaker-session', status: 'active', backendType: 'pty' },
      larkAppId: 'cli_turn', chatId: 'oc_group', chatType: 'group', workerGeneration: 7, worker: { pid: process.pid, killed: false },
      reportedIdentityModel: { model: 'proven', sandboxEngaged: false, loopbackShared: true, workerPid: process.pid, workerGeneration: 7, reportedAt: 1 },
      localProcessAttestation: { backendType: 'pty', workerGeneration: 7, cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
      managedTurnOrigin: {
        capability: 'ca'.repeat(32), turnId: SECOND_TURN, identityTurnId: 'om_first', callerOpenId: 'ou_first',
        speakers: [{ openId: 'ou_first', turnId: 'om_first' }, { openId: 'ou_second', turnId: SECOND_TURN }],
        preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`],
      },
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'speaker-session' ? session : undefined);
    vi.spyOn(bots, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_turn', larkAppSecret: 's', brand: 'feishu',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['bytecloud'], credentialSource: 'local', allowSpeakerSwitch: true }) } } as any);
    writeSessionIdentity(dir, 'speaker-session', { tool: 'bytedcli', cloudJwt: 'jwt-first', turnId: 'om_first', openId: 'ou_first' }, 'proven');
    writeSessionIdentity(dir, 'speaker-session', { tool: 'bytedcli', cloudJwt: 'jwt-second', turnId: SECOND_TURN, openId: 'ou_second' }, 'proven');
    setIpcAuthSecret('host-test-key');
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  });
  afterEach(async () => {
    await ipc.close(); config.session.dataDir = previousDataDir; setIpcAuthSecret(null); vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const fetchIdentity = (as?: string) => fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'speaker-session', tool: 'bytedcli', ...(as ? { as } : {}) }),
  });

  it('keeps running as the person who started the turn after a second speaker merged in', async () => {
    const response = await fetchIdentity();
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('jwt-first');
    expect(text).not.toContain('jwt-second');
  });
  it('runs as the first speaker when BOTMUX_AS names them, and as the second when it names the second', async () => {
    expect(JSON.stringify(await (await fetchIdentity('ou_first')).json())).toContain('jwt-first');
    expect(JSON.stringify(await (await fetchIdentity('ou_second')).json())).toContain('jwt-second');
  });
  it('refuses a person who did not speak in the turn', async () => {
    const response = await fetchIdentity('ou_stranger');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: 'blocked', reason: 'as_not_speaker' });
  });
  it('without a per-person policy the turn keeps its own principal and BOTMUX_AS is refused', async () => {
    for (const triggerUserAuth of [undefined, parseTriggerUserAuthConfig({ enabled: false, capabilities: ['bytecloud'] })]) {
      vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_turn', larkAppSecret: 's', brand: 'feishu', triggerUserAuth } } as any);
      expect(JSON.stringify(await (await fetchIdentity()).json())).toContain('jwt-first');
      const named = await fetchIdentity('ou_second');
      expect(named.status).toBe(403);
      expect(await named.json()).toMatchObject({ reason: 'as_unavailable' });
    }
  });
  it('refuses BOTMUX_AS from a caller outside the current execution (a detached background job)', async () => {
    session.localProcessAttestation.cliPid = 1;
    const response = await fetchIdentity('ou_first');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: 'blocked' });
  });
  it('answers a named speaker whose material is gone like the default path does', async () => {
    forgetProvenIdentityContent(dir, 'speaker-session', 'om_first');
    const response = await fetchIdentity('ou_first');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'identity_material_unavailable' });
  });
  it('refuses BOTMUX_AS on every route while the speaker switch is off, and still resolves the principal', async () => {
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_turn', larkAppSecret: 's', brand: 'feishu',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['bytecloud'], credentialSource: 'local' }) } } as any);
    expect(JSON.stringify(await (await fetchIdentity()).json())).toContain('jwt-first');
    const named = await fetchIdentity('ou_second');
    expect(named.status).toBe(403);
    expect(await named.json()).toMatchObject({ reason: 'as_unavailable' });
    const authRequest = await fetch(`http://127.0.0.1:${ipc.port}/api/sessions/speaker-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ provider: 'bytedcli', as: 'ou_second' }),
    });
    expect(authRequest.status).toBe(403);
    expect(await authRequest.json()).toMatchObject({ error: 'as_unavailable' });
  });
  it('refuses a speaker when the capability is off for the bot', async () => {
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_turn', larkAppSecret: 's', brand: 'feishu',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'], credentialSource: 'local', allowSpeakerSwitch: true }) } } as any);
    const response = await fetchIdentity('ou_first');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'as_unavailable' });
  });
  it('refuses BOTMUX_AS in an unattended schedule turn, which has no speakers', async () => {
    const turn = 'schedule:task1:11111111-1111-4111-8111-111111111111';
    session.managedTurnOrigin = { ...session.managedTurnOrigin, turnId: turn, identityTurnId: turn, speakers: undefined };
    writeSessionIdentity(dir, 'speaker-session', { tool: 'bytedcli', cloudJwt: 'jwt-owner', turnId: turn, openId: 'ou_first' }, 'proven');
    const named = await fetchIdentity('ou_first');
    expect(named.status).toBe(403);
    expect(await named.json()).toMatchObject({ reason: 'as_unavailable' });
    expect(JSON.stringify(await (await fetchIdentity()).json())).toContain('jwt-owner');
  });
  it('sends the authorization entry for a speaker without credentials to that speaker only', async () => {
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_reply' as any);
    vi.spyOn(bytedcliAuth, 'describeBytedcliAuth').mockResolvedValue({ state: 'needs-login' });
    vi.spyOn(bytedcliAuth, 'beginBytedcliLogin').mockResolvedValue({ authUrl: 'https://cloud.example/device?code=SECOND' } as any);
    const authRequest = (as?: string) => fetch(`http://127.0.0.1:${ipc.port}/api/sessions/speaker-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ provider: 'bytedcli', ...(as ? { as } : {}) }),
    });
    const stranger = await authRequest('ou_stranger');
    expect(stranger.status).toBe(403);
    expect(dm).not.toHaveBeenCalled();
    // Unspecified: the entry goes to the turn principal, not the later speaker.
    expect((await authRequest()).status).toBe(200);
    expect(dm).toHaveBeenCalledTimes(1);
    expect(dm.mock.calls[0].slice(0, 2)).toEqual(['cli_turn', 'ou_first']);
    const response = await authRequest('ou_second');
    expect(response.status).toBe(200);
    expect(dm).toHaveBeenCalledTimes(2);
    expect(dm.mock.calls[1].slice(0, 2)).toEqual(['cli_turn', 'ou_second']);
    expect(dm.mock.calls[1][2]).toContain('https://cloud.example/device?code=SECOND');
  });
});

describe('wrappers that cannot run a call as another speaker', () => {
  const run = (script: string, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'as-wrapper-'));
    try {
      const path = join(dir, 'wrapper');
      writeFileSync(path, script, { mode: 0o755 });
      return spawnSync('sh', [path, 'version'], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it('refuses BOTMUX_AS in the native bytedcli passthrough and still runs the real tool without it', () => {
    const script = renderIdentityWrapper('bytedcli', '/bin/echo', 'proven', ['/bin/false'], { bytecloud: true });
    const refused = run(script, { BOTMUX_AS: 'ou_x' });
    expect(refused.status).toBe(77);
    expect(refused.stderr).toContain('BOTMUX_AS');
    const plain = run(script, {});
    expect(plain.status).toBe(0);
    expect(plain.stdout.trim()).toBe('version');
  });
  it('refuses BOTMUX_AS in the file-based wrapper of a single-model session', () => {
    const refused = run(renderIdentityWrapper('lark-cli', '/bin/echo', 'single'), { BOTMUX_AS: 'ou_x' });
    expect(refused.status).toBe(77);
    expect(refused.stderr).toContain('BOTMUX_AS');
  });
});
