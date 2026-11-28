import './helpers/require-fenced-data-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliBrokerAudit } from '../src/core/bytedcli-broker-audit.js';
import { readCommittedBytedcliAudit } from './helpers/bytedcli-audit-records.js';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
const fault = vi.hoisted(() => ({ root: '', fail: false, partial: false, zero: false }));
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, writeSync: (fd: number, bytes: Buffer, offset: number, length: number) => {
    if (fault.fail && original.readlinkSync('/proc/self/fd/' + fd).startsWith(fault.root)) {
      if (fault.zero) return 0;
      if (!fault.partial) { fault.partial = true; return original.writeSync(fd, bytes, offset, Math.min(24, length)); }
      throw Object.assign(new Error('private fixture disk full'), { code: 'ENOSPC' });
    }
    return original.writeSync(fd, bytes, offset, length);
  } };
});
const roots: string[] = [];
afterEach(() => { fault.fail = false; fault.partial = false; fault.zero = false; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function root() { const path = mkdtempSync(join(tmpdir(), 'broker-audit-')); roots.push(path); return path; }
const record = { phase: 'intent', daemonBootId: 'boot', botAppId: 'app', sessionId: 'session', turnId: 'turn', identityTurnId: 'identity',
  workerGeneration: 1, dispatchAttempt: 1, policyFingerprint: 'sha256:policy', requestId: 'request', operationId: 'codebase.mr.close',
  catalogVersion: '2026-11-26.1', effect: 'write', accountFingerprint: 'sha256:person', source: 'local', resources: { repo: 'org/repo', mr: '1' },
  inputDigest: 'sha256:digest', timestamp: new Date().toISOString() };
describe('private durable broker audit', () => {
  it('preserves an active other-daemon historical append while acknowledging an independent new intent', async () => {
    const path = root(); const legacy = join(path, 'audit.jsonl');
    const history = Buffer.from(JSON.stringify({ ...record, requestId: 'prior-daemon-intent' }) + '\n');
    const peer = Buffer.from(JSON.stringify({ ...record, daemonBootId: 'other-boot', requestId: 'active-peer-intent' }) + '\n');
    writeFileSync(legacy, history, { mode: 0o600 }); const fd = openSync(legacy, 'a');
    try {
      writeSync(fd, peer, 0, 24);
      await new BytedcliBrokerAudit(path).append({ ...record, requestId: 'new-daemon-intent' });
      expect(readFileSync(legacy)).toEqual(Buffer.concat([history, peer.subarray(0, 24)]));
      writeSync(fd, peer, 24, peer.length - 24); fsyncSync(fd);
      const previous = readFileSync(legacy, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(previous.map(item => item.requestId)).toEqual(['prior-daemon-intent', 'active-peer-intent']);
      expect(readCommittedBytedcliAudit(path).some(item => item.requestId === 'new-daemon-intent')).toBe(true);
    } finally { closeSync(fd); }
  });
  it.skipIf(process.platform !== 'linux')('dispatches a recovered write only with its committed parseable intent after executor reconstruction', async () => {
    const path = root(); let writes = 0;
    const authority = { daemonBootId: 'boot', botAppId: 'app', sessionId: 'session', turnId: 'turn', workerGeneration: 1,
      dispatchAttempt: 1, policyFingerprint: 'policy', recheck: async () => undefined,
      actor: { verifiedEmail: 'person@example.test', credentialOpenId: 'ou_person', source: 'local' as const } };
    const operation = parseBytedcliOperation(['codebase', 'mr', 'close', '1', '--repo', 'org/repo']);
    const make = () => new BytedcliExecutor({ privateRoot: join(path, 'private'), audit: new BytedcliBrokerAudit(join(path, 'audit')),
      trustedCli: async () => ({ executable: '/usr/bin/false', path: '/usr/bin:/bin', version: '0.199.0', stillCurrent: () => true }),
      leases: { actor: async () => ({ jwt: 'fake-only', kind: 'actor', source: 'local', region: 'cn', expiresAt: Date.now() + 60_000,
        accountFingerprint: 'sha256:actor', stillCurrent: async () => undefined }), machine: async () => { throw new Error('unexpected machine'); } },
      run: async () => { writes++; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }; } });
    fault.root = join(path, 'audit'); fault.fail = true;
    const first = make(); const failed = await first.execute({ requestId: 'failed', operation, authority }); await first.close();
    expect(failed.errorCode).toBe('audit_unavailable'); expect(writes).toBe(0);
    fault.fail = false;
    const next = make(); const result = await next.execute({ requestId: 'recovered', operation, authority }); await next.close();
    expect(result.outcome).toBe('completed'); expect(writes).toBe(1);
    expect(readCommittedBytedcliAudit(join(path, 'audit')).some(item => item.phase === 'intent' && item.requestId === 'recovered')).toBe(true);
  });
  it.skipIf(process.platform !== 'linux')('publishes a parseable intent after actual partial-write recovery without changing another daemon history', async () => {
    const path = root();
    const prior = { ...record, requestId: 'historical-intent' };
    writeFileSync(join(path, 'audit.jsonl'), JSON.stringify(prior) + '\n', { mode: 0o600 });
    fault.root = path; fault.fail = true;
    await expect(new BytedcliBrokerAudit(path).append({ ...record, requestId: 'torn-request' })).rejects.toThrow('disk full');
    const old = readFileSync(join(path, 'audit.jsonl'));
    fault.fail = false;
    // Another daemon publishes while this object is reconstructed. Neither
    // successful writer is allowed to truncate shared or partial history.
    await new BytedcliBrokerAudit(path).append({ ...record, requestId: 'other-daemon' });
    await new BytedcliBrokerAudit(path).append({ ...record, requestId: 'after-recovery' });
    const committed = readCommittedBytedcliAudit(path);
    expect(committed.some(item => item.requestId === 'after-recovery' && item.phase === 'intent')).toBe(true);
    expect(committed.some(item => item.requestId === 'other-daemon')).toBe(true);
    expect(readFileSync(join(path, 'audit.jsonl'))).toEqual(old);
  });
  it('appends only safe metadata to a private regular log', async () => {
    const path = root(); const audit = new BytedcliBrokerAudit(path);
    await audit.append(record); await audit.append({ ...record, phase: 'result', outcome: 'completed', durationMs: 2 });
    const lines = readCommittedBytedcliAudit(path);
    expect(lines.map(line => line.phase).sort()).toEqual(['intent', 'result']);
    for (const name of readdirSync(join(path, 'records'))) expect(statSync(join(path, 'records', name)).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });
  it('rejects unexpected credential or body fields rather than recording them', async () => {
    const audit = new BytedcliBrokerAudit(root());
    await expect(audit.append({ ...record, jwt: 'secret' })).rejects.toThrow();
    await expect(audit.append({ ...record, resources: { body: 'secret-description' } })).rejects.toThrow();
  });
  it('refuses a symlink record directory and does not touch its target', async () => {
    const path = root(); const other = root(); symlinkSync(join(other, 'target'), join(path, 'records'));
    await expect(new BytedcliBrokerAudit(path).append(record)).rejects.toThrow();
    expect(() => statSync(join(other, 'target'))).toThrow();
  });
  it.skipIf(process.platform !== 'linux')('requires a newly created audit directory entry to survive parent fsync before accepting intent', async () => {
    const parent = root(); const path = join(parent, 'new-audit');
    const sync = (fd: number) => {
      if (readlinkSync('/proc/self/fd/' + fd) === parent && existsSync(path)) throw new Error('parent fsync failed');
      fsyncSync(fd);
    };
    await expect(new BytedcliBrokerAudit(path, sync).append(record)).rejects.toThrow('parent fsync failed');
    expect(existsSync(path)).toBe(true);
  });
  it.skipIf(process.platform !== 'linux').each([false, true])('retries an incomplete parent barrier before accepting intent, recreated=%s', async recreated => {
    const parent = root(); const path = join(parent, 'new-parent', 'audit'); let failing = true; const synced: string[] = [];
    const sync = (fd: number) => {
      const target = readlinkSync('/proc/self/fd/' + fd); synced.push(target);
      if (target === parent && existsSync(join(parent, 'new-parent')) && failing) throw new Error('parent fsync failed'); fsyncSync(fd);
    };
    let audit = new BytedcliBrokerAudit(path, sync);
    await expect(audit.append(record)).rejects.toThrow('parent fsync failed');
    expect(existsSync(join(parent, 'new-parent'))).toBe(true);
    if (recreated) audit = new BytedcliBrokerAudit(path, sync);
    await expect(audit.append(record)).rejects.toThrow('parent fsync failed');
    failing = false; synced.length = 0; await audit.append(record);
    expect(synced).toContain(parent);
    expect(readCommittedBytedcliAudit(path)).toHaveLength(1);
  });
  it.skipIf(process.platform !== 'linux')('does not acknowledge failed file fsync and keeps subsequent reconstructed intent parseable', async () => {
    const path = root(); let failed = false;
    const sync = (fd: number) => {
      if (readlinkSync('/proc/self/fd/' + fd).endsWith('.pending') && !failed) { failed = true; throw new Error('file fsync failed'); }
      fsyncSync(fd);
    };
    await expect(new BytedcliBrokerAudit(path, sync).append(record)).rejects.toThrow('file fsync failed');
    expect(readCommittedBytedcliAudit(path)).toHaveLength(0);
    await new BytedcliBrokerAudit(path).append({ ...record, requestId: 'reconstructed' });
    expect(readCommittedBytedcliAudit(path).map(item => item.requestId)).toEqual(['reconstructed']);
    expect(readdirSync(join(path, 'records')).some(name => name.endsWith('.pending'))).toBe(true);
  });
  it.skipIf(process.platform !== 'linux')('fails rather than looping forever when storage makes no write progress', async () => {
    const path = root(); fault.root = path; fault.fail = true; fault.zero = true;
    await expect(new BytedcliBrokerAudit(path).append(record)).rejects.toThrow('audit_write_no_progress');
    expect(readCommittedBytedcliAudit(path)).toHaveLength(0);
  });
  it.skipIf(process.platform !== 'linux')('repeats a failed publication-directory barrier before acknowledging reconstructed intent', async () => {
    const path = root(); let failing = true;
    const sync = (fd: number) => {
      const target = readlinkSync('/proc/self/fd/' + fd);
      if (target === join(path, 'records') && readdirSync(target).some(name => name.endsWith('.json')) && failing) throw new Error('record directory fsync failed');
      fsyncSync(fd);
    };
    await expect(new BytedcliBrokerAudit(path, sync).append(record)).rejects.toThrow('record directory fsync failed');
    await expect(new BytedcliBrokerAudit(path, sync).append({ ...record, requestId: 'second' })).rejects.toThrow('record directory fsync failed');
    expect(readCommittedBytedcliAudit(path).map(item => item.requestId)).toEqual(['request']);
    failing = false; await new BytedcliBrokerAudit(path, sync).append({ ...record, requestId: 'after-barrier-recovery' });
    expect(readCommittedBytedcliAudit(path).map(item => item.requestId).sort()).toEqual(['after-barrier-recovery', 'request']);
  });
});
