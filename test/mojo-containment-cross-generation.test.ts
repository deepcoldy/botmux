/**
 * REAL-PROBE regression: a credentialed descendant that escaped via setsid() must
 * still be found — and must still block — after the process that spawned it, its
 * worker generation, and the daemon itself are all gone.
 *
 * This is the scenario the cross-generation hole was reported for. Before
 * mojo-containment existed, the only record of a turn subtree lived in two
 * per-instance MojoBackend fields: `lastTurnPid` and a `treeNonce` randomised in
 * its field initialiser. A replacement generation therefore started with a null
 * root pid and a nonce that matches nothing, so `terminateChildProven()` took its
 * "no turn ever spawned, so there is no subtree" branch and returned TRUE. The
 * close was reported successful, the row was published `closed`, and because
 * mergePersistedDeviceIsolationSessions filters closed rows the device-isolation
 * blocker disappeared while a real process still held the injected credential.
 *
 * Nothing here is mocked: a genuine `setsid` grandchild is started, survives the
 * death of its parent, and is observed through the real /proc.
 *
 * Run:  pnpm vitest run test/mojo-containment-cross-generation.test.ts
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
    acquireContainmentHandle,
    containmentHandles,
    hasUnprovenContainment,
    inheritContainmentHandles,
    proveContainmentQuiescent,
    recordContainmentHandle,
    releaseContainmentHandle,
    type WeakContainmentHandle,
} from '../src/core/mojo-containment.js';
import { MOJO_TREE_NONCE_ENV, scanMojoTree } from '../src/adapters/backend/mojo-process-tree.js';

const LINUX = process.platform === 'linux' && existsSync('/proc/self/stat');

let workDir: string;
const strays: number[] = [];

beforeAll(() => { workDir = mkdtempSync(join(tmpdir(), 'mojo-xgen-')); });
afterAll(() => {
    for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(workDir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await sleep(25);
    }
    return pred();
}

/**
 * Start a turn-like parent that leaves a setsid() GRANDCHILD behind and exits.
 *
 * The grandchild carries the tree nonce in its environment and ignores SIGTERM,
 * which is exactly the shape that defeats a `kill(-pgid)`.
 *
 * Its stdio is redirected to /dev/null on purpose: inheriting our pipe would keep
 * `spawnSync` blocked until the grandchild exited, which silently turned this
 * probe into a 120-second wait that observed only an already-dead process.
 */
async function spawnEscapedDescendant(nonce: string): Promise<{ parentPid: number; escapedPid: number }> {
    const pidFile = join(workDir, `escaped-${Math.random().toString(36).slice(2)}.pid`);
    const script = join(workDir, `leave-descendant-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(
        script,
        '#!/usr/bin/env bash\n'
        // setsid: a NEW session and group, so the original pgid can never reach it.
        + `setsid bash -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 120' `
        + '</dev/null >/dev/null 2>&1 &\n'
        + 'exit 0\n',
    );
    chmodSync(script, 0o755);
    const parent = spawnSync(script, [], {
        env: { ...process.env, [MOJO_TREE_NONCE_ENV]: nonce },
        encoding: 'utf8',
        timeout: 10_000,
    });
    expect(parent.status).toBe(0);
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const escapedPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(escapedPid)).toBe(true);
    strays.push(escapedPid);
    // The pid file is written before `exec sleep`, so wait until it is really live.
    expect(await waitFor(() => alive(escapedPid))).toBe(true);
    return { parentPid: parent.pid ?? -1, escapedPid };
}

/** The scan evidence a caller feeds a weak handle, using the real scanner. */
function realScan(handle: WeakContainmentHandle): { scanned: boolean; pids: number[]; reason?: string } {
    const scan = scanMojoTree(handle.rootPid, handle.nonce, {
        excludePids: [process.pid, process.ppid],
    });
    return scan.ok
        ? { scanned: true, pids: scan.members.map(m => m.pid) }
        : { scanned: false, pids: [], reason: scan.reason };
}

describe.skipIf(!LINUX)('a real escaped descendant survives generation replacement', () => {
    it('is still found, and still blocks, from a FRESH store read', async () => {
        const dataDir = mkdtempSync(join(workDir, 'store-a-'));
        const nonce = `botmux-mojo-xgen-${process.pid}-a`;
        const { parentPid, escapedPid } = await spawnEscapedDescendant(nonce);

        // The turn's direct child has already exited, so generation 1 mints the
        // handle from the live subtree root it can still see. (In production the
        // handle is minted at spawn, while the direct child is live; either way the
        // recorded identity is what a later generation inherits.)
        const handle = acquireContainmentHandle(
            { sessionId: 'sess-xgen', generation: 1, rootPid: escapedPid, nonce },
            {},
        );
        expect(handle).not.toBeNull();
        recordContainmentHandle(handle!, dataDir);

        // ── the parent is gone; this is the state the old code mishandled ──
        expect(alive(parentPid)).toBe(false);
        expect(alive(escapedPid)).toBe(true);

        // Generation 2 / a restarted daemon: nothing in memory, only the store.
        // This is the read that used to return "no subtree" and let the close pass.
        expect(hasUnprovenContainment('sess-xgen', dataDir)).toBe(true);
        const inherited = inheritContainmentHandles('sess-xgen', 2, dataDir);
        expect(inherited).toHaveLength(1);

        // And the inherited handle really does still see the live process.
        const verdict = proveContainmentQuiescent(inherited[0], { scan: realScan });
        expect(verdict.proven).toBe(false);
        if (!verdict.proven) expect(verdict.residualPids ?? []).toContain(escapedPid);

        // The blocker cannot be dropped while that is true.
        expect(() => releaseContainmentHandle(verdict, dataDir)).toThrow();
        expect(hasUnprovenContainment('sess-xgen', dataDir)).toBe(true);

        try { process.kill(escapedPid, 'SIGKILL'); } catch { /* gone */ }
    }, 30_000);

    it('SIGTERM alone is not proof; only a real kill retires the handle', async () => {
        const dataDir = mkdtempSync(join(workDir, 'store-b-'));
        const nonce = `botmux-mojo-xgen-${process.pid}-b`;
        const { escapedPid } = await spawnEscapedDescendant(nonce);

        const handle = acquireContainmentHandle(
            { sessionId: 'sess-xgen-b', generation: 1, rootPid: escapedPid, nonce },
            {},
        );
        expect(handle).not.toBeNull();
        recordContainmentHandle(handle!, dataDir);

        // Still alive → refused.
        expect(proveContainmentQuiescent(handle!, { scan: realScan }).proven).toBe(false);

        // The probe traps TERM, so a DELIVERED signal changes nothing. This is why
        // `child.kill('SIGTERM')` returning true was never proof of teardown.
        try { process.kill(escapedPid, 'SIGTERM'); } catch { /* gone */ }
        await sleep(200);
        expect(alive(escapedPid)).toBe(true);
        expect(proveContainmentQuiescent(handle!, { scan: realScan }).proven).toBe(false);

        try { process.kill(escapedPid, 'SIGKILL'); } catch { /* gone */ }
        // Not our child, so nothing here can reap it; wait for /proc to drop it.
        expect(await waitFor(() => !existsSync(`/proc/${escapedPid}`))).toBe(true);

        const after = proveContainmentQuiescent(handle!, { scan: realScan });
        expect(after.proven).toBe(true);
        if (after.proven) expect(after.evidence).toBe('scan-clean');
        // The kill stops the signalling loop, but this host offers no unforgeable
        // boundary: a sibling that setsid'd and scrubbed its environ would have
        // been invisible to the very scan that just came back clean. So the close
        // may proceed while the handle - and the blocker - stay behind.
        const decision = releaseContainmentHandle(after, dataDir);
        expect(decision.signalsStopped).toBe(true);
        expect(decision.releaseAuthorised).toBe(false);
        expect(decision.residual?.deviceIsolation).toBe(true);
        expect(hasUnprovenContainment('sess-xgen-b', dataDir)).toBe(true);
        expect(containmentHandles('sess-xgen-b', dataDir)).toHaveLength(1);
    }, 30_000);

    it('records a starttime, so a recycled pid cannot inherit the block', async () => {
        // Pid reuse is the failure mode a bare pid record invites: signalling it
        // would kill an unrelated process, and finding it would falsely block.
        const nonce = `botmux-mojo-xgen-${process.pid}-c`;
        const { escapedPid } = await spawnEscapedDescendant(nonce);
        const real = acquireContainmentHandle(
            { sessionId: 'sess-xgen-c', generation: 1, rootPid: escapedPid, nonce },
            {},
        ) as WeakContainmentHandle | null;
        expect(real).not.toBeNull();
        expect(real!.kind).toBe('tree-identity');
        expect(real!.startTime).toBeGreaterThan(0);
        expect(real!.bootId.length).toBeGreaterThan(0);

        // A handle whose starttime cannot match the pid's current occupant must not
        // be treated as naming a live tree.
        const stale: WeakContainmentHandle = { ...real!, startTime: real!.startTime - 1 };
        const { weakHandleRootStillOriginal } = await import('../src/core/mojo-containment.js');
        expect(weakHandleRootStillOriginal(real!)).toBe(true);
        expect(weakHandleRootStillOriginal(stale)).toBe(false);

        try { process.kill(escapedPid, 'SIGKILL'); } catch { /* gone */ }
    }, 30_000);
});
