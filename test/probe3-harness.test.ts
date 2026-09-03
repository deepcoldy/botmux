/**
 * Reviewer probe shape #3, driven against REAL processes: a descendant that
 * setsid()s into a new session, drops the tree nonce from its own environment and
 * reparents to init. It is ALIVE, yet the subtree scanner enumerates nothing.
 *
 * This file is a diagnostic harness, not a unit test: it prints the observed
 * state so the before/after outputs can be diffed. It runs on Linux only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    acquireContainmentHandle,
    containmentHandles,
    hasUnprovenContainment,
    proveContainmentQuiescent,
    recordContainmentHandle,
    releaseContainmentHandle,
    type WeakContainmentHandle,
} from '../src/core/mojo-containment.js';
import { MOJO_TREE_NONCE_ENV, scanMojoTree } from '../src/adapters/backend/mojo-process-tree.js';

const LINUX = process.platform === 'linux';
const work = mkdtempSync(join(tmpdir(), 'probe3-'));

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return fn();
}

/**
 * Returns the pid of the turn child (which EXITS) and of the evader (alive).
 * The evader: new session (setsid), nonce unset from its environ, parent gone so
 * it is reparented to init.
 */
async function spawnProbe3(nonce: string): Promise<{
    turnPid: number; evaderPid: number; waitTurnGone: () => Promise<void>;
}> {
    const pidFile = join(work, `evader-${Math.random().toString(36).slice(2)}.pid`);
    const script = join(work, `probe3-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(
        script,
        '#!/usr/bin/env bash\n'
        // setsid -> new session AND new pgid; env -u -> the nonce is gone from the
        // descendant's environ; the wrapper then exits, so init adopts it.
        + `setsid env -u ${MOJO_TREE_NONCE_ENV} bash -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 300' `
        + '</dev/null >/dev/null 2>&1 &\n'
        // Stay alive long enough for the caller to mint the handle the way
        // production does: while the turn child is still running.
        + 'sleep 6\n'
        + 'exit 0\n',
    );
    chmodSync(script, 0o755);
    const turn = spawn(script, [], {
        env: { ...process.env, [MOJO_TREE_NONCE_ENV]: nonce },
        stdio: 'ignore',
        detached: false,
    });
    const turnPid = turn.pid as number;
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const evaderPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitFor(() => alive(evaderPid))).toBe(true);
    expect(alive(turnPid)).toBe(true);
    return { turnPid, evaderPid, waitTurnGone: async () => {
        await new Promise<void>(r => turn.on('exit', () => r()));
        expect(await waitFor(() => !alive(turnPid), 10_000)).toBe(true);
    } };
}

describe.skipIf(!LINUX)('reviewer probe shape 3: setsid + scrubbed nonce + reparented to init', () => {
    it('reports what a clean scan authorises while the evader is still alive', async () => {
        const dataDir = mkdtempSync(join(work, 'store-'));
        const nonce = `botmux-mojo-probe3-${process.pid}`;
        const { turnPid, evaderPid, waitTurnGone } = await spawnProbe3(nonce);
        const out: string[] = [];
        const say = (k: string, v: unknown): void => {
            out.push(`PROBE3 ${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
        };
        try {
            // The handle records the turn child, exactly as production mints it.
            const handle = acquireContainmentHandle(
                { sessionId: 'sess-probe3', generation: 1, rootPid: turnPid, nonce },
                {},
            ) as WeakContainmentHandle | null;
            say('handle_kind', handle?.kind ?? 'null');
            if (!handle) { say('SKIPPED', 'no handle could be minted'); return; }
            recordContainmentHandle(handle, dataDir);
            // Now let the turn child exit: from here on the ONLY thing left of the
            // subtree is the evader, and it is invisible to enumeration.
            await waitTurnGone();

            say('turn_pid', turnPid);
            say('turn_alive', alive(turnPid));
            say('evader_pid', evaderPid);
            say('evader_alive', alive(evaderPid));
            const evaderStat = readFileSync(`/proc/${evaderPid}/stat`, 'utf8').split(' ');
            say('evader_ppid', evaderStat[3]);              // 1 => reparented to init
            say('evader_pgid', evaderStat[4]);              // != turn pgid => setsid worked
            const environ = readFileSync(`/proc/${evaderPid}/environ`, 'utf8');
            say('evader_has_nonce', environ.includes(nonce));

            const scan = scanMojoTree(handle.rootPid, handle.nonce, { excludePids: [process.pid, process.ppid] });
            say('scan_ok', scan.ok);
            say('scan_members', scan.ok ? scan.members.map(m => m.pid) : scan.reason);

            const verdict = proveContainmentQuiescent(handle, {
                scan: h => {
                    const s = scanMojoTree(h.rootPid, h.nonce, { excludePids: [process.pid, process.ppid] });
                    return s.ok ? { scanned: true, pids: s.members.map(m => m.pid) } : { scanned: false, pids: [] };
                },
            });
            say('verdict_proven', verdict.proven);
            say('verdict_evidence', (verdict as { evidence?: string }).evidence ?? 'ABSENT(no evidence field)');

            let threw = 'no';
            let decision: unknown = 'void(no return value)';
            try {
                const r = releaseContainmentHandle(verdict, dataDir) as unknown;
                if (r !== undefined) decision = r;
            } catch (err) {
                threw = (err as Error).name;
            }
            say('release_threw', threw);
            say('release_decision', decision);

            // THE question. Is the device-isolation blocker still up while the
            // evader is provably alive?
            say('handles_left', containmentHandles('sess-probe3', dataDir).length);
            say('blocker_retained', hasUnprovenContainment('sess-probe3', dataDir));
            say('evader_still_alive_at_end', alive(evaderPid));
        } finally {
            try { process.kill(evaderPid, 'SIGKILL'); } catch { /* gone */ }
            // eslint-disable-next-line no-console
            console.log(`\n${out.join('\n')}\n`);
        }
    }, 60_000);
});
