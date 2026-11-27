import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy } from '../src/core/bytedcli-operation-policy-config.js';
import { parseBytedcliExecResponse } from '../src/cli/bytedcli-exec-protocol.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const read = () => parseBytedcliOperation(['codebase', 'repo', 'get', 'org/repo']);
const write = () => parseBytedcliOperation(['codebase', 'mr', 'close', '1', '--repo', 'org/repo']);
function setup(options: Record<string, any> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'broker-executor-')); roots.push(root);
  const dispatches: any[] = []; const audit: any[] = []; const providers: string[] = [];
  const lease = { jwt: 'active-secret', kind: 'machine', region: 'cn', expiresAt: Date.now() + 120_000,
    accountFingerprint: 'sha256:machine', source: 'machine', stillCurrent: async () => undefined };
  const executor = new BytedcliExecutor({ privateRoot: root,
    trustedCli: async () => ({ executable: '/trusted/bytedcli', path: '/usr/bin:/bin', version: '0.199.0', stillCurrent: () => true }),
    leases: { machine: async () => { providers.push('machine'); return { ...lease, ...options.lease }; },
      actor: async () => { providers.push('actor'); return { ...lease, kind: 'actor', source: 'local', ...options.lease }; } },
    audit: { append: async (record: any) => { audit.push(record); if (options.auditFails === record.phase) throw new Error('disk'); } },
    run: async (invocation: any) => { dispatches.push(invocation); return options.run ? options.run(invocation)
      : { stdout: Buffer.from('ok active-secret'), stderr: Buffer.alloc(0), exitCode: 0 }; },
    ...options.dependencies });
  const authority = { daemonBootId: 'boot', botAppId: 'app', sessionId: 'session', turnId: 'turn', identityTurnId: 'identity',
    workerGeneration: 1, dispatchAttempt: 1, policyFingerprint: 'policy', actor: { verifiedEmail: 'person@example.test', credentialOpenId: 'ou_person', source: 'local' },
    recheck: async () => options.recheck?.() };
  const request = (operation = read(), requestId = 'request', extra: Record<string, any> = {}) => ({ operation, requestId, authority, ...extra });
  return { executor, request, dispatches, audit, providers, root, authority };
}
const machinePolicy = () => Object.freeze({ globalRevision: 'explicit', botPolicy: parseBytedcliOperationPolicy({
  schema: 'botmux.bytedcli-operation-policy.v2', cliVersion: '0.199.0', catalogVersion: '2026-11-26.1', rules: { 'codebase.mr.close': 'machine' },
}) });
const machineAuthority = (authority: any) => ({ ...authority, actor: undefined, executionIdentity: 'machine', operationPolicy: machinePolicy() });
describe('bounded host business execution', () => {
  it('explicit parsed machine writes use only machine leases and retain intent, result and replay', async () => {
    const s = setup(), authority = machineAuthority(s.authority);
    const request = s.request(write(), 'machine-write', { authority });
    const result = await s.executor.execute(request);
    expect(parseBytedcliExecResponse(result)).toMatchObject({ outcome: 'completed', effectiveIdentity: { kind: 'machine' } });
    expect(s.providers).toEqual(['machine']); expect(s.dispatches).toHaveLength(1);
    expect(s.audit.map(row => [row.phase, row.effect, row.source])).toEqual([['intent', 'write', 'machine'], ['result', 'write', 'machine']]);
    expect(await s.executor.execute(request)).toEqual(result); expect(s.dispatches).toHaveLength(1);
    expect(await s.executor.execute({ ...request, authority: { ...s.authority, policyFingerprint: 'changed', executionIdentity: 'actor' } }))
      .toMatchObject({ outcome: 'write_outcome_unknown', effectiveIdentity: { kind: 'machine' } });
    expect(s.dispatches).toHaveLength(1);
  });
  it.each(['absent', 'unfrozen', 'unparsed', 'inherited', 'actor-floor', 'denied'])('refuses machine write with %s policy proof before leasing', async proof => {
    const s = setup(), parsed = machinePolicy();
    const operationPolicy = proof === 'absent' ? undefined : proof === 'unfrozen' ? { ...parsed }
      : proof === 'unparsed' ? Object.freeze({ ...parsed, botPolicy: Object.freeze({ ...parsed.botPolicy }) })
      : proof === 'inherited' ? Object.freeze({ globalRevision: 'default' })
      : Object.freeze({ ...parsed, globalPolicy: parseBytedcliOperationPolicy({ ...parsed.botPolicy, rules: { 'codebase.mr.close': proof === 'denied' ? 'deny' : 'actor' } }) });
    const result = await s.executor.execute(s.request(write(), proof, { authority: { ...s.authority, executionIdentity: 'machine', operationPolicy } }));
    expect(result.errorCode).toBe('actor_required'); expect(s.providers).toEqual([]); expect(s.dispatches).toEqual([]);
  });
  it.each(['intent', 'result'])('retains durable %s failure behavior for machine writes', async phase => {
    const s = setup({ auditFails: phase });
    const result = await s.executor.execute(s.request(write(), phase, { authority: machineAuthority(s.authority) }));
    expect(parseBytedcliExecResponse(result)).toMatchObject({ outcome: phase === 'intent' ? 'rejected' : 'write_outcome_unknown',
      errorCode: phase === 'intent' ? 'audit_unavailable' : 'write_outcome_unknown', effectiveIdentity: { kind: 'machine' } });
    expect(s.providers).toEqual(['machine']); expect(s.dispatches).toHaveLength(phase === 'intent' ? 0 : 1);
  });
  it('machine writes retain the one-write-per-session quota while a second request waits', async () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => started = resolve);
    const s = setup({ run: async () => { started(); await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const authority = machineAuthority(s.authority);
    const first = s.executor.execute(s.request(write(), 'first-machine', { authority })); await entered;
    const controller = new AbortController();
    const second = s.executor.execute(s.request(write(), 'second-machine', { authority, signal: controller.signal }));
    controller.abort(); expect((await second).errorCode).toBe('cancelled'); expect(s.providers).toEqual(['machine']);
    release(); expect((await first).outcome).toBe('completed'); expect(s.dispatches).toHaveLength(1);
  });
  it('reads with only the machine lease even when the actor has no auth', async () => {
    const s = setup(); delete (s.authority as any).actor;
    const result = await s.executor.execute(s.request());
    expect(parseBytedcliExecResponse(result).outcome).toBe('completed');
    expect(s.providers).toEqual(['machine']); expect(s.dispatches).toHaveLength(1);
    expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('ok [REDACTED]');
  });
  it('rejects a write without a verified actor before any lease or dispatch', async () => {
    const s = setup(); delete (s.authority as any).actor;
    expect((await s.executor.execute(s.request(write()))).errorCode).toBe('actor_required');
    expect(s.providers).toEqual([]); expect(s.dispatches).toEqual([]);
  });
  it.each(['auth', 'help'])('rejects the %s descriptor until a dedicated adapter exists', async effect => {
    const s = setup(); const operation = parseBytedcliOperation(effect === 'auth' ? ['auth', 'status'] : ['--help']);
    expect((await s.executor.execute(s.request(operation))).errorCode).toBe('unsupported_operation');
    expect(s.dispatches).toEqual([]); expect(s.providers).toEqual([]);
  });
  it('checks missing CN leases before dispatch', async () => {
    const s = setup({ lease: { region: 'us' } });
    expect((await s.executor.execute(s.request(write()))).errorCode).toBe('region_auth_required');
    expect(s.dispatches).toEqual([]);
  });
  it('stages stdin description as immutable private file and never inherits host env', async () => {
    const operation = parseBytedcliOperation(['codebase', 'mr', 'update', '1', '--repo', 'org/repo', '--body-file', '-'], { stdinBase64: Buffer.from('description').toString('base64') });
    const s = setup({ run: (invocation: any) => {
      expect(invocation.env.HOME).not.toBe(process.env.HOME); expect(invocation.cwd).not.toBe(process.cwd());
      expect(invocation.env.NODE_OPTIONS).toBeUndefined(); expect(invocation.env.BYTEDCLI_PROFILE).toBeUndefined();
      expect(invocation.env.AILY_WORKSPACE_PATH).toBeUndefined(); expect(invocation.env.BYTECLOUD_AUTH_USER_JWT).toBeUndefined();
      expect(invocation.argv).not.toContain('active-secret');
      const file = invocation.argv[invocation.argv.indexOf('--body-file') + 1];
      expect(readFileSync(file, 'utf8')).toBe('description');
      expect(readFileSync(invocation.argv[invocation.argv.indexOf('--bytecloud-user-jwt-file') + 1], 'utf8')).toBe('active-secret');
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    } });
    expect((await s.executor.execute(s.request(operation))).outcome).toBe('completed');
    expect(s.audit.map(x => x.phase)).toEqual(['intent', 'result']); expect(readdirSync(s.root)).toEqual([]);
  });
  it('refuses dispatch when durable write intent fails', async () => {
    const s = setup({ auditFails: 'intent' });
    expect((await s.executor.execute(s.request(write()))).errorCode).toBe('audit_unavailable');
    expect(s.dispatches).toEqual([]);
  });
  it('reports unknown when result persistence fails after a successful write', async () => {
    const s = setup({ auditFails: 'result' });
    const result = await s.executor.execute(s.request(write()));
    expect(result.outcome).toBe('write_outcome_unknown'); expect(result.exitCode).toBe(77);
    expect(s.dispatches).toHaveLength(1);
  });
  it('never releases output after a post-dispatch revocation', async () => {
    let revoked = false;
    const s = setup({ recheck: () => revoked ? 'authorization_revoked' : undefined,
      run: () => { revoked = true; return { stdout: Buffer.from('private-result'), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const result = await s.executor.execute(s.request(write()));
    expect(result.outcome).toBe('write_outcome_unknown'); expect(result.stdoutBase64).toBe('');
  });
  it('deduplicates an identical in-flight tuple and refuses id reuse with changed inputs', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async () => { await gate; return { stdout: Buffer.from('done'), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const first = s.executor.execute(s.request(write())); const second = s.executor.execute(s.request(write()));
    expect((await s.executor.execute(s.request(read()))).errorCode).toBe('invalid_request');
    release(); expect(await second).toEqual(await first); expect(s.dispatches).toHaveLength(1);
  });
  it('bounds each session to four reads and cancels quota waiters before leasing', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async () => { await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const running = [1, 2, 3, 4].map(id => s.executor.execute(s.request(read(), `r${id}`)));
    await new Promise(resolve => setTimeout(resolve, 10));
    const abort = new AbortController(); const queued = s.executor.execute(s.request(read(), 'r5', { signal: abort.signal }));
    abort.abort(); expect((await queued).errorCode).toBe('cancelled'); expect(s.dispatches).toHaveLength(4);
    expect(s.providers).toHaveLength(4); release(); await Promise.all(running);
  });
  it('enforces a hard deadline while an injected provider never resolves', async () => {
    const s = setup({ dependencies: { leases: { machine: () => new Promise(() => {}), actor: () => new Promise(() => {}) } } });
    const result = await s.executor.execute(s.request({ ...read(), timeoutMs: 20 }));
    expect(result.errorCode).toBe('timeout'); expect(s.dispatches).toEqual([]);
  });
  it('rejects output beyond the audited operation bound without returning truncated success', async () => {
    const s = setup({ run: () => ({ stdout: Buffer.from('too-long'), stderr: Buffer.alloc(0), exitCode: 0 }) });
    expect((await s.executor.execute(s.request({ ...write(), outputLimitBytes: 4 }))).outcome).toBe('write_outcome_unknown');
  });
  it('bounds initial host authority verification by the request deadline', async () => {
    const s = setup({ recheck: () => new Promise(() => {}) });
    const result = await Promise.race([s.executor.execute(s.request({ ...read(), timeoutMs: 20 })),
      new Promise<any>(resolve => setTimeout(() => resolve({ errorCode: 'hung' }), 100))]);
    expect(result.errorCode).toBe('timeout'); expect(s.dispatches).toEqual([]);
  });
  it('does not hang when post-dispatch audit failure recovery is also unavailable', async () => {
    const s = setup({ dependencies: { audit: { append: (record: any) => record.phase === 'intent'
      ? Promise.resolve() : new Promise(() => {}) } } });
    const result = await Promise.race([s.executor.execute(s.request({ ...write(), timeoutMs: 20 })),
      new Promise<any>(resolve => setTimeout(() => resolve({ outcome: 'hung' }), 100))]);
    expect(result.outcome).toBe('write_outcome_unknown');
  });
  it('withholds a deduplicated write result when the leased account was revoked', async () => {
    let revoked = false;
    const s = setup({ lease: { stillCurrent: async () => revoked ? 'authorization_revoked' : undefined } });
    expect((await s.executor.execute(s.request(write()))).outcome).toBe('completed'); revoked = true;
    const result = await s.executor.execute(s.request(write()));
    expect(result.outcome).toBe('write_outcome_unknown'); expect(result.stdoutBase64).toBe(''); expect(s.dispatches).toHaveLength(1);
  });
  it('treats a nonzero generic write exit as uncertain rather than proving no remote mutation', async () => {
    const s = setup({ run: () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('failed after send'), exitCode: 1 }) });
    expect((await s.executor.execute(s.request(write()))).outcome).toBe('write_outcome_unknown');
  });
  it('caps daemon reads at sixteen across sessions and permits only sixty-four waiters', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async () => { await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const authority = (sessionId: string) => ({ ...s.authority, sessionId });
    const running = Array.from({ length: 16 }, (_, id) => s.executor.execute(s.request(read(), `active${id}`, { authority: authority(`s${Math.floor(id / 4)}`) })));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(s.dispatches).toHaveLength(16);
    const controller = new AbortController();
    const waiting = Array.from({ length: 64 }, (_, id) => s.executor.execute(s.request(read(), `wait${id}`, { authority: authority(`q${id}`), signal: controller.signal })));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await s.executor.execute(s.request(read(), 'overflow', { authority: authority('overflow') }))).errorCode).toBe('busy');
    expect(s.providers).toHaveLength(16); controller.abort(); expect((await Promise.all(waiting)).every(result => result.errorCode === 'cancelled')).toBe(true);
    release(); await Promise.all(running);
  });
  it('caps daemon writes at four and each session at one', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async () => { await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const running = Array.from({ length: 4 }, (_, id) => s.executor.execute(s.request(write(), `write${id}`, { authority: { ...s.authority, sessionId: `s${id}` } })));
    await new Promise(resolve => setTimeout(resolve, 20));
    const abort = new AbortController();
    const more = [s.executor.execute(s.request(write(), 'same-session', { authority: { ...s.authority, sessionId: 's0' }, signal: abort.signal })),
      s.executor.execute(s.request(write(), 'fifth-session', { authority: { ...s.authority, sessionId: 's5' }, signal: abort.signal }))];
    await new Promise(resolve => setTimeout(resolve, 10)); expect(s.dispatches).toHaveLength(4);
    abort.abort(); await Promise.all(more); release(); await Promise.all(running);
  });
  it('returns busy after a five-second quota deadline without requesting another lease', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async () => { await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const first = s.executor.execute(s.request(write(), 'first'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await s.executor.execute(s.request(write(), 'queued'))).errorCode).toBe('busy');
    expect(s.providers).toHaveLength(1); release(); await first;
  }, 8000);
  it('refuses allocation once concurrent output buffers reach the daemon budget', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async (invocation: any) => {
      if (!invocation.reserveOutput(16 * 1024 * 1024)) throw Object.assign(new Error('budget'), { code: 'output_limit' });
      await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    } });
    const running = Array.from({ length: 8 }, (_, id) => s.executor.execute(s.request(read(), `buffer${id}`, { authority: { ...s.authority, sessionId: `s${Math.floor(id / 4)}` } })));
    await new Promise(resolve => setTimeout(resolve, 20));
    const ninth = s.executor.execute(s.request(read(), 'ninth', { authority: { ...s.authority, sessionId: 's9' } }));
    const result = await Promise.race([ninth, new Promise<any>(resolve => setTimeout(() => resolve({ errorCode: 'hung' }), 100))]);
    release(); await Promise.all(running); await ninth; expect(result.errorCode).toBe('output_limit');
  });
  it('cancels active requests and releases their private files when the daemon closes', async () => {
    const s = setup({ run: (invocation: any) => new Promise((_resolve, reject) => invocation.signal.addEventListener('abort',
      () => reject(Object.assign(new Error('closed'), { code: 'cancelled' })), { once: true })) });
    const running = s.executor.execute(s.request(write())); await new Promise(resolve => setTimeout(resolve, 10));
    await s.executor.close(); expect((await running).outcome).toBe('write_outcome_unknown');
    expect((await s.executor.execute(s.request(read(), 'after-close'))).errorCode).toBe('executor_unavailable');
    expect(readdirSync(s.root)).toEqual([]);
  });
  it('caps duplicate waiters while preserving the original request on follower cancellation', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async () => { await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const first = s.executor.execute(s.request(read())); await new Promise(resolve => setTimeout(resolve, 10));
    const abort = new AbortController(); const copies = Array.from({ length: 64 }, () => s.executor.execute(s.request(read(), 'request', { signal: abort.signal })));
    await new Promise(resolve => setTimeout(resolve, 10));
    const overflow = s.executor.execute(s.request());
    const result = await Promise.race([overflow, new Promise<any>(resolve => setTimeout(() => resolve({ errorCode: 'hung' }), 100))]);
    abort.abort(); await Promise.all(copies); release(); await first; await overflow;
    expect(result.errorCode).toBe('busy'); expect(s.dispatches).toHaveLength(1);
  });
  it('reports an interrupted duplicate write as uncertain when the primary already dispatched', async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const s = setup({ run: async () => { await gate; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    const first = s.executor.execute(s.request(write())); await new Promise(resolve => setTimeout(resolve, 10));
    const abort = new AbortController(); const duplicate = s.executor.execute(s.request(write(), 'request', { signal: abort.signal }));
    await new Promise(resolve => setTimeout(resolve, 10)); abort.abort(); const result = await duplicate;
    release(); await first; expect(result.outcome).toBe('write_outcome_unknown'); expect(s.dispatches).toHaveLength(1);
  });
});
