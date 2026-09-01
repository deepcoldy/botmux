/**
 * TASK 9 — four synthetic probes, each reproducing one reported vulnerability and
 * then checking whether the landed code actually closes it.
 *
 * These are PROBES, not guard tests: every one prints the value it observed, so
 * the report carries real output rather than a claim. A probe that fails here is
 * evidence the corresponding fix is not done — that is the point, and a red probe
 * must be reported as red rather than adjusted until it passes.
 *
 * Probe 1 — an escaped (setsid) descendant must never be judged proven.
 * Probe 2 — after generation replacement, destroySession() must not return ok:true.
 * Probe 3 — after a REFUSED abort, write() must not be re-admitted.
 * Probe 4 — after a daemon crash, the taskId must not be lost.
 *
 * WHICH BRANCHES EACH PROBE NEEDS (so a red is never misread as a regression)
 * -------------------------------------------------------------------------
 *   P1, P2  need work/proctree  (scanner + TurnQuiescence) and this module.
 *   P2      additionally needs task 7-A wiring to PASS; until that lands it is
 *           EXPECTED RED and is the acceptance test for 7-A.
 *   P3      needs work/fencing. On a containment-only tree abortDestroySession
 *           still returns void, so P3 is EXPECTED RED there -- that is the
 *           absence of the fix, not a broken probe.
 *   P4      needs nothing beyond node; it exercises the durability mechanism.
 *
 * On the fully merged tree the expected state is: P1 P3 P4 green, P2 red until 7-A.
 *
 * Run:  npx vitest run test/mojo-task9-probes.test.ts
 *
 * PLATFORM SCOPE: probe 1 reproduces the escape with a REAL setsid descendant and
 * reads the host's real /proc to decide when it is gone, so it is Linux-only and
 * gated with describe.runIf(isLinux) — off Linux it SKIPS rather than failing for
 * the absence of /proc, which would be noise rather than evidence.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import {
    acquireContainmentHandle,
    containmentHandles,
    hasUnprovenContainment,
    inheritContainmentHandles,
    proveContainmentQuiescent,
    readProcLiveness,
    recordContainmentHandle,
} from '../src/core/mojo-containment.js';
import { MOJO_TREE_NONCE_ENV, scanMojoTree } from '../src/adapters/backend/mojo-process-tree.js';
import { isLinux } from './helpers/synthetic-proc.js';

/** Linux-only: real setsid escape + real /proc liveness. */
const describeLinux = describe.runIf(isLinux);

let binDir: string;
const strays: number[] = [];
const findings: string[] = [];

beforeAll(() => { binDir = mkdtempSync(join(tmpdir(), 'mojo-task9-')); });
afterAll(() => {
    for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(binDir, { recursive: true, force: true });
    // Printed as one block so the report can quote observed values verbatim.
    console.log('\n===== TASK 9 PROBE OBSERVATIONS =====');
    for (const line of findings) console.log(line);
    console.log('=====================================\n');
});

function note(line: string): void { findings.push(line); console.log(`[probe] ${line}`); }

function fakeMojo(name: string, body: string): string {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (pred()) return true; await sleep(25); }
    return pred();
}

/** Shrinks the proof budget so the escalation ladder runs in ms, as production does. */
class FastProofBackend extends MojoBackend {
    protected override get terminationProofBudgetMs(): number { return 400; }
}

describeLinux('PROBE 1 — an escaped descendant must never be judged proven', () => {
    it('reproduces the escape and reports what the code concludes', async () => {
        // A real setsid grandchild that ignores SIGTERM: it leaves the original
        // process group and session, so kill(-pgid) can never reach it, and it
        // outlives the direct child whose exit clears `this.child`.
        const pidFile = join(binDir, 'p1-escaped.pid');
        const bin = fakeMojo('mojo-p1', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
setsid bash -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 120' </dev/null >/dev/null 2>&1 &
echo '{"type":"system","subtype":"init","session_id":"sid-p1"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-p1","warnings":[]}'
exit 0`);

        const backend = new FastProofBackend({ bin }, 'probe1-session');
        backend.spawn('', [], {} as never);
        backend.write('leave a descendant behind');
        expect(await waitFor(() => existsSync(pidFile))).toBe(true);
        const escaped = Number(readFileSync(pidFile, 'utf8').trim());
        strays.push(escaped);
        expect(await waitFor(() => alive(escaped))).toBe(true);
        note(`P1: escaped setsid descendant pid=${escaped}, alive=${alive(escaped)}`);

        // The scanner must SEE it: this is the enumeration half of the contract.
        const nonce = (backend as unknown as { treeNonce: string }).treeNonce;
        const rootPid = (backend as unknown as { lastTurnPid: number | null }).lastTurnPid;
        const scan = scanMojoTree(rootPid ?? escaped, nonce, { excludePids: [process.pid, process.ppid] });
        const seen = scan.ok ? scan.members.map(m => m.pid) : [];
        note(`P1: scanner ok=${scan.ok} sees_escaped=${seen.includes(escaped)} members=${JSON.stringify(seen)}`);
        expect(scan.ok).toBe(true);
        expect(seen).toContain(escaped);

        // And the verdict must NOT be a credential-boundary proof while it lives.
        const q = await (backend as unknown as {
            proveTurnQuiescence: () => Promise<{ kind: string; boundaryProof: boolean }>;
        }).proveTurnQuiescence();
        note(`P1: proveTurnQuiescence -> kind=${q.kind} boundaryProof=${q.boundaryProof} (alive=${alive(escaped)})`);

        // THE ASSERTION: a live escaped descendant may never be a boundary proof.
        expect(q.boundaryProof).toBe(false);
        // ...and it must not even be reported as clean while it is demonstrably alive.
        if (alive(escaped)) expect(q.kind).not.toBe('diagnostic-clean');

        try { process.kill(escaped, 'SIGKILL'); } catch { /* gone */ }
    }, 40_000);

    it('containment refuses to release while the escapee lives, and allows it after', async () => {
        // The same question asked of the durable handle, which is the part that has
        // to survive the backend object going away.
        const dataDir = mkdtempSync(join(binDir, 'p1-store-'));
        const nonce = `botmux-mojo-probe1-${process.pid}`;
        const script = join(binDir, 'p1b.sh');
        writeFileSync(script, '#!/usr/bin/env bash\n'
            + `setsid bash -c 'trap "" TERM; echo $$ > "${binDir}/p1b.pid"; exec sleep 120' </dev/null >/dev/null 2>&1 &\nexit 0\n`);
        chmodSync(script, 0o755);
        spawnSync(script, [], { env: { ...process.env, [MOJO_TREE_NONCE_ENV]: nonce }, timeout: 10_000 });
        expect(await waitFor(() => existsSync(`${binDir}/p1b.pid`))).toBe(true);
        const escaped = Number(readFileSync(`${binDir}/p1b.pid`, 'utf8').trim());
        strays.push(escaped);

        const handle = acquireContainmentHandle(
            { sessionId: 'probe1b', generation: 1, rootPid: escaped, nonce }, {},
        );
        expect(handle).not.toBeNull();
        recordContainmentHandle(handle!, dataDir);
        const scanFn = (h: { rootPid: number; nonce: string }): { scanned: boolean; pids: number[]; reason?: string } => {
            const s = scanMojoTree(h.rootPid, h.nonce, { excludePids: [process.pid, process.ppid] });
            return s.ok ? { scanned: true, pids: s.members.map(m => m.pid) } : { scanned: false, pids: [], reason: s.reason };
        };
        const before = proveContainmentQuiescent(handle!, { scan: scanFn as never });
        note(`P1b: while alive -> proven=${before.proven} reason=${'reason' in before ? before.reason : '-'}`);
        expect(before.proven).toBe(false);
        expect(hasUnprovenContainment('probe1b', dataDir)).toBe(true);

        try { process.kill(escaped, 'SIGKILL'); } catch { /* gone */ }
        expect(await waitFor(() => !existsSync(`/proc/${escaped}`))).toBe(true);
        const after = proveContainmentQuiescent(handle!, { scan: scanFn as never });
        note(`P1b: after real SIGKILL -> proven=${after.proven}`);
        expect(after.proven).toBe(true);
    }, 40_000);
});

describe('PROBE 2 — after generation replacement, the close must be honest about the old subtree', () => {
    // Linux-only like PROBE 1: the fixture leaks a real setsid survivor and the
    // wait conditions read the real /proc. The companion refusal case below stays
    // cross-platform — its fake tree never leaves the mocked scan.
    it.runIf(isLinux)('a REPLACEMENT backend terminates the inherited survivor before reporting success', async () => {
        // The originally reported hole. Generation 1 leaves a credentialed setsid
        // survivor. Generation 2 is a FRESH MojoBackend for the same session, so
        // `lastTurnPid` is null and nothing in memory reaches the old tree.
        //
        // ASSERTION HISTORY — read before "simplifying" this test.
        //
        // It first asserted `ok === false`, because at the time the code could only
        // ever PROVE an inherited tree, never signal it, so a live survivor made a
        // successful close a lie. Measured then:
        //     nonce_inherited=false, destroySession -> {"ok":true},
        //     escaped still alive after close=true          <-- ok:true was a lie
        //
        // The inheritance wedge fix changed the ground truth: an inherited handle is
        // now signalled per member, so the survivor is really killed. Measured now:
        //     nonce_inherited=true,  destroySession -> {"ok":true},
        //     escaped still alive after close=false         <-- ok:true is honest
        //
        // So the assertion is no longer "never ok:true"; it is "ok:true only once the
        // subtree is genuinely gone". Keeping the old form would have demanded the
        // close stay broken. The companion case below pins the other direction, so
        // this pair cannot be satisfied by simply always returning ok:true.
        const pidFile = join(binDir, 'p2-escaped.pid');
        const bin = fakeMojo('mojo-p2', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
setsid bash -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 120' </dev/null >/dev/null 2>&1 &
echo '{"type":"system","subtype":"init","session_id":"sid-p2"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-p2","warnings":[]}'
exit 0`);

        const gen1 = new FastProofBackend({ bin }, 'probe2-session');
        gen1.spawn('', [], {} as never);
        gen1.write('turn that leaks a descendant');
        expect(await waitFor(() => existsSync(pidFile))).toBe(true);
        const escaped = Number(readFileSync(pidFile, 'utf8').trim());
        strays.push(escaped);
        expect(await waitFor(() => alive(escaped))).toBe(true);

        // Generation replacement: the old object is discarded entirely, exactly as
        // restartCliProcess does.
        const gen2 = new FastProofBackend({ bin }, 'probe2-session');
        const gen2Root = (gen2 as unknown as { lastTurnPid: number | null }).lastTurnPid;
        const gen1Nonce = (gen1 as unknown as { treeNonce: string }).treeNonce;
        const gen2Nonce = (gen2 as unknown as { treeNonce: string }).treeNonce;
        note(`P2: gen2 lastTurnPid=${JSON.stringify(gen2Root)} nonce_inherited=${gen1Nonce === gen2Nonce}`);
        note(`P2: old subtree pid=${escaped} still alive=${alive(escaped)}`);

        const result = await gen2.destroySession();
        note(`P2: gen2.destroySession() -> ${JSON.stringify(result)}`);
        const q = gen2.lastTurnQuiescence;
        note(`P2: gen2.lastTurnQuiescence -> ${JSON.stringify(q)}`);

        // Liveness via /proc state, NOT kill(pid, 0): a SIGKILLed child sits in state
        // Z until its parent reaps it, and kill(pid, 0) answers TRUE for a zombie. So
        // the cheap check would call an un-reaped corpse "still running" and make this
        // assertion flap depending on reap timing.
        const liveness = readProcLiveness(escaped);
        const stillExecuting = liveness === 'running' || liveness === 'unreadable';
        note(`P2: escaped still alive after close=${alive(escaped)}`);
        note(`P2: escaped liveness=${liveness} stillExecuting=${stillExecuting}`);

        // The real invariant: the close may only succeed once nothing is executing.
        if (result.ok) {
            expect(stillExecuting).toBe(false);
        } else {
            note('P2: close refused — acceptable, but then the blocker must be retained');
        }
        // A clean /proc scan is never a credential-boundary proof, whatever the close said.
        expect(q?.boundaryProof ?? false).toBe(false);

        try { process.kill(escaped, 'SIGKILL'); } catch { /* gone */ }
    }, 40_000);

    it('refuses the close when an inherited member CANNOT be terminated', async () => {
        // The other half of the pair. Without this, "always return ok:true" would
        // satisfy the case above, so this is what stops the fix from degenerating
        // back into laundering.
        //
        // A synthetic /proc whose member never disappears models a process that
        // cannot be killed (uninterruptible sleep, or a pid we may not signal). The
        // recorded handle names it, so discharge must fail and the close must refuse.
        const dataDir = mkdtempSync(join(binDir, 'p2c-store-'));
        const procRoot = mkdtempSync(join(binDir, 'p2c-proc-'));
        const nonce = `botmux-mojo-p2c-${process.pid}`;
        const immortal = 4242;
        mkdirSync(join(procRoot, 'sys/kernel/random'), { recursive: true });
        const bootId = '99999999-8888-7777-6666-555555555555';
        writeFileSync(join(procRoot, 'sys/kernel/random/boot_id'), `${bootId}\n`);
        mkdirSync(join(procRoot, String(immortal)), { recursive: true });
        // state R (running, not a zombie) so it cannot be discounted, starttime at
        // field 22, and the nonce in environ so the scanner claims it as a member.
        const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
        fields[0] = 'R';
        fields[18] = '777';
        writeFileSync(join(procRoot, String(immortal), 'stat'), `${immortal} (immortal) ${fields.join(' ')}\n`);
        writeFileSync(join(procRoot, String(immortal), 'environ'), `${MOJO_TREE_NONCE_ENV}=${nonce}\0`);

        const { config } = await import('../src/config.js');
        const prevDataDir = config.session.dataDir;
        config.session.dataDir = dataDir;
        try {
            recordContainmentHandle({
                kind: 'tree-identity',
                sessionId: 'probe2c-session',
                generation: 1,
                rootPid: immortal,
                bootId,
                startTime: 777,
                nonce,
            }, dataDir);

            class SyntheticProcBackend extends FastProofBackend {
                protected override get procRoot(): string { return procRoot; }
            }
            const bin = fakeMojo('mojo-p2c', `echo '{"status":"ok"}'; exit 0`);
            const gen2 = new SyntheticProcBackend({ bin }, 'probe2c-session');
            const result = await gen2.destroySession();
            note(`P2c: unkillable inherited member -> ${JSON.stringify(result)}`);
            note(`P2c: quiescence -> ${JSON.stringify(gen2.lastTurnQuiescence)}`);

            // THE ASSERTION: an undischargeable handle must refuse the close.
            expect(result.ok).toBe(false);
            expect(gen2.lastTurnQuiescence?.boundaryProof ?? false).toBe(false);
            // ...and the handle must still be recorded, so the blocker is retained.
            expect(hasUnprovenContainment('probe2c-session', dataDir)).toBe(true);
            note(`P2c: blocker_retained=${hasUnprovenContainment('probe2c-session', dataDir)}`);
        } finally {
            config.session.dataDir = prevDataDir;
        }
    }, 40_000);

    // Linux-only: it plants a REAL setsid escapee and reads its identity through
    // /proc, which is the mechanism being probed.
    it.runIf(isLinux)('the durable handle is what makes the old tree reachable across generations', async () => {
        // Independent of the backend wiring: this is the mechanism the fix relies
        // on, so the report can separate "mechanism works" from "mechanism wired".
        const dataDir = mkdtempSync(join(binDir, 'p2-store-'));
        const nonce = `botmux-mojo-probe2-${process.pid}`;
        const script = join(binDir, 'p2b.sh');
        writeFileSync(script, '#!/usr/bin/env bash\n'
            + `setsid bash -c 'trap "" TERM; echo $$ > "${binDir}/p2b.pid"; exec sleep 120' </dev/null >/dev/null 2>&1 &\nexit 0\n`);
        chmodSync(script, 0o755);
        spawnSync(script, [], { env: { ...process.env, [MOJO_TREE_NONCE_ENV]: nonce }, timeout: 10_000 });
        expect(await waitFor(() => existsSync(`${binDir}/p2b.pid`))).toBe(true);
        const escaped = Number(readFileSync(`${binDir}/p2b.pid`, 'utf8').trim());
        strays.push(escaped);

        const h = acquireContainmentHandle({ sessionId: 'probe2b', generation: 1, rootPid: escaped, nonce }, {});
        recordContainmentHandle(h, dataDir);
        // Generation 2 reads ONLY the store — nothing in memory.
        const inherited = inheritContainmentHandles('probe2b', 2, dataDir);
        note(`P2b: gen2 inherited ${inherited.length} handle(s) from a cold store; `
            + `blocker_retained=${hasUnprovenContainment('probe2b', dataDir)}`);
        expect(inherited).toHaveLength(1);
        expect(containmentHandles('probe2b', dataDir)[0]).toMatchObject({ rootPid: escaped });
        expect(hasUnprovenContainment('probe2b', dataDir)).toBe(true);

        try { process.kill(escaped, 'SIGKILL'); } catch { /* gone */ }
    }, 40_000);
});

describe('PROBE 3 — a REFUSED abort must not re-admit write()', () => {
    it('write() stays refused after abortDestroySession is rejected', async () => {
        // The laundering path: destroySession returns a FENCED verdict (an unnamed
        // remote session may exist), the caller nonetheless tries to roll back, and
        // if the rollback silently "succeeds" the session looks writable again —
        // layering a fresh turn on top of a possible orphan.
        const bin = fakeMojo('mojo-p3', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
# Accept the write, then exit WITHOUT ever emitting system/init: there may be a
# remote session we have no id for, which is the 'uncertain' verdict.
sleep 0.2
exit 0`);

        const backend = new FastProofBackend({ bin }, 'probe3-session');
        backend.spawn('', [], {} as never);
        backend.write('dispatch a turn that never publishes its lineage');
        const closed = await backend.destroySession();
        note(`P3: destroySession -> ${JSON.stringify(closed)}`);
        expect(closed.ok).toBe(false);

        // The rollback must be REFUSED for a fenced verdict.
        const aborted = backend.abortDestroySession() as unknown;
        note(`P3: abortDestroySession -> ${JSON.stringify(aborted ?? null)}`);

        // THE ASSERTION: admission must not come back.
        const admitted = backend.write('a turn that must NOT be accepted');
        note(`P3: write() after refused abort -> ${admitted} (must be false)`);
        expect(admitted).toBe(false);

        // And the structured verdict must say so rather than leaving the caller to
        // infer it from `ok`.
        if (aborted && typeof aborted === 'object' && 'admissionRestored' in aborted) {
            note(`P3: admissionRestored=${(aborted as { admissionRestored: unknown }).admissionRestored} `
                + `(a refused rollback must report false)`);
            expect((aborted as { admissionRestored: boolean }).admissionRestored).toBe(false);
        } else {
            note('P3: WARNING abortDestroySession returned no structured result; '
                + 'callers can only infer restoration from ok, which is the reported hole');
        }
    }, 40_000);
});

describe('PROBE 4 — a daemon crash must not lose the taskId', () => {
    it('the lineage survives a hard crash of the process that knew it', async () => {
        // The remote session id is the ONLY handle for cancelling a session that is
        // still burning cloud time and still holding the injected credential. If it
        // lives only in memory, SIGKILLing the daemon leaks it irrecoverably.
        //
        // Modelled honestly: a child process learns a lineage, persists it the way
        // production does, and is then SIGKILLed with no chance to clean up. A fresh
        // reader must still find the id.
        const dataDir = mkdtempSync(join(binDir, 'p4-store-'));
        const journal = join(dataDir, 'close-journal.json');
        const taskId = `sid-p4-${process.pid}`;

        const writer = spawn('node', ['-e', `
            const { writeFileSync, renameSync } = require('node:fs');
            const tmp = ${JSON.stringify(journal)} + '.tmp';
            writeFileSync(tmp, JSON.stringify({ version: 1, taskId: ${JSON.stringify(taskId)},
                phase: 'prepared', recovery: 'uncertain', admission: 'fenced' }));
            renameSync(tmp, ${JSON.stringify(journal)});
            console.log('persisted');
            setInterval(() => {}, 1000);
        `], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        writer.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        expect(await waitFor(() => out.includes('persisted'))).toBe(true);

        // Hard kill: no exit handler, no flush, no graceful shutdown.
        writer.kill('SIGKILL');
        expect(await waitFor(() => !alive(writer.pid as number))).toBe(true);
        note(`P4: writer pid=${writer.pid} SIGKILLed, alive=${alive(writer.pid as number)}`);

        // A fresh reader — the restarted daemon.
        const recovered = existsSync(journal)
            ? JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>
            : null;
        note(`P4: recovered journal after crash -> ${JSON.stringify(recovered)}`);

        // THE ASSERTION: the id and the fenced state both survived.
        expect(recovered).not.toBeNull();
        expect(recovered?.taskId).toBe(taskId);
        expect(recovered?.admission).toBe('fenced');
        note('P4: taskId survived a SIGKILL with admission still fenced');
    }, 40_000);
});
