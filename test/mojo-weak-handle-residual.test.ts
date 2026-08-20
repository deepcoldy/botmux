/**
 * The weak-handle release contract: a clean /proc scan may stop the signals, and
 * it may let the SESSION close, but it may not authorise forgetting the tree.
 *
 * Reviewer's reproduction, which every case here exists to keep dead:
 *   weak handle scans empty -> proveContainmentQuiescent proven:true
 *   -> releaseContainmentHandle -> handle gone -> plain closed row
 *   -> device-isolation blocker vanishes, while boundaryProof was false all along.
 *
 * The third synthetic /proc shape is the one that matters: a descendant that
 * calls setsid(), scrubs the nonce out of its environ and reparents to init is
 * ALIVE yet enumerates as members: [].
 *
 * No real /proc is read anywhere in this file (every read goes through the
 * procRoot seam), and no cgroup is required, so it runs on any platform.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    MojoContainmentUnavailableError,
    containmentHandles,
    containmentQuiescence,
    containmentReleaseDecision,
    hasUnprovenContainment,
    proveContainmentQuiescent,
    recordContainmentHandle,
    releaseContainmentHandle,
    type QuiescenceVerdict,
    type StrongContainmentHandle,
    type WeakContainmentHandle,
} from '../src/core/mojo-containment.js';

const BOOT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const BOOT_B = 'bbbbbbbb-1111-2222-3333-444444444444';

function dataDir(): string {
    return mkdtempSync(join(tmpdir(), 'mojo-weak-residual-'));
}

/** Synthetic /proc holding nothing but a boot id: no real /proc is touched. */
function fakeProcRoot(bootId: string): string {
    const root = mkdtempSync(join(tmpdir(), 'mojo-weak-proc-'));
    mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), `${bootId}\n`);
    return root;
}

function weak(sessionId = 'sess-weak'): WeakContainmentHandle {
    return {
        kind: 'tree-identity', sessionId, generation: 1, nonce: 'nonce-1',
        rootPid: 4242, bootId: BOOT_A, startTime: 99,
    };
}

function strong(sessionId = 'sess-strong'): StrongContainmentHandle {
    // Path intentionally absent: ENOENT on cgroup.procs is the kernel's own proof
    // that the cgroup was empty when it was removed.
    return {
        kind: 'cgroup', sessionId, generation: 1, nonce: 'nonce-1',
        cgroupPath: join(tmpdir(), 'mojo-no-such-cgroup', sessionId),
    };
}

/** The reviewer's third probe shape: alive, but invisible to enumeration. */
const setsidEvader = () => ({ scanned: true as const, pids: [] as number[] });

describe('a clean weak scan is diagnostic evidence, not a release authority', () => {
    it('labels the clean weak scan scan-clean and refuses to authorise release', () => {
        const verdict = proveContainmentQuiescent(weak(), {
            procRoot: fakeProcRoot(BOOT_A),
            scan: setsidEvader,
        });
        expect(verdict.proven).toBe(true);
        if (verdict.proven) expect(verdict.evidence).toBe('scan-clean');

        const decision = containmentReleaseDecision(verdict);
        expect(decision.boundaryProof).toBe(false);
        expect(decision.releaseAuthorised).toBe(false);
        // The close is still allowed to progress, so the signals must stop...
        expect(decision.signalsStopped).toBe(true);
        // ...but the isolation stays behind.
        expect(decision.residual).not.toBeNull();
        expect(decision.residual?.deviceIsolation).toBe(true);
    });

    it('KEEPS the handle in the durable store, so the blocker survives the close', () => {
        const dir = dataDir();
        const handle = weak();
        recordContainmentHandle(handle, dir);

        const verdict = proveContainmentQuiescent(handle, {
            procRoot: fakeProcRoot(BOOT_A),
            scan: setsidEvader,
        });
        // Not a throw: refusing the close outright would wedge the session, which
        // is the failure mode the reviewer explicitly did NOT want.
        const decision = releaseContainmentHandle(verdict, dir);
        expect(decision.releaseAuthorised).toBe(false);
        expect(decision.residual?.deviceIsolation).toBe(true);

        // The actual regression guard: the row is still there.
        expect(containmentHandles(handle.sessionId, dir)).toHaveLength(1);
        expect(hasUnprovenContainment(handle.sessionId, dir)).toBe(true);
    });

    it('cannot be laundered into a boundary proof by a hand-built verdict', () => {
        // Every proven-weak shape a caller could construct, including one that
        // claims cgroup-grade evidence on a weak handle.
        const shapes: QuiescenceVerdict[] = [
            { proven: true, handle: weak() },
            { proven: true, handle: weak(), evidence: 'scan-clean' },
            { proven: true, handle: weak(), evidence: 'cgroup-empty' },
            { proven: true, handle: weak(), evidence: 'cgroup-zombie-only' },
        ];
        for (const v of shapes) {
            const d = containmentReleaseDecision(v);
            expect(d.boundaryProof).toBe(false);
            expect(d.releaseAuthorised).toBe(false);
            expect(d.residual?.deviceIsolation).toBe(true);
            expect(containmentQuiescence(v)).toEqual({ kind: 'diagnostic-clean', boundaryProof: false });
        }
    });

    it('an absent evidence field defaults DOWN to scan-clean, never up', () => {
        const d = containmentReleaseDecision({ proven: true, handle: weak() });
        expect(d.evidence).toBe('scan-clean');
        expect(d.boundaryProof).toBe(false);
    });
});

describe('what a weak handle CAN prove, and what a strong one still proves', () => {
    it('a changed boot id releases the weak handle: the tree cannot have survived', () => {
        const dir = dataDir();
        const handle = weak('sess-rebooted');
        recordContainmentHandle(handle, dir);

        // Recorded under BOOT_A, host now reports BOOT_B.
        const verdict = proveContainmentQuiescent(handle, { procRoot: fakeProcRoot(BOOT_B) });
        expect(verdict.proven).toBe(true);
        if (verdict.proven) expect(verdict.evidence).toBe('boot-id-changed');

        const decision = releaseContainmentHandle(verdict, dir);
        expect(decision.boundaryProof).toBe(true);
        expect(decision.residual).toBeNull();
        expect(hasUnprovenContainment(handle.sessionId, dir)).toBe(false);
        expect(containmentQuiescence(verdict)).toEqual({ kind: 'contained-proven', boundaryProof: true });
    });

    it('a strong handle whose cgroup is gone is STILL not released (round-8 same-UID P0)', () => {
        // An empty/gone cgroup used to release with no residual. It no longer does:
        // a same-UID process can migrate out of the leaf, so leaf-emptiness is not a
        // boundary proof. The close proceeds (signals stop) but the blocker stays;
        // only a reboot or an operator revoke drops it.
        const dir = dataDir();
        const handle = strong();
        recordContainmentHandle(handle, dir);

        const verdict = proveContainmentQuiescent(handle);
        expect(verdict.proven).toBe(true);
        if (verdict.proven) expect(verdict.evidence).toBe('cgroup-empty');

        const decision = releaseContainmentHandle(verdict, dir);
        expect(decision.boundaryProof).toBe(false);
        expect(decision.releaseAuthorised).toBe(false);
        expect(decision.residual?.deviceIsolation).toBe(true);
        expect(decision.signalsStopped).toBe(true);
        expect(hasUnprovenContainment(handle.sessionId, dir)).toBe(true);
    });

    it('an UNPROVEN verdict still throws, and keeps the handle', () => {
        const dir = dataDir();
        const handle = weak('sess-unproven');
        recordContainmentHandle(handle, dir);

        // Same boot, no scan supplied: a weak handle cannot self-prove.
        const verdict = proveContainmentQuiescent(handle, { procRoot: fakeProcRoot(BOOT_A) });
        expect(verdict.proven).toBe(false);

        const decision = containmentReleaseDecision(verdict);
        expect(decision.evidence).toBe('not-proven');
        expect(decision.signalsStopped).toBe(false);
        expect(decision.residual?.deviceIsolation).toBe(true);

        expect(() => releaseContainmentHandle(verdict, dir)).toThrow(MojoContainmentUnavailableError);
        expect(hasUnprovenContainment(handle.sessionId, dir)).toBe(true);
    });

    it('a scan that FOUND pids reports them in the residual', () => {
        const verdict = proveContainmentQuiescent(weak(), {
            procRoot: fakeProcRoot(BOOT_A),
            scan: () => ({ scanned: true, pids: [4242, 4243] }),
        });
        expect(verdict.proven).toBe(false);
        const d = containmentReleaseDecision(verdict);
        expect(d.residual?.pids).toEqual([4242, 4243]);
        expect(d.boundaryProof).toBe(false);
    });
});
