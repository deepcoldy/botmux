import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBytedcliHostCredentialResolver } from '../src/core/bytedcli-broker-credentials.js';
import { bytedcliHomeFor, serializedCredentialWork } from '../src/services/bytedcli-auth.js';
const platform = { binding: undefined as string | undefined, result: undefined as any, calls: [] as any[] };
vi.mock('../src/core/platform-credential-source.js', () => ({ activePlatformCredentialBindingKey: () => platform.binding,
  resolvePlatformIdentity: async (args: any) => { platform.calls.push(args); return platform.result; } }));
beforeEach(() => { platform.binding = undefined; platform.result = undefined; platform.calls.length = 0; });
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function setup(authSource = 'request_jwt') {
  const root = mkdtempSync(join(tmpdir(), 'broker-host-')); roots.push(root); const calls: any[] = [];
  const jwt = `e30.${Buffer.from(JSON.stringify({ region: 'cn', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const trustedCli = async () => ({ executable: '/trusted/node', prefixArgs: ['/trusted/bytedcli.js'], path: '/trusted:/usr/bin:/bin',
    version: '0.199.0', stillCurrent: () => true });
  const run = async (invocation: any) => {
    calls.push(invocation); expect(invocation.executable).toBe('/trusted/node'); expect(invocation.argv[0]).toBe('/trusted/bytedcli.js');
    expect(invocation.env.NODE_OPTIONS).toBeUndefined(); expect(invocation.env.BYTEDCLI_PROFILE).toBeUndefined();
    expect(invocation.cwd).not.toBe(process.cwd()); expect(invocation.argv).not.toContain(jwt);
    let stdout: string;
    if (invocation.argv.includes('status')) stdout = JSON.stringify({ status: 'success', data: { authenticated: true,
      auth_as: 'user', bytecloud_auth: { site: 'bytedance', authSource: 'bytecloud_auth',
        identity: { username: 'person', email: 'person@example.test' }, expiresAt: '2099-01-01T00:00:00.000Z' } } });
    else if (invocation.argv.includes('get-bytecloud-jwt-token')) stdout = jwt;
    else {
      const file = invocation.argv[invocation.argv.indexOf('--bytecloud-user-jwt-file') + 1];
      expect(readFileSync(file, 'utf8')).toBe(jwt); expect(invocation.env.HOME).not.toBe(root);
      expect(invocation.argv).not.toContain('--profile');
      stdout = JSON.stringify({ status: 'success', data: { username: 'person', email: 'person@example.test', auth_source: authSource } });
    }
    return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const request = { region: 'cn' as const, signal: new AbortController().signal, recheck: async () => undefined,
    actor: { credentialOpenId: 'ou_host_test_person', verifiedEmail: 'person@example.test', source: 'local' as const } };
  return { root, calls, request, jwt, options: { machineHome: root, machineProfile: 'shared', privateRoot: join(root, 'private'), trustedCli, run } };
}
describe('production host credential assembly through fake SDK only', () => {
  it('uses the shared host profile only for mint and verifies its exact token in a fresh HOME', async () => {
    const s = setup(); const resolver = await createBytedcliHostCredentialResolver(s.options);
    const lease = await resolver.machine(s.request); expect(lease.kind).toBe('machine'); expect(lease.accountFingerprint).toMatch(/^sha256:/);
    const mint = s.calls.find(call => call.argv.includes('get-bytecloud-jwt-token'));
    expect(mint.env.HOME).toBe(s.root); expect(mint.argv.slice(mint.argv.indexOf('--profile'), mint.argv.indexOf('--profile') + 2)).toEqual(['--profile', 'shared']);
    expect(s.calls.some(call => call.argv.includes('login'))).toBe(false);
    expect(platform.calls).toEqual([]);
  });
  it('rejects provider userinfo that did not use the request identity', async () => {
    const s = setup('bytecloud_auth'); const resolver = await createBytedcliHostCredentialResolver(s.options);
    await expect(resolver.machine(s.request)).rejects.toMatchObject({ code: 'actor_identity_unverified' });
  });
  it('waits behind the existing local login/revoke queue before consulting the provider', async () => {
    const s = setup(); const home = bytedcliHomeFor(s.request.actor.credentialOpenId); mkdirSync(home, { recursive: true, mode: 0o700 });
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    const existing = serializedCredentialWork(s.request.actor.credentialOpenId, async () => { await gate; });
    const resolver = await createBytedcliHostCredentialResolver(s.options); const lease = resolver.actor(s.request);
    await new Promise(resolve => setTimeout(resolve, 10)); expect(s.calls).toEqual([]);
    release(); await existing; expect((await lease).source).toBe('local');
    expect(s.calls.find(call => call.argv.includes('get-bytecloud-jwt-token')).env.HOME).toBe(home);
  });
  it('requests only the frozen delegated CN platform identity and verifies its returned token', async () => {
    const s = setup(); platform.binding = 'binding'; platform.result = { state: 'granted', bindingKey: 'binding', unionId: 'on_delegated_person',
      expiresAt: Date.now() + 60_000, identity: { tool: 'bytedcli', cloudJwt: 'wrong-default', regionalCloudJwts: { cn: s.jwt } } };
    const resolver = await createBytedcliHostCredentialResolver(s.options);
    const lease = await resolver.actor({ ...s.request, botAppId: 'app', sessionId: 'session', identityTurnId: 'frozen-identity-turn',
      actor: { ...s.request.actor, source: 'platform', unionId: 'on_delegated_person' } });
    expect(lease.source).toBe('platform'); expect(lease.jwt).toBe(s.jwt);
    expect(platform.calls).toEqual([{ botConfig: { larkAppId: 'app' }, tool: 'bytedcli', sessionId: 'session',
      turnId: 'frozen-identity-turn', cloudJwtRegions: ['cn'], unionId: 'on_delegated_person', signal: s.request.signal }]);
    expect(s.calls).toHaveLength(1); expect(s.calls[0].argv).toContain('userinfo');
  });
  it('returns missing personal auth without probing either local or machine credentials when platform refuses', async () => {
    const s = setup(); platform.binding = 'binding'; platform.result = { state: 'not_authorized', consent: false };
    const resolver = await createBytedcliHostCredentialResolver(s.options);
    await expect(resolver.actor({ ...s.request, botAppId: 'app', sessionId: 'session', actor: { ...s.request.actor, source: 'auto' } }))
      .rejects.toMatchObject({ code: 'actor_auth_required' });
    expect(s.calls).toEqual([]);
  });
});

it('personal status projection uses the trusted minimal-env host runner without exposing provider bodies',async()=>{
 const s=setup();mkdirSync(bytedcliHomeFor(s.request.actor.credentialOpenId),{recursive:true,mode:0o700});
 const resolver=await createBytedcliHostCredentialResolver(s.options);
 const {runBytedcliSafeCommand}=await import('../src/core/bytedcli-safe-commands.js');
 const {parseBytedcliOperation}=await import('../src/core/bytedcli-operation-policy.js');
 const response=await runBytedcliSafeCommand({requestId:'safe-status',operation:parseBytedcliOperation(['auth','userinfo']),
  authority:{daemonBootId:'b',botAppId:'app',sessionId:'s',turnId:'t',workerGeneration:1,dispatchAttempt:0,policyFingerprint:'p',actor:s.request.actor,recheck:async()=>undefined}},async()=>resolver);
 expect(JSON.parse(Buffer.from(response.stdoutBase64,'base64').toString())).toEqual({state:'authorized',identity:'actor',source:'local',email:'person@example.test'});
 expect(s.calls.filter(call=>call.argv.includes('status')).every(call=>call.env.HOME===bytedcliHomeFor(s.request.actor.credentialOpenId))).toBe(true);
 expect(s.calls.every(call=>!call.argv.includes('--profile')&&!call.argv.includes('login')&&!call.argv.includes('logout'))).toBe(true);
 expect(response.stdoutBase64).not.toContain(Buffer.from(s.jwt).toString('base64'));
 expect(platform.calls).toEqual([]);
});
