import { afterEach, describe, expect, it } from 'vitest';
import { fsyncSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliBrokerAudit } from '../src/core/bytedcli-broker-audit.js';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function root() { const path = mkdtempSync(join(tmpdir(), 'broker-audit-')); roots.push(path); return path; }
const record = { phase: 'intent', daemonBootId: 'boot', botAppId: 'app', sessionId: 'session', turnId: 'turn', identityTurnId: 'identity',
  workerGeneration: 1, dispatchAttempt: 1, policyFingerprint: 'sha256:policy', requestId: 'request', operationId: 'codebase.mr.close',
  catalogVersion: '2026-11-26.1', effect: 'write', accountFingerprint: 'sha256:person', source: 'local', resources: { repo: 'org/repo', mr: '1' },
  inputDigest: 'sha256:digest', timestamp: new Date().toISOString() };
describe('private durable broker audit', () => {
  it('appends only safe metadata to a private regular log', async () => {
    const path = root(); const audit = new BytedcliBrokerAudit(path);
    await audit.append(record); await audit.append({ ...record, phase: 'result', outcome: 'completed', durationMs: 2 });
    const lines = readFileSync(join(path, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.phase)).toEqual(['intent', 'result']);
    expect(statSync(join(path, 'audit.jsonl')).mode & 0o777).toBe(0o600); expect(statSync(path).mode & 0o777).toBe(0o700);
  });
  it('rejects unexpected credential or body fields rather than recording them', async () => {
    const audit = new BytedcliBrokerAudit(root());
    await expect(audit.append({ ...record, jwt: 'secret' })).rejects.toThrow();
    await expect(audit.append({ ...record, resources: { body: 'secret-description' } })).rejects.toThrow();
  });
  it('refuses a symlink log and does not touch its target', async () => {
    const path = root(); const other = root(); symlinkSync(join(other, 'target'), join(path, 'audit.jsonl'));
    await expect(new BytedcliBrokerAudit(path).append(record)).rejects.toThrow();
    expect(() => statSync(join(other, 'target'))).toThrow();
  });
  it.skipIf(process.platform !== 'linux')('requires a newly created audit directory entry to survive parent fsync before accepting intent', async () => {
    const parent = root();
    const sync = (fd: number) => {
      if (readlinkSync('/proc/self/fd/' + fd) === parent) throw new Error('parent fsync failed');
      fsyncSync(fd);
    };
    await expect(new BytedcliBrokerAudit(join(parent, 'new-audit'), sync).append(record)).rejects.toThrow('parent fsync failed');
  });
});
