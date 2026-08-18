/**
 * Cross-generation containment handles: a mojo turn subtree must stay
 * identifiable — and stay BLOCKING — after the backend that spawned it is gone.
 *
 * Every case below is behavioural (no source-string assertions), so each one
 * pins one production rule and goes red if that rule is reverted. The rules:
 *
 *  1. an unreadable / corrupt store THROWS instead of reading as "nothing contained"
 *  2. a handle may only be released against a PROVEN verdict
 *  3. a weak handle cannot self-prove; a failed scan is not an empty scan
 *  4. the root pid exiting is NOT proof (a setsid descendant outlives it)
 *  5. generation replacement INHERITS outstanding handles, verbatim identity
 *  6. pid reuse must not be mistaken for the original tree
 *
 * PLATFORM SCOPE: every case builds its own synthetic /proc and cgroup under a
 * temp dir and passes it through the procRoot seam, so the file runs on ANY
 * platform. The two cases that deliberately consult the REAL kernel (a real
 * zombie, and the field-22 cross-check that guards the fixture itself) are
 * Linux-only and are gated with it.runIf(isLinux) so they SKIP off Linux instead
 * of silently reporting a pass they never performed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLinux } from './helpers/synthetic-proc.js';

import {
    MojoContainmentUnavailableError,
    acquireContainmentHandle,
    containmentHandles,
    containmentSessionIds,
    hasUnprovenContainment,
    inheritContainmentHandles,
    proveContainmentQuiescent,
    readProcLiveness,
    readProcStartTime,
    recordContainmentHandle,
    releaseContainmentHandle,
    weakHandleRootStillOriginal,
    containmentQuiescence,
    sessionContainmentQuiescence,
    type WeakContainmentHandle,
    type StrongContainmentHandle,
} from '../src/core/mojo-containment.js';

function freshDataDir(): string {
    return mkdtempSync(join(tmpdir(), 'mojo-containment-'));
}

describe('the strong proof reads the WHOLE cgroup subtree (round-7 P0-1, nested escape)', () => {
    // Runs on ANY platform (synthetic cgroup dirs), so — unlike the Linux-only
    // real-kernel escape probe — this ACTUALLY runs in CI. It models the migration
    // variant the single-level read missed: a same-uid process mkdir's a child
    // cgroup and migrates into it, leaving the leaf's own cgroup.procs empty.
    it('is NOT proven when a descendant cgroup still holds a LIVE process', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cg-nested-'));
        writeFileSync(join(dir, 'cgroup.procs'), '');      // leaf reads empty...
        mkdirSync(join(dir, 'evaded'));
        writeFileSync(join(dir, 'evaded', 'cgroup.procs'), '4242\n'); // ...child holds pid 4242
        // A synthetic /proc where 4242 is RUNNING, so the proof's liveness check
        // (which reads /proc, absent on macOS) sees it as executing rather than
        // gone. This isolates the RECURSION: the migrated-out pid is surfaced.
        const proc = mkdtempSync(join(tmpdir(), 'cg-nested-proc-'));
        mkdirSync(join(proc, '4242'));
        writeFileSync(join(proc, '4242', 'stat'), '4242 (mojo) R 1 0 0');
        const handle: StrongContainmentHandle = {
            kind: 'cgroup', sessionId: 's', generation: 1, cgroupPath: dir, nonce: 'n',
        };
        expect(proveContainmentQuiescent(handle, { procRoot: proc }).proven).toBe(false);
    });

    it('IS proven only when the whole subtree is empty', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cg-empty-'));
        writeFileSync(join(dir, 'cgroup.procs'), '');
        mkdirSync(join(dir, 'child'));
        writeFileSync(join(dir, 'child', 'cgroup.procs'), '');
        const handle: StrongContainmentHandle = {
            kind: 'cgroup', sessionId: 's', generation: 1, cgroupPath: dir, nonce: 'n',
        };
        expect(proveContainmentQuiescent(handle).proven).toBe(true);
    });
});

/** A synthetic /proc with a controllable boot id and one process. */
function fakeProc(opts: { bootId: string; pids?: Record<number, number> }): string {
    const root = mkdtempSync(join(tmpdir(), 'mojo-proc-'));
    mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), `${opts.bootId}\n`);
    for (const [pid, startTime] of Object.entries(opts.pids ?? {})) {
        mkdirSync(join(root, pid), { recursive: true });
        // Field 2 deliberately contains a space and a ')' — the real hazard in
        // /proc/<pid>/stat parsing. starttime is field 22.
        const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
        fields[18] = String(startTime);
        writeFileSync(join(root, pid, 'stat'), `${pid} (weird ) name) S ${fields.join(' ')}\n`);
    }
    return join(root);
}

const BOOT = '11111111-2222-3333-4444-555555555555';

function weak(over: Partial<WeakContainmentHandle> = {}): WeakContainmentHandle {
    return {
        kind: 'tree-identity',
        sessionId: 'sess-1',
        generation: 1,
        rootPid: 4242,
        bootId: BOOT,
        startTime: 999,
        nonce: 'nonce-abc',
        ...over,
    };
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise(r => setTimeout(r, 25));
    }
    return pred();
}

const dirs: string[] = [];
afterEach(() => { dirs.length = 0; });

describe('containment handle durability', () => {
    it('records a handle and reports it as unproven across a fresh read', () => {
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        // A fresh read, i.e. what the NEXT daemon process would see.
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
        expect(containmentSessionIds(dataDir)).toEqual(['sess-1']);
    });

    it('is idempotent: re-recording the same tree does not duplicate it', () => {
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        recordContainmentHandle(weak(), dataDir);
        expect(containmentHandles('sess-1', dataDir)).toHaveLength(1);
    });

    it('THROWS on a corrupt store instead of reporting nothing contained', () => {
        const dataDir = freshDataDir();
        writeFileSync(join(dataDir, 'mojo-containment-handles.json'), '{ not json');
        // Fail-open would be: return [] and let the blocker vanish.
        expect(() => containmentHandles('sess-1', dataDir)).toThrow(MojoContainmentUnavailableError);
        expect(() => hasUnprovenContainment('sess-1', dataDir)).toThrow();
    });

    it('THROWS on an unknown version rather than applying today rules blindly', () => {
        const dataDir = freshDataDir();
        writeFileSync(
            join(dataDir, 'mojo-containment-handles.json'),
            JSON.stringify({ version: 99, sessions: {} }),
        );
        expect(() => containmentHandles('sess-1', dataDir)).toThrow(MojoContainmentUnavailableError);
    });

    it('rejects the WHOLE file on one malformed handle, never silently emptying a session', () => {
        const dataDir = freshDataDir();
        writeFileSync(
            join(dataDir, 'mojo-containment-handles.json'),
            JSON.stringify({ version: 1, sessions: { 'sess-1': [{ kind: 'tree-identity', sessionId: 'sess-1' }] } }),
        );
        // Filtering the junk element out would leave sess-1 with zero handles,
        // i.e. unblocked by a single corrupt byte.
        expect(() => containmentHandles('sess-1', dataDir)).toThrow(MojoContainmentUnavailableError);
    });

    it('an EACCES store is not "absent": it must throw, not read as empty', () => {
        const dataDir = freshDataDir();
        const file = join(dataDir, 'mojo-containment-handles.json');
        writeFileSync(file, JSON.stringify({ version: 1, sessions: {} }));
        chmodSync(file, 0o000);
        let threw = false;
        try { containmentHandles('sess-1', dataDir); } catch { threw = true; }
        chmodSync(file, 0o600);
        // Skipped rather than asserted when running as root, where mode 000 is
        // still readable and the case cannot be exercised at all.
        if (process.getuid?.() !== 0) expect(threw).toBe(true);
    });
});

describe('operator revocation is the ONLY unproven exit (P1-3)', () => {
    it('revokes every handle of a session and clears its ledger entry', async () => {
        // A weak handle on a non-cgroup host never produces a boundary proof, and
        // an unprovable handle never releases by design — so without this exit the
        // device-isolation blocker (whole-machine activation_blocked 409) was
        // permanent, with hand-editing the ledger JSON as the only way out.
        const { revokeContainmentHandles } = await import('../src/core/mojo-containment.js');
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        recordContainmentHandle(weak({ rootPid: 5151, startTime: 1001 }), dataDir);

        const { removed, remaining } = revokeContainmentHandles('sess-1', { dataDir });

        expect(removed).toHaveLength(2);
        expect(remaining).toHaveLength(0);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(false);
        expect(containmentSessionIds(dataDir)).toEqual([]);
    });

    it('revokes only the named handle when a key is given', async () => {
        const { revokeContainmentHandles } = await import('../src/core/mojo-containment.js');
        const { containmentHandleKey } = await import('../src/core/mojo-containment.js');
        const dataDir = freshDataDir();
        const keep = weak();
        const drop = weak({ rootPid: 5151, startTime: 1001 });
        recordContainmentHandle(keep, dataDir);
        recordContainmentHandle(drop, dataDir);

        const { removed, remaining } = revokeContainmentHandles('sess-1', {
            dataDir,
            handleKey: containmentHandleKey(drop),
        });

        expect(removed.map(h => containmentHandleKey(h))).toEqual([containmentHandleKey(drop)]);
        expect(remaining.map(h => containmentHandleKey(h))).toEqual([containmentHandleKey(keep)]);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
    });

    it('is a no-op (and says so) for an unknown session or key', async () => {
        const { revokeContainmentHandles } = await import('../src/core/mojo-containment.js');
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        expect(revokeContainmentHandles('sess-unknown', { dataDir }).removed).toHaveLength(0);
        expect(revokeContainmentHandles('sess-1', { dataDir, handleKey: 'tree:no:such:key' }).removed)
            .toHaveLength(0);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
    });

    it('the command surface refuses without --yes and revokes with it', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        const out: string[] = [];
        const err: string[] = [];
        const deps = {
            dataDir,
            isSessionActive: () => false,
            stdout: (l: string) => out.push(l),
            stderr: (l: string) => err.push(l),
        };

        expect(await runMojoContainmentCommand(['revoke', 'sess-1'], deps)).toBe(1);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
        expect(err.join('\n')).toMatch(/--yes/);

        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes'], deps)).toBe(0);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(false);
        expect(out.join('\n')).toMatch(/已撤销/);
    });

    it('the list surface names every outstanding handle', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        const out: string[] = [];
        expect(await runMojoContainmentCommand(['list'], { dataDir, stdout: (l) => out.push(l) })).toBe(0);
        expect(out.join('\n')).toContain('sess-1');
        expect(out.join('\n')).toContain(`tree:${BOOT}:4242:999`);
    });

    it('default-REJECTS revoking a weak handle whose root is still the original live process (P1-c)', async () => {
        // Revoking wrong = credential leak: dropping the handle of a subtree
        // that is still alive stops tracking a process still holding the
        // injected JWT. The gate uses the same identity primitive as the
        // runtime kill gate (boot id + starttime), and --force is the recorded
        // override, not the default.
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        // A synthetic /proc where the recorded root VERIFIES as still-original.
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 999 } });
        recordContainmentHandle(weak(), dataDir);
        const out: string[] = [];
        const err: string[] = [];
        const deps = {
            dataDir,
            procRoot,
            isSessionActive: () => false,
            stdout: (l: string) => out.push(l),
            stderr: (l: string) => err.push(l),
        };

        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes'], deps)).toBe(1);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
        expect(err.join('\n')).toMatch(/仍是原进程且存活/);
        expect(err.join('\n')).toMatch(/--force/);

        // --force overrides, and says so on stdout (the audit line carries it too).
        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes', '--force'], deps)).toBe(0);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(false);
        expect(out.join('\n')).toMatch(/--force 越过存活证据/);
    });

    it('default-REJECTS revoking while the session row is still active (P1-c)', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        const err: string[] = [];
        const deps = {
            dataDir,
            isSessionActive: () => true,
            stdout: () => { /* ignore */ },
            stderr: (l: string) => err.push(l),
        };
        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes'], deps)).toBe(1);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
        expect(err.join('\n')).toMatch(/active/);
        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes', '--force'], deps)).toBe(0);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(false);
    });

    it('surfaces a corrupt ledger as a message instead of a stack trace', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        writeFileSync(join(dataDir, 'mojo-containment-handles.json'), '{ not json');
        const err: string[] = [];
        expect(await runMojoContainmentCommand(['list'], {
            dataDir,
            stdout: () => { /* ignore */ },
            stderr: (l: string) => err.push(l),
        })).toBe(1);
        expect(err.join('\n')).toMatch(/账本不可用/);
    });

    it('records the --force override in the OPERATOR REVOCATION audit line', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const { logger } = await import('../src/utils/logger.js');
        const warnSpy = vi.spyOn(logger, 'warn');
        const dataDir = freshDataDir();
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 999 } });
        recordContainmentHandle(weak(), dataDir);
        try {
            expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes', '--force'], {
                dataDir,
                procRoot,
                isSessionActive: () => false,
                stdout: () => { /* ignore */ },
                stderr: () => { /* ignore */ },
            })).toBe(0);
            const auditLines = warnSpy.mock.calls.map(c => String(c[0]))
                .filter(l => l.includes('OPERATOR REVOCATION'));
            expect(auditLines).toHaveLength(1);
            expect(auditLines[0]).toContain('--force past LIVE evidence');
            expect(auditLines[0]).toContain('4242');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('rejects unknown flags and stray positionals instead of silently ignoring them', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        const err: string[] = [];
        const deps = {
            dataDir,
            isSessionActive: () => false,
            stdout: () => { /* ignore */ },
            stderr: (l: string) => err.push(l),
        };
        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes', '--wipe-all'], deps)).toBe(1);
        expect(err.join('\n')).toMatch(/未知参数/);
        expect(await runMojoContainmentCommand(['revoke', 'sess-1', 'sess-2', '--yes'], deps)).toBe(1);
        expect(err.join('\n')).toMatch(/多余的参数/);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
    });

    it('surfaces "evidence unavailable" instead of a silently passing gate', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        // A procRoot with no boot_id models hidepid/non-Linux: the weak-handle
        // liveness probe cannot run at all — the gate must SAY so, not no-op.
        const bareProcRoot = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        const err: string[] = [];
        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--yes'], {
            dataDir,
            procRoot: bareProcRoot,
            isSessionActive: () => undefined,   // session store unreadable
            stdout: () => { /* ignore */ },
            stderr: (l: string) => err.push(l),
        })).toBe(0);
        expect(err.join('\n')).toMatch(/存活检测/);
        expect(err.join('\n')).toMatch(/会话库不可读/);
        // Unavailable evidence never blocks — it informs.
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(false);
    });

    it('defaultIsSessionActive is genuinely tri-state (round-4: the implementation itself)', async () => {
        // Every revoke test injects isSessionActive, so a permissive rewrite of
        // the default (`return false`) previously survived the suite. Pin the
        // implementation: active row → true, closed row → false, absent row →
        // false, and — the load-bearing leg — a CORRUPT session file yields
        // `undefined` (evidence unavailable), never a silent "proven inactive".
        const { defaultIsSessionActive } = await import('../src/core/mojo-containment-command.js');
        const { config } = await import('../src/config.js');
        const dataDir = freshDataDir();
        const prevDataDir = config.session.dataDir;
        config.session.dataDir = dataDir;
        try {
            writeFileSync(join(dataDir, 'sessions-app.json'), JSON.stringify({
                's-active': { sessionId: 's-active', status: 'active' },
                's-closed': { sessionId: 's-closed', status: 'closed' },
            }));
            expect(await defaultIsSessionActive('s-active')).toBe(true);
            expect(await defaultIsSessionActive('s-closed')).toBe(false);
            expect(await defaultIsSessionActive('s-absent')).toBe(false);

            writeFileSync(join(dataDir, 'sessions-broken.json'), '{ not json');
            // The corrupt file may be the very one hiding the row: unknown.
            expect(await defaultIsSessionActive('s-maybe-hidden')).toBe(undefined);
            // A row still FOUND in a readable file answers definitively even
            // beside a corrupt sibling.
            expect(await defaultIsSessionActive('s-active')).toBe(true);
        } finally {
            config.session.dataDir = prevDataDir;
        }
    });

    it('rejects a --handle whose value is another switch instead of eating --yes', async () => {
        const { runMojoContainmentCommand } = await import('../src/core/mojo-containment-command.js');
        const dataDir = freshDataDir();
        recordContainmentHandle(weak(), dataDir);
        const err: string[] = [];
        expect(await runMojoContainmentCommand(['revoke', 'sess-1', '--handle', '--yes'], {
            dataDir,
            isSessionActive: () => false,
            stdout: () => { /* ignore */ },
            stderr: (l: string) => err.push(l),
        })).toBe(1);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
        expect(err.join('\n')).toMatch(/--handle 需要一个 handle key/);
    });
});

describe('release requires proof', () => {
    it('refuses to release on an UNPROVEN verdict, keeping the session blocked', () => {
        const dataDir = freshDataDir();
        const handle = weak();
        recordContainmentHandle(handle, dataDir);
        expect(() => releaseContainmentHandle(
            { proven: false, handle, reason: 'subtree still has live members', residualPids: [4242] },
            dataDir,
        )).toThrow(MojoContainmentUnavailableError);
        // The point of the rule: the blocker survives the refused release.
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
    });

    it('releases only on BOUNDARY-proven evidence, and drops the session from the blocker set', () => {
        // A reboot is the one thing a weak handle can prove without /proc: the
        // recorded tree cannot have survived the boot id changing under it.
        const dataDir = freshDataDir();
        const handle = weak();
        recordContainmentHandle(handle, dataDir);
        releaseContainmentHandle({ proven: true, handle, evidence: 'boot-id-changed' }, dataDir);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(false);
        expect(containmentSessionIds(dataDir)).toEqual([]);
    });

    it('a merely SCAN-CLEAN weak verdict does not drop the session from the blocker set', () => {
        // Previously this shape released the handle, which is exactly how a clean
        // /proc scan came to authorise a plain closed row. It must not any more:
        // the close may proceed, the isolation stays.
        const dataDir = freshDataDir();
        const handle = weak();
        recordContainmentHandle(handle, dataDir);
        const decision = releaseContainmentHandle({ proven: true, handle, evidence: 'scan-clean' }, dataDir);
        expect(decision.boundaryProof).toBe(false);
        expect(decision.releaseAuthorised).toBe(false);
        expect(decision.signalsStopped).toBe(true);
        expect(decision.residual?.deviceIsolation).toBe(true);
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
    });

    it('releasing one generation handle leaves a sibling generation blocked', () => {
        const dataDir = freshDataDir();
        const g1 = weak({ generation: 1, rootPid: 100, startTime: 11 });
        const g2 = weak({ generation: 2, rootPid: 200, startTime: 22 });
        recordContainmentHandle(g1, dataDir);
        recordContainmentHandle(g2, dataDir);
        releaseContainmentHandle({ proven: true, handle: g1, evidence: 'boot-id-changed' }, dataDir);
        const left = containmentHandles('sess-1', dataDir);
        expect(left).toHaveLength(1);
        expect((left[0] as WeakContainmentHandle).rootPid).toBe(200);
    });
});

describe('proving quiescence fails closed', () => {
    it('a weak handle cannot prove itself without a scan', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 999 } });
        const verdict = proveContainmentQuiescent(weak(), { procRoot });
        expect(verdict.proven).toBe(false);
    });

    it('a FAILED scan is not an empty scan', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 999 } });
        const verdict = proveContainmentQuiescent(weak(), {
            procRoot,
            // The scanner's fail-closed signal. Collapsing this into "no pids"
            // is the exact fail-open this case exists to catch.
            scan: () => ({ scanned: false, pids: [], reason: 'cannot read /proc' }),
        });
        expect(verdict.proven).toBe(false);
        if (!verdict.proven) expect(verdict.reason).toContain('scan failed');
    });

    it('surviving pids are reported, not rounded down to proven', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 999 } });
        const verdict = proveContainmentQuiescent(weak(), {
            procRoot,
            scan: () => ({ scanned: true, pids: [5150] }),
        });
        expect(verdict.proven).toBe(false);
        if (!verdict.proven) expect(verdict.residualPids).toEqual([5150]);
    });

    it('a clean scan on the same boot proves quiescence', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: {} });
        const verdict = proveContainmentQuiescent(weak(), {
            procRoot,
            scan: () => ({ scanned: true, pids: [] }),
        });
        expect(verdict.proven).toBe(true);
    });

    it('the ROOT pid being gone is not proof on its own (setsid descendants outlive it)', () => {
        // Root 4242 absent from /proc, but the scan still finds an escaped child.
        const procRoot = fakeProc({ bootId: BOOT, pids: {} });
        const verdict = proveContainmentQuiescent(weak(), {
            procRoot,
            scan: () => ({ scanned: true, pids: [7777] }),
        });
        expect(verdict.proven).toBe(false);
    });

    it('a different boot id IS proof: the recorded tree cannot have survived a reboot', () => {
        const procRoot = fakeProc({ bootId: 'aaaaaaaa-0000-0000-0000-000000000000', pids: {} });
        // No scan supplied on purpose — the reboot alone settles it.
        const verdict = proveContainmentQuiescent(weak(), { procRoot });
        expect(verdict.proven).toBe(true);
    });

    it('an unreadable boot id fails closed rather than ageing the tree out', () => {
        const verdict = proveContainmentQuiescent(weak(), {
            procRoot: join(tmpdir(), 'definitely-not-a-proc-root'),
            scan: () => ({ scanned: true, pids: [] }),
        });
        expect(verdict.proven).toBe(false);
    });

    it('an unreadable cgroup.procs fails closed (only ENOENT is proof)', () => {
        const strong: StrongContainmentHandle = {
            kind: 'cgroup',
            sessionId: 'sess-1',
            generation: 1,
            cgroupPath: join(tmpdir(), 'mojo-cgroup-that-exists-not', 'nested'),
            nonce: 'n',
        };
        // ENOENT on the DIRECTORY is proof (the kernel refuses rmdir on a
        // non-empty cgroup), so build an EACCES-style unreadable case instead.
        const dir = mkdtempSync(join(tmpdir(), 'mojo-cgroup-'));
        writeFileSync(join(dir, 'cgroup.procs'), '4242\n');
        // A member is only a blocker if it is EXECUTING, so this needs a /proc in
        // which 4242 exists and is not a zombie.
        const running = mkdtempSync(join(tmpdir(), 'mojo-proc-run-'));
        mkdirSync(join(running, '4242'), { recursive: true });
        writeFileSync(join(running, '4242/stat'), '4242 (weird ) name) S 0 0 0\n');
        const busy = proveContainmentQuiescent({ ...strong, cgroupPath: dir }, { procRoot: running });
        expect(busy.proven).toBe(false);
        if (!busy.proven) expect(busy.residualPids).toEqual([4242]);
        // And an empty procs file is genuine proof.
        writeFileSync(join(dir, 'cgroup.procs'), '');
        expect(proveContainmentQuiescent({ ...strong, cgroupPath: dir }, { procRoot: running }).proven).toBe(true);
    });
});

describe('generation replacement inherits the tree', () => {
    it('a new generation inherits outstanding handles with identity preserved', () => {
        const dataDir = freshDataDir();
        recordContainmentHandle(weak({ generation: 1, rootPid: 4242, startTime: 999 }), dataDir);
        const inherited = inheritContainmentHandles('sess-1', 7, dataDir);
        expect(inherited).toHaveLength(1);
        const h = inherited[0] as WeakContainmentHandle;
        // Generation is refreshed for logs...
        expect(h.generation).toBe(7);
        // ...but the IDENTITY must be verbatim, or the handle proves nothing about
        // the tree actually left behind.
        expect(h.rootPid).toBe(4242);
        expect(h.startTime).toBe(999);
        expect(h.bootId).toBe(BOOT);
        expect(h.nonce).toBe('nonce-abc');
        // Still blocking: replacement proved nothing.
        expect(hasUnprovenContainment('sess-1', dataDir)).toBe(true);
    });

    it('inheritance never drops a handle, so the blocker survives N replacements', () => {
        const dataDir = freshDataDir();
        recordContainmentHandle(weak({ rootPid: 1, startTime: 1 }), dataDir);
        recordContainmentHandle(weak({ rootPid: 2, startTime: 2 }), dataDir);
        for (let gen = 2; gen < 6; gen++) inheritContainmentHandles('sess-1', gen, dataDir);
        expect(containmentHandles('sess-1', dataDir)).toHaveLength(2);
    });

    it('inheriting a session with nothing outstanding is a no-op', () => {
        const dataDir = freshDataDir();
        expect(inheritContainmentHandles('sess-nothing', 2, dataDir)).toEqual([]);
        expect(containmentSessionIds(dataDir)).toEqual([]);
    });
});

describe('pid reuse cannot masquerade as the original tree', () => {
    it('a recycled pid with a different starttime is NOT the original root', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 5000 } });
        // Same pid, different starttime → a new process wearing an old pid.
        expect(weakHandleRootStillOriginal(weak({ startTime: 999 }), { procRoot })).toBe(false);
    });

    it('the original root is recognised while it is still the same process', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 999 } });
        expect(weakHandleRootStillOriginal(weak({ startTime: 999 }), { procRoot })).toBe(true);
    });

    it('a pid from a previous boot is never claimed as ours', () => {
        const procRoot = fakeProc({ bootId: 'ffffffff-0000-0000-0000-000000000000', pids: { 4242: 999 } });
        expect(weakHandleRootStillOriginal(weak({ startTime: 999 }), { procRoot })).toBe(false);
    });

    it('parses starttime past a comm containing spaces and a close paren', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: { 4242: 31337 } });
        expect(readProcStartTime(4242, { procRoot })).toBe(31337);
    });

    it('a vanished pid reads as null, not as 0', () => {
        const procRoot = fakeProc({ bootId: BOOT, pids: {} });
        // 0 would compare falsy-equal against a real starttime in a sloppy check.
        expect(readProcStartTime(4242, { procRoot })).toBeNull();
    });
});

describe('readProcStartTime agrees with the real kernel', () => {
    // Guards the FIXTURE above: an off-by-one in the synthetic /proc would
    // otherwise let a wrong field index look "tested". Computed here by a
    // deliberately different route — a naive whitespace split of the whole line,
    // which is valid precisely because this process's comm ("node") has no
    // spaces — so it cannot share a bug with the production parser.
    // Linux-only: there is no real /proc to cross-check against elsewhere. Kept as
    // an explicit skip rather than an early return, so it can never look green on
    // a platform where it did nothing.
    it.runIf(isLinux && existsSync('/proc/self/stat'))('reads field 22 of a real /proc/<pid>/stat', () => {
        const raw = readFileSync('/proc/self/stat', 'utf8').trim();
        const comm = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'));
        if (/\s/.test(comm)) return;                  // naive split would be wrong
        const expected = Number(raw.split(/\s+/)[21]);
        expect(readProcStartTime(process.pid)).toBe(expected);
    });
});

describe('an unreadable cgroup is not an empty cgroup', () => {
    it('a non-ENOENT read failure on cgroup.procs fails closed', () => {
        // `cgroup.procs` made a DIRECTORY: read() yields EISDIR, which is neither
        // ENOENT nor bypassable by root, so the "cannot tell" branch is genuinely
        // exercised. Only an ABSENT directory is proof (the kernel refuses rmdir
        // on a non-empty cgroup); every other error must keep the blocker.
        const dir = mkdtempSync(join(tmpdir(), 'mojo-cgroup-unreadable-'));
        mkdirSync(join(dir, 'cgroup.procs'));
        const verdict = proveContainmentQuiescent({
            kind: 'cgroup',
            sessionId: 'sess-1',
            generation: 1,
            cgroupPath: dir,
            nonce: 'n',
        });
        expect(verdict.proven).toBe(false);
        if (!verdict.proven) expect(verdict.reason).toContain('cannot read');
    });

    it('an ABSENT cgroup directory is proof, because rmdir refuses a non-empty one', () => {
        const verdict = proveContainmentQuiescent({
            kind: 'cgroup',
            sessionId: 'sess-1',
            generation: 1,
            cgroupPath: join(tmpdir(), `mojo-cgroup-gone-${process.pid}`),
            nonce: 'n',
        });
        expect(verdict.proven).toBe(true);
    });
});

describe('zombie members do not wedge a cgroup forever', () => {
    function cgroupWith(pids: number[]): string {
        const dir = mkdtempSync(join(tmpdir(), 'mojo-cg-'));
        writeFileSync(join(dir, 'cgroup.procs'), pids.length ? `${pids.join('\n')}\n` : '');
        return dir;
    }
    function strongAt(dir: string): StrongContainmentHandle {
        return { kind: 'cgroup', sessionId: 'sess-z', generation: 1, cgroupPath: dir, nonce: 'n' };
    }
    /** Synthetic /proc where each pid gets an explicit state letter. */
    function procWithStates(states: Record<number, string>): string {
        const root = mkdtempSync(join(tmpdir(), 'mojo-proc-st-'));
        mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
        writeFileSync(join(root, 'sys/kernel/random/boot_id'), `${BOOT}\n`);
        for (const [pid, st] of Object.entries(states)) {
            mkdirSync(join(root, pid), { recursive: true });
            const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
            fields[0] = st;                  // field 3 = state
            fields[18] = '4242';             // field 22 = starttime
            writeFileSync(join(root, pid, 'stat'), `${pid} (weird ) name) ${fields.join(' ')}\n`);
        }
        return root;
    }

    it('a zombie-only cgroup IS proven quiescent (it can never execute again)', () => {
        // Otherwise: close succeeds, blocker never clears, rmdir fails forever.
        const dir = cgroupWith([501, 502]);
        const procRoot = procWithStates({ 501: 'Z', 502: 'Z' });
        const verdict = proveContainmentQuiescent(strongAt(dir), { procRoot });
        expect(verdict.proven).toBe(true);
        if (verdict.proven) expect(verdict.reason).toContain('zombie-only');
    });

    it('one RUNNING member among zombies still blocks', () => {
        const dir = cgroupWith([501, 502]);
        const procRoot = procWithStates({ 501: 'Z', 502: 'S' });
        const verdict = proveContainmentQuiescent(strongAt(dir), { procRoot });
        expect(verdict.proven).toBe(false);
        // Only the executing pid is reported, not the harmless zombie.
        if (!verdict.proven) expect(verdict.residualPids).toEqual([502]);
    });

    it('an UNREADABLE state counts as executing, not as a zombie', () => {
        // The fail-open shortcut would be "cannot read state => assume harmless".
        const dir = cgroupWith([777]);
        const procRoot = procWithStates({});
        // `stat` made a DIRECTORY: the read fails with EISDIR, which is neither
        // ENOENT ("gone") nor a readable state, and is not bypassable by root.
        mkdirSync(join(procRoot, '777/stat'), { recursive: true });
        expect(readProcLiveness(777, { procRoot })).toBe('unreadable');
        const verdict = proveContainmentQuiescent(strongAt(dir), { procRoot });
        expect(verdict.proven).toBe(false);
    });

    it('a member that raced away between listing and stat is not a blocker', () => {
        const dir = cgroupWith([999]);
        const procRoot = procWithStates({});      // 999 absent entirely => gone
        expect(proveContainmentQuiescent(strongAt(dir), { procRoot }).proven).toBe(true);
    });

    // Linux-only: needs a real fork/exit and the kernel's own zombie state.
    it.runIf(isLinux)('classifies a REAL zombie as zombie, and a live process as running', async () => {
        // A genuine zombie: the grandchild exits while its parent sleeps without
        // reaping, so the kernel keeps it in state Z. Nothing synthetic here.
        // bash is NOT usable as the non-reaping parent: it maintains its job table
        // via waitpid, so it reaps a backgrounded child and the zombie never
        // persists. Python's os.fork() parent reaps nothing unless asked.
        const parent = spawn('python3', ['-c',
            'import os,time,sys\n'
            + 'pid=os.fork()\n'
            + 'if pid==0: os._exit(0)\n'
            + 'sys.stdout.write(str(pid)+"\\n"); sys.stdout.flush()\n'
            + 'time.sleep(30)\n',
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        parent.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        try {
            expect(await waitFor(() => out.trim().length > 0)).toBe(true);
            const zpid = Number(out.trim());
            expect(Number.isInteger(zpid)).toBe(true);
            // A REAL zombie, held by a real non-reaping parent.
            expect(await waitFor(() => readProcLiveness(zpid) === 'zombie', 5_000)).toBe(true);
            // ...and the live parent must not be mistaken for one.
            expect(readProcLiveness(parent.pid as number)).toBe('running');
            // End to end: a cgroup listing only that zombie is proven quiescent,
            // so the blocker and the cgroup directory can actually be reclaimed.
            const dir = cgroupWith([zpid]);
            const verdict = proveContainmentQuiescent(strongAt(dir));
            expect(verdict.proven).toBe(true);
            if (verdict.proven) expect(verdict.reason).toContain('zombie-only');
        } finally {
            try { parent.kill('SIGKILL'); } catch { /* gone */ }
        }
    }, 20_000);
});

describe('a reboot is the ONLY source of boundaryProof: true (round-8 same-UID P0)', () => {
    const strong: StrongContainmentHandle = {
        kind: 'cgroup', sessionId: 'sess-p', generation: 1,
        cgroupPath: join(tmpdir(), 'nope'), nonce: 'n',
    };

    it('a proven STRONG (cgroup) handle is diagnostic-clean, NOT a boundary proof', () => {
        // cgroup emptiness is no longer a boundary proof: mojo runs at the daemon's
        // UID and can migrate itself out of the leaf (to the parent slice or a
        // sibling), invisible to the leaf-down read. The close still proceeds
        // (signals stop) but as a RESIDUAL — the device-isolation blocker is kept.
        const q = containmentQuiescence({ proven: true, handle: strong });
        expect(q.boundaryProof).toBe(false);
        expect(q.kind).toBe('diagnostic-clean');
    });

    it('a WEAK boot-id-changed verdict is the one thing that DOES mint a boundary proof', () => {
        // A reboot provably killed every process — the only unforgeable release.
        const q = containmentQuiescence({ proven: true, handle: weak(), evidence: 'boot-id-changed' });
        expect(q).toEqual({ kind: 'contained-proven', boundaryProof: true });
    });

    it('a proven WEAK handle is only diagnostic-clean, never a boundary proof', () => {
        // A weak handle is best-effort /proc evidence, so it must not license
        // clearing a blocker whose bar is an unforgeable boundary.
        const q = containmentQuiescence({ proven: true, handle: weak() });
        expect(q.boundaryProof).toBe(false);
        expect(q.kind).toBe('diagnostic-clean');
    });

    it('an unproven verdict with residual pids maps to alive', () => {
        const q = containmentQuiescence({
            proven: false, handle: strong, reason: 'cgroup still has executing members', residualPids: [7],
        });
        expect(q).toEqual({ kind: 'alive', boundaryProof: false, pids: [7] });
    });

    it('an unproven verdict with no pids maps to unscannable, not to clean', () => {
        const q = containmentQuiescence({ proven: false, handle: strong, reason: 'cannot read cgroup.procs' });
        expect(q.kind).toBe('unscannable');
        expect(q.boundaryProof).toBe(false);
    });

    it('NO verdict shape can mint boundaryProof through a weak handle', () => {
        // Exhaustive over the verdict space for a weak handle: none may claim a
        // boundary proof. This is the guard ProcTree's M1 mirrors from the other
        // side (a clean scan must never mint boundaryProof either).
        const verdicts = [
            { proven: true as const, handle: weak() },
            { proven: false as const, handle: weak(), reason: 'x' },
            { proven: false as const, handle: weak(), reason: 'y', residualPids: [1] },
        ];
        for (const v of verdicts) expect(containmentQuiescence(v).boundaryProof).toBe(false);
    });
});

describe('session-level quiescence takes the weakest outstanding tree', () => {
    const dataDirs = (): string => mkdtempSync(join(tmpdir(), 'mojo-sess-q-'));
    const cg = (id: string, path: string): StrongContainmentHandle => ({
        kind: 'cgroup', sessionId: id, generation: 1, cgroupPath: path, nonce: 'n',
    });

    it('no outstanding handles is diagnostic-clean, NOT a boundary proof', () => {
        // "nothing recorded" must not masquerade as kernel-level containment.
        const q = sessionContainmentQuiescence('sess-empty', () => { throw new Error('unreachable'); }, dataDirs());
        expect(q).toEqual({ kind: 'diagnostic-clean', boundaryProof: false });
    });

    it('all-strong and all-proven is diagnostic-clean now (cgroup emptiness is not a proof)', () => {
        const d = dataDirs();
        recordContainmentHandle(cg('s1', '/cg/a'), d);
        recordContainmentHandle(cg('s1', '/cg/b'), d);
        const q = sessionContainmentQuiescence('s1', h => ({ proven: true, handle: h }), d);
        // Every member proven-empty, yet no boundary proof — the blocker survives
        // (a same-UID process could have migrated out of any of these leaves).
        expect(q.boundaryProof).toBe(false);
        expect(q.kind).toBe('diagnostic-clean');
    });

    it('ONE weak handle downgrades the whole session to diagnostic-clean', () => {
        const d = dataDirs();
        recordContainmentHandle(cg('s2', '/cg/a'), d);
        recordContainmentHandle({ ...weak(), sessionId: 's2' }, d);
        const q = sessionContainmentQuiescence('s2', h => ({ proven: true, handle: h }), d);
        expect(q.boundaryProof).toBe(false);
    });

    it('ONE unproven handle makes the whole session unproven', () => {
        const d = dataDirs();
        recordContainmentHandle(cg('s3', '/cg/a'), d);
        recordContainmentHandle(cg('s3', '/cg/b'), d);
        const q = sessionContainmentQuiescence('s3', h => (
            h.kind === 'cgroup' && h.cgroupPath === '/cg/b'
                ? { proven: false, handle: h, reason: 'busy', residualPids: [9] }
                : { proven: true, handle: h }
        ), d);
        expect(q.boundaryProof).toBe(false);
        expect(q.kind).toBe('alive');
    });

    it('an unreadable store THROWS rather than presenting a clean session', () => {
        const d = dataDirs();
        writeFileSync(join(d, 'mojo-containment-handles.json'), '{ nope');
        expect(() => sessionContainmentQuiescence('s4', h => ({ proven: true, handle: h }), d)).toThrow();
    });
});

describe('a host that can prove nothing still keeps its blocker', () => {
    /** A host with neither cgroup v2 nor a readable /proc — i.e. Darwin. */
    function barrenHost(): { procRoot: string; cgroupRoot: string } {
        return {
            procRoot: mkdtempSync(join(tmpdir(), 'noproc-')),
            cgroupRoot: mkdtempSync(join(tmpdir(), 'nocg-')),
        };
    }

    it('mints an UNPROVABLE handle instead of nothing at all', () => {
        // The regression this pins: acquire used to return null here, so the caller
        // recorded nothing, hasUnprovenContainment answered false, and the blocker
        // was dropped on exactly the platform that can never prove anything.
        const h = acquireContainmentHandle(
            { sessionId: 'darwin-1', generation: 1, rootPid: 4242, nonce: 'n' },
            { ...barrenHost(), platform: 'darwin' },
        );
        expect(h).not.toBeNull();
        expect(h.kind).toBe('unprovable');
        if (h.kind === 'unprovable') expect(h.platform).toBe('darwin');
    });

    it('records it, so a cold read still reports the session as blocked', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'darwin-store-'));
        const h = acquireContainmentHandle(
            { sessionId: 'darwin-2', generation: 1, rootPid: 4242, nonce: 'n' },
            { ...barrenHost(), platform: 'darwin' },
        );
        recordContainmentHandle(h, dataDir);
        // The whole point: a fresh process still sees the blocker.
        expect(hasUnprovenContainment('darwin-2', dataDir)).toBe(true);
        expect(containmentSessionIds(dataDir)).toContain('darwin-2');
    });

    it('can NEVER be proven quiescent, however it is asked', () => {
        const h = acquireContainmentHandle(
            { sessionId: 'darwin-3', generation: 1, rootPid: 4242, nonce: 'n' },
            { ...barrenHost(), platform: 'darwin' },
        );
        // Even handed a clean scan, an unprovable handle stays unproven: there is
        // no evidence on this host that could settle it.
        for (const opts of [{}, { scan: () => ({ scanned: true, pids: [] }) }]) {
            const v = proveContainmentQuiescent(h, opts as never);
            expect(v.proven).toBe(false);
        }
    });

    it('can never be released, so the blocker cannot be laundered away', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'darwin-store2-'));
        const h = acquireContainmentHandle(
            { sessionId: 'darwin-4', generation: 1, rootPid: 4242, nonce: 'n' },
            { ...barrenHost(), platform: 'darwin' },
        );
        recordContainmentHandle(h, dataDir);
        const verdict = proveContainmentQuiescent(h, {});
        expect(() => releaseContainmentHandle(verdict, dataDir)).toThrow();
        expect(hasUnprovenContainment('darwin-4', dataDir)).toBe(true);
    });

    it('survives a restart: the persisted record parses back as unprovable', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'darwin-store3-'));
        const h = acquireContainmentHandle(
            { sessionId: 'darwin-5', generation: 1, rootPid: 4242, nonce: 'n' },
            { ...barrenHost(), platform: 'darwin' },
        );
        recordContainmentHandle(h, dataDir);
        // Cold read = what the next daemon process sees.
        const back = containmentHandles('darwin-5', dataDir);
        expect(back).toHaveLength(1);
        expect(back[0].kind).toBe('unprovable');
        // ...and inheritance carries it to the next generation unchanged.
        const inherited = inheritContainmentHandles('darwin-5', 2, dataDir);
        expect(inherited[0].kind).toBe('unprovable');
        expect(hasUnprovenContainment('darwin-5', dataDir)).toBe(true);
    });

    it('maps to unsupported-platform, which is what the residual close keys on', () => {
        const h = acquireContainmentHandle(
            { sessionId: 'darwin-6', generation: 1, rootPid: 4242, nonce: 'n' },
            { ...barrenHost(), platform: 'darwin' },
        );
        const q = containmentQuiescence(proveContainmentQuiescent(h, {}));
        expect(q.kind).toBe('unsupported-platform');
        expect(q.boundaryProof).toBe(false);
        if (q.kind === 'unsupported-platform') expect(q.platform).toBe('darwin');
    });

    it('one unprovable handle downgrades the whole session', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'darwin-store4-'));
        recordContainmentHandle(
            { kind: 'cgroup', sessionId: 'mix', generation: 1, cgroupPath: '/cg/a', nonce: 'n' },
            dataDir,
        );
        recordContainmentHandle(
            acquireContainmentHandle({ sessionId: 'mix', generation: 1, rootPid: 1, nonce: 'n' },
                { ...barrenHost(), platform: 'darwin' }),
            dataDir,
        );
        const q = sessionContainmentQuiescence('mix', h => (
            h.kind === 'cgroup' ? { proven: true, handle: h } : proveContainmentQuiescent(h, {})
        ), dataDir);
        // A strong proven sibling must not lift the session to contained-proven.
        expect(q.boundaryProof).toBe(false);
    });
});

describe('an impossible verdict is still safe', () => {
    it('a hand-constructed proven-unprovable verdict never mints a boundary proof', () => {
        // proveContainmentQuiescent cannot produce this, which is why there is no
        // dedicated branch for it. This pins the FALLTHROUGH: even if a caller
        // fabricates the impossible, it must not become a credential-boundary proof.
        const q = containmentQuiescence({
            proven: true,
            handle: {
                kind: 'unprovable', sessionId: 's', generation: 1,
                nonce: 'n', platform: 'darwin', reason: 'fabricated',
            },
        });
        expect(q.boundaryProof).toBe(false);
    });
});

describe('a cgroup handle is NEVER released by proof (round-8 same-UID P0)', () => {
    // cgroup emptiness stopped being a boundary proof: a same-UID process can
    // migrate itself out of the leaf. So EVERY cgroup verdict — empty, zombie-only,
    // or populated — keeps the handle and the device-isolation blocker. Only a
    // weak boot-id-changed (a reboot) or an operator revoke can drop it.
    const cases: Array<[string, string, 'cgroup-empty' | 'cgroup-zombie-only']> = [
        ['an empty cgroup', '', 'cgroup-empty'],
        ['a populated cgroup', '4242\n', 'cgroup-empty'],
        ['a zombie-only cgroup', '', 'cgroup-zombie-only'],
    ];
    for (const [label, procs, evidence] of cases) {
        it(`retains the handle and blocker for ${label}`, () => {
            const dataDir = mkdtempSync(join(tmpdir(), 'cg-no-release-'));
            const dir = mkdtempSync(join(tmpdir(), 'cg-'));
            writeFileSync(join(dir, 'cgroup.procs'), procs);
            const handle: StrongContainmentHandle = {
                kind: 'cgroup', sessionId: 'nr-sess', generation: 1, cgroupPath: dir, nonce: 'n',
            };
            recordContainmentHandle(handle, dataDir);
            const decision = releaseContainmentHandle({ proven: true, handle, evidence }, dataDir);
            expect(decision.releaseAuthorised).toBe(false);
            expect(decision.residual).not.toBeNull();
            // Close still proceeds (signals stop) but the blocker survives.
            expect(decision.signalsStopped).toBe(true);
            expect(hasUnprovenContainment('nr-sess', dataDir)).toBe(true);
        });
    }

    it('a WEAK boot-id-changed verdict IS released (the one real proof: a reboot)', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'cg-reboot-'));
        const handle = { ...weak(), sessionId: 'reboot-sess' };
        recordContainmentHandle(handle, dataDir);
        const decision = releaseContainmentHandle(
            { proven: true, handle, evidence: 'boot-id-changed' }, dataDir,
        );
        expect(decision.releaseAuthorised).toBe(true);
        expect(hasUnprovenContainment('reboot-sess', dataDir)).toBe(false);
    });
});
