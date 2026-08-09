import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attestManagedOrigin,
  MANAGED_ORIGIN_PROOF_DOMAIN,
  ManagedOriginAttestationError,
  writeManagedOriginAttestationProof,
} from '../src/core/managed-origin-attestation.js';
import {
  ensureManagedOriginAttestationDirectory,
  managedOriginAttestationProofPath,
} from '../src/core/managed-origin-capability.js';

describe('managed-origin host proof sidecar', () => {
  const CHANNEL = '77'.repeat(32);
  const roots: string[] = [];
  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-origin-attest-'));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('accepts only the nonce-bound host file and ignores the HTTP body', async () => {
    const dataDir = makeRoot();
    const context = {
      dataDir,
      sessionId: 'session-a',
      channelId: CHANNEL,
      capability: 'ab'.repeat(32),
      ipcPortFallback: 4321,
    };
    const nonce = 'cd'.repeat(32);
    const result = await attestManagedOrigin({
      context,
      nonce,
      fetchImpl: async () => {
        writeManagedOriginAttestationProof({
          dataDir,
          proof: {
            domain: MANAGED_ORIGIN_PROOF_DOMAIN,
            version: 1,
            nonce,
            channelId: CHANNEL,
            sessionId: context.sessionId,
            turnId: 'turn-live',
            dispatchAttempt: 4,
            requiresCodexAppLedger: true,
            issuedAtMs: Date.now(),
          },
        });
        return new Response(JSON.stringify({
          // Deliberately forged transport body: it must never win.
          turnId: 'turn-forged',
        }), { status: 200 });
      },
    });
    expect(result).toEqual({
      sessionId: 'session-a',
      turnId: 'turn-live',
      dispatchAttempt: 4,
      requiresCodexAppLedger: true,
    });
  });

  it('rejects expired proof bytes even when HTTP returns 200', async () => {
    const dataDir = makeRoot();
    let now = 50_000;
    const nonce = 'ef'.repeat(32);
    await expect(attestManagedOrigin({
      context: {
        dataDir,
        sessionId: 'session-a',
        channelId: CHANNEL,
        capability: 'ab'.repeat(32),
        ipcPortFallback: 4321,
      },
      nonce,
      timeoutMs: 3,
      now: () => now,
      wait: async delay => { now += delay; },
      fetchImpl: async () => {
        writeManagedOriginAttestationProof({
          dataDir,
          proof: {
            domain: MANAGED_ORIGIN_PROOF_DOMAIN,
            version: 1,
            nonce,
            channelId: CHANNEL,
            sessionId: 'session-a',
            turnId: 'turn-old',
            requiresCodexAppLedger: false,
            issuedAtMs: 1,
          },
        });
        return new Response(null, { status: 200 });
      },
    })).rejects.toBeInstanceOf(ManagedOriginAttestationError);
  });

  it('fails closed on a pre-existing symlink leaf without touching its target', () => {
    const dataDir = makeRoot();
    const nonce = '12'.repeat(32);
    ensureManagedOriginAttestationDirectory(dataDir, 'session-a', CHANNEL);
    const target = join(dataDir, 'target');
    writeFileSync(target, 'keep');
    symlinkSync(target, managedOriginAttestationProofPath(dataDir, 'session-a', CHANNEL, nonce));
    expect(() => writeManagedOriginAttestationProof({
      dataDir,
      proof: {
        domain: MANAGED_ORIGIN_PROOF_DOMAIN,
        version: 1,
        nonce,
        channelId: CHANNEL,
        sessionId: 'session-a',
        turnId: 'turn',
        requiresCodexAppLedger: false,
        issuedAtMs: Date.now(),
      },
    })).toThrow();
    expect(existsSync(target)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('opens a FIFO proof nonblocking and times out', async () => {
    const dataDir = makeRoot();
    const nonce = '34'.repeat(32);
    ensureManagedOriginAttestationDirectory(dataDir, 'session-a', CHANNEL);
    execFileSync('mkfifo', [managedOriginAttestationProofPath(dataDir, 'session-a', CHANNEL, nonce)]);
    let now = 1_000;
    await expect(attestManagedOrigin({
      context: {
        dataDir,
        sessionId: 'session-a',
        channelId: CHANNEL,
        capability: 'ab'.repeat(32),
        ipcPortFallback: 4321,
      },
      nonce,
      timeoutMs: 2,
      now: () => now,
      wait: async delay => { now += delay; },
      fetchImpl: async () => new Response(null, { status: 200 }),
    })).rejects.toThrow(/未生成有效/);
  });

  it('removes an oversized proof leaf after rejecting it', () => {
    const dataDir = makeRoot();
    const nonce = '56'.repeat(32);
    const path = managedOriginAttestationProofPath(dataDir, 'session-a', CHANNEL, nonce);
    expect(() => writeManagedOriginAttestationProof({
      dataDir,
      proof: {
        domain: MANAGED_ORIGIN_PROOF_DOMAIN,
        version: 1,
        nonce,
        channelId: CHANNEL,
        sessionId: 'session-a',
        turnId: 't'.repeat(9_000),
        requiresCodexAppLedger: false,
        issuedAtMs: Date.now(),
      },
    })).toThrow(/size limit/);
    expect(existsSync(path)).toBe(false);
  });
});
