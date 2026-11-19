/**
 * Feedback send lease for a CLI whose session sandbox hides what the in-process
 * lease needs (macOS read isolation: no setuid `ps`, data dir denied). The CLI
 * falls back to its daemon, which takes the same lease on the CLI's behalf.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireFeedbackSendLeaseFor, beginFeedbackMaintenance, inspectFeedbackMaintenance, releaseFeedbackSendLeaseFor,
} from '../src/services/feedback-maintenance.js';
import { acknowledgeFeedbackRecovery, inspectSendRecovery } from '../src/services/feedback-recovery.js';
import {
  acquireFeedbackSendLeaseWithRelay, handleFeedbackSendLeaseRelay, type FeedbackSendLeaseRelay,
} from '../src/services/feedback-send-lease-relay.js';
import { readDurableProcessIdentity } from '../src/utils/process-identity.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-send-lease-relay-'));
  directories.push(directory);
  return directory;
}
/** Stand-in for the sandboxed `botmux send` process the daemon leases for. */
async function sender(): Promise<ChildProcess & { pid: number }> {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  return child as ChildProcess & { pid: number };
}
async function leaseFiles(directory: string): Promise<string[]> {
  const path = join(directory, 'feedback-send-leases');
  return existsSync(path) ? readdir(path) : [];
}
const sandboxDenied = () => { throw Object.assign(new Error('EPERM: operation not permitted, mkdir'), { code: 'EPERM' }); };
const identityUnavailable = () => { throw new Error('feedback_process_identity_unavailable'); };

describe('daemon-side send lease', () => {
  it('records the sender exact identity, blocks freezing while it lives and becomes acknowledgeable after it exits', async () => {
    const directory = await dataDir();
    const child = await sender();
    const { lease, releaseToken } = acquireFeedbackSendLeaseFor(directory, { processId: child.pid, sessionId: 'sess-a' });
    const persisted = JSON.parse(await readFile(join(directory, 'feedback-send-leases', lease), 'utf8'));
    expect(persisted).toEqual({
      processId: child.pid, processStartId: readDurableProcessIdentity(child.pid), sessionId: 'sess-a',
      releaseTokenHash: expect.any(String),
    });
    expect(persisted.releaseToken).toBeUndefined();
    await beginFeedbackMaintenance(directory, 'relayed-send');
    expect((await inspectFeedbackMaintenance(directory, 'relayed-send')).blockers).toContain(`send_in_progress:${child.pid}`);
    const [live] = inspectSendRecovery(directory);
    await expect(acknowledgeFeedbackRecovery(directory, {
      kind: 'send', id: live!.id, fingerprint: live!.fingerprint, confirmed: true, actor: 'op', reason: 'r', evidence: 'e',
    })).rejects.toThrow('feedback_recovery_operation_live');
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(inspectSendRecovery(directory)).toEqual([expect.objectContaining({ id: lease, live: false, acknowledged: false })]);
    expect((await inspectFeedbackMaintenance(directory, 'relayed-send')).blockers).toContain(`send_outcome_unknown:${child.pid}`);
  });

  it('refuses during maintenance and for processes whose identity it cannot read', async () => {
    const directory = await dataDir();
    const child = await sender();
    await beginFeedbackMaintenance(directory, 'admission');
    expect(() => acquireFeedbackSendLeaseFor(directory, { processId: child.pid, sessionId: 'sess-a' })).toThrow('feedback_storage_maintenance');
    expect(await leaseFiles(directory)).toEqual([]);

    const other = await dataDir();
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(() => acquireFeedbackSendLeaseFor(other, { processId: child.pid, sessionId: 'sess-a' })).toThrow('feedback_process_identity_unavailable');
    expect(() => acquireFeedbackSendLeaseFor(other, { processId: process.pid, sessionId: 'sess-a' })).toThrow('feedback_send_lease_invalid');
    expect(() => acquireFeedbackSendLeaseFor(other, { processId: 1, sessionId: 'sess-a' })).toThrow('feedback_send_lease_invalid');
    expect(await leaseFiles(other)).toEqual([]);
  });

  it('releases only a lease recorded for the same session and process', async () => {
    const directory = await dataDir();
    const child = await sender();
    const { lease, releaseToken } = acquireFeedbackSendLeaseFor(directory, { processId: child.pid, sessionId: 'sess-a' });
    expect(() => releaseFeedbackSendLeaseFor(directory, { lease, processId: child.pid, sessionId: 'sess-b', releaseToken })).toThrow('feedback_send_lease_not_owned');
    expect(() => releaseFeedbackSendLeaseFor(directory, { lease, processId: child.pid + 1, sessionId: 'sess-a', releaseToken })).toThrow('feedback_send_lease_invalid');
    expect(() => releaseFeedbackSendLeaseFor(directory, {
      lease: `${child.pid}-../../feedback-maintenance.json`, processId: child.pid, sessionId: 'sess-a', releaseToken,
    })).toThrow('feedback_send_lease_invalid');
    const wrongToken = `${releaseToken.slice(0, -1)}${releaseToken.endsWith('A') ? 'B' : 'A'}`;
    expect(() => releaseFeedbackSendLeaseFor(directory, {
      lease, processId: child.pid, sessionId: 'sess-a', releaseToken: wrongToken,
    })).toThrow('feedback_send_lease_not_owned');
    expect(await leaseFiles(directory)).toEqual([lease]);
    releaseFeedbackSendLeaseFor(directory, { lease, processId: child.pid, sessionId: 'sess-a', releaseToken });
    expect(await leaseFiles(directory)).toEqual([]);
    releaseFeedbackSendLeaseFor(directory, { lease, processId: child.pid, sessionId: 'sess-a', releaseToken });
  });

  it('never lets a session release a lease the CLI took in-process', async () => {
    const directory = await dataDir();
    const child = await sender();
    const { lease, releaseToken } = acquireFeedbackSendLeaseFor(directory, { processId: child.pid, sessionId: 'sess-a' });
    const path = join(directory, 'feedback-send-leases', lease);
    await writeFile(path, JSON.stringify({ processId: child.pid, processStartId: readDurableProcessIdentity(child.pid) }));
    expect(() => releaseFeedbackSendLeaseFor(directory, { lease, processId: child.pid, sessionId: 'sess-a', releaseToken })).toThrow('feedback_send_lease_not_owned');
    expect(await leaseFiles(directory)).toEqual([lease]);
  });

  it('maps relay requests onto lease operations without echoing unexpected errors', async () => {
    const directory = await dataDir();
    const child = await sender();
    expect(handleFeedbackSendLeaseRelay(directory, 'sess-a', { action: 'acquire', processId: String(child.pid) }).status).toBe(400);
    expect(handleFeedbackSendLeaseRelay(directory, 'sess-a', { action: 'steal', processId: child.pid }).status).toBe(400);
    const acquired = handleFeedbackSendLeaseRelay(directory, 'sess-a', { action: 'acquire', processId: child.pid });
    // Read the lease before matching: bun's toMatchObject rewrites matched
    // asymmetric fields on the received object.
    const lease = (acquired.body as { lease: string }).lease;
    const releaseToken = (acquired.body as { releaseToken: string }).releaseToken;
    expect(acquired.status).toBe(200);
    expect(lease.startsWith(`${child.pid}-`)).toBe(true);
    expect(handleFeedbackSendLeaseRelay(directory, 'sess-b', { action: 'release', processId: child.pid, lease, releaseToken }))
      .toEqual({ status: 409, body: { ok: false, error: 'feedback_send_lease_not_owned' } });
    expect(handleFeedbackSendLeaseRelay(directory, 'sess-a', { action: 'release', processId: child.pid, lease, releaseToken }))
      .toEqual({ status: 200, body: { ok: true } });
    await beginFeedbackMaintenance(directory, 'mapped');
    expect(handleFeedbackSendLeaseRelay(directory, 'sess-a', { action: 'acquire', processId: child.pid }))
      .toEqual({ status: 409, body: { ok: false, error: 'feedback_storage_maintenance' } });
    // A host-side failure (here: the data dir path is a file) is not echoed
    // into the sandbox, which never needs the host path it would carry.
    const blocked = join(directory, 'blocked');
    await writeFile(blocked, '');
    expect(handleFeedbackSendLeaseRelay(blocked, 'sess-a', { action: 'acquire', processId: child.pid }))
      .toEqual({ status: 409, body: { ok: false, error: 'feedback_send_lease_unavailable' } });
  });
});

describe('CLI send lease with daemon fallback', () => {
  const relayTo = (directory: string, sessionId = 'sess-a'): FeedbackSendLeaseRelay & { calls: Record<string, unknown>[] } => {
    const calls: Record<string, unknown>[] = [];
    const relay = (async (body: Record<string, unknown>) => {
      calls.push(body);
      const result = handleFeedbackSendLeaseRelay(directory, sessionId, body);
      return { ok: result.status === 200, status: result.status, body: result.body };
    }) as FeedbackSendLeaseRelay & { calls: Record<string, unknown>[] };
    relay.calls = calls;
    return relay;
  };

  it('keeps the in-process lease when the CLI can take it', async () => {
    const directory = await dataDir();
    const releaseLocal = vi.fn();
    const relay = relayTo(directory);
    const release = await acquireFeedbackSendLeaseWithRelay({ acquireLocal: () => releaseLocal, relay });
    await release();
    expect(releaseLocal).toHaveBeenCalledOnce();
    expect(relay.calls).toEqual([]);
  });

  it.each([
    ['the data dir is denied by the session sandbox', sandboxDenied],
    ['the CLI cannot read its own birth identity', identityUnavailable],
  ])('crosses to the daemon when %s, then releases that lease', async (_label, acquireLocal) => {
    const directory = await dataDir();
    const child = await sender();
    const relay = relayTo(directory);
    const release = await acquireFeedbackSendLeaseWithRelay({ acquireLocal, relay, processId: child.pid });
    expect(inspectSendRecovery(directory)).toEqual([expect.objectContaining({ processId: child.pid, live: true })]);
    await release();
    expect(await leaseFiles(directory)).toEqual([]);
    expect(relay.calls.map(call => call.action)).toEqual(['acquire', 'release']);
  });

  it('does not route admission refusals or other failures through the daemon', async () => {
    const directory = await dataDir();
    const relay = relayTo(directory);
    await expect(acquireFeedbackSendLeaseWithRelay({
      acquireLocal: () => { throw new Error('feedback_storage_maintenance'); }, relay,
    })).rejects.toThrow('feedback_storage_maintenance');
    await expect(acquireFeedbackSendLeaseWithRelay({
      acquireLocal: () => { throw Object.assign(new Error('busy'), { code: 'ELOCKED' }); }, relay,
    })).rejects.toThrow('busy');
    expect(relay.calls).toEqual([]);
    await expect(acquireFeedbackSendLeaseWithRelay({ acquireLocal: sandboxDenied })).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('fails the send when the daemon refuses, and only warns when the release is lost', async () => {
    const directory = await dataDir();
    const child = await sender();
    await beginFeedbackMaintenance(directory, 'refuse');
    await expect(acquireFeedbackSendLeaseWithRelay({ acquireLocal: sandboxDenied, relay: relayTo(directory), processId: child.pid }))
      .rejects.toThrow('feedback_storage_maintenance');

    const open = await dataDir();
    const real = relayTo(open);
    let releases = 0;
    const lossy: FeedbackSendLeaseRelay = async body => {
      if (body.action === 'release') { releases += 1; throw new Error('ECONNREFUSED'); }
      return real(body);
    };
    const warn = vi.fn();
    const release = await acquireFeedbackSendLeaseWithRelay({ acquireLocal: sandboxDenied, relay: lossy, processId: child.pid, warn });
    await expect(release()).resolves.toBeUndefined();
    expect(releases).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(inspectSendRecovery(open)).toEqual([expect.objectContaining({ processId: child.pid, live: true })]);
  });

  it('times out an unanswered acquire even when the transport ignores cancellation', async () => {
    let signal: AbortSignal | undefined;
    const hanging: FeedbackSendLeaseRelay = (_body, requestSignal) => {
      signal = requestSignal;
      return new Promise(() => {});
    };
    await expect(acquireFeedbackSendLeaseWithRelay({
      acquireLocal: sandboxDenied, relay: hanging, timeoutMs: 20,
    })).rejects.toThrow('feedback_send_lease_relay_timeout');
    expect(signal?.aborted).toBe(true);
  });

  it('warns and finishes after an unanswered release instead of hanging the delivered send', async () => {
    const warn = vi.fn();
    const hangingRelease: FeedbackSendLeaseRelay = async (body, signal) => {
      if (body.action === 'acquire') return { ok: true, status: 200, body: { ok: true, lease: '123-abc.json', releaseToken: 'test-release-token' } };
      return new Promise(() => { signal.addEventListener('abort', () => {}, { once: true }); });
    };
    const release = await acquireFeedbackSendLeaseWithRelay({
      acquireLocal: sandboxDenied, relay: hangingRelease, processId: 123, timeoutMs: 20, warn,
    });
    await expect(release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('feedback_send_lease_relay_timeout'));
  });
});
