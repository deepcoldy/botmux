/**
 * Pre-exec cgroup enrolment (P0: the spawn→enrolment window).
 *
 * The strong containment proof reads `cgroup.procs` and treats "empty" as "tree
 * gone". That is only sound when every descendant of the turn is BORN inside
 * the cgroup: migrating an already-running root in (the old post-spawn
 * `acquireContainmentHandle` write) does not capture descendants it forked
 * before the write landed, so a fork+setsid at exec+0 escaped the boundary and
 * the proof went false-green while a credentialed process kept running.
 *
 * Three layers, weakest platform requirement first:
 *   1. the shim contract itself (any POSIX host);
 *   2. backend wiring through a SYNTHETIC cgroup root (any host): the child —
 *      not the parent — writes its pid, before exec;
 *   3. the real kernel semantics (Linux with cgroup v2 delegation): a setsid
 *      descendant forked at exec+0 is INSIDE the boundary, the strong proof
 *      refuses while it lives, and cgroup.kill reaps it. Reverting to
 *      post-spawn migration turns exactly this case red.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MOJO_CGROUP_ENROLL_SHIM,
  MOJO_ENROLL_FAILED_EXIT,
  MojoBackend,
} from '../src/adapters/backend/mojo-backend.js';
import {
  containmentHandles,
  killPreparedBoundary,
  prepareContainmentBoundary,
  proveContainmentQuiescent,
  strongHandleFromPreparedBoundary,
} from '../src/core/mojo-containment.js';
import { isLinux } from './helpers/synthetic-proc.js';

let dataDir: string;
let prevDataDir: string | undefined;
const strays: number[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mojo-preexec-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(25); }
  return pred();
}

function fakeBin(name: string, body: string): string {
  const p = join(dataDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('shim contract (layer 1)', () => {
  it('enrols the pid that will exec the target: $$ written pre-exec survives exec', () => {
    const procs = join(dataDir, 'cgroup.procs');
    writeFileSync(procs, '');
    const child = spawn('/bin/sh', ['-c', MOJO_CGROUP_ENROLL_SHIM, 'enroll', procs, '/bin/sleep', '5']);
    strays.push(child.pid!);
    return waitFor(() => readFileSync(procs, 'utf8').trim().length > 0).then(written => {
      expect(written).toBe(true);
      // The enrolled pid IS the process that exec'd the target — same pid across
      // exec is what makes "descendants are born enrolled" true on real cgroupfs.
      expect(Number(readFileSync(procs, 'utf8').trim())).toBe(child.pid);
      child.kill('SIGKILL');
    });
  });

  it('exits 97 without exec when enrolment fails — nothing credentialed runs', () => {
    const marker = join(dataDir, 'ran');
    const target = fakeBin('must-not-run', `touch ${marker}`);
    // A directory at the procs path makes the write fail on any host (EISDIR),
    // root included — chmod-based denial is bypassed by CAP_DAC_OVERRIDE.
    const procsAsDir = join(dataDir, 'procs-dir');
    mkdirSync(procsAsDir);
    const result = spawnSync('/bin/sh', ['-c', MOJO_CGROUP_ENROLL_SHIM, 'enroll', procsAsDir, target]);
    expect(result.status).toBe(MOJO_ENROLL_FAILED_EXIT);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('backend wiring through a synthetic cgroup root (layer 2)', () => {
  class SyntheticCgroupBackend extends MojoBackend {
    constructor(cfg: never, sessionId: string, private readonly root: string) {
      super(cfg, sessionId);
    }

    protected override get cgroupRoot(): string { return this.root; }
  }

  function boundaryDirs(root: string): string[] {
    const slice = join(root, 'botmux.slice');
    return existsSync(slice) ? readdirSync(slice).map(d => join(slice, d)) : [];
  }

  it('the CHILD enrols itself before exec; the parent never migrates a pid in', async () => {
    const cgroupRoot = join(dataDir, 'cg');
    // cgroup.controllers is what cgroupV2Available probes for.
    mkdirSync(cgroupRoot, { recursive: true });
    writeFileSync(join(cgroupRoot, 'cgroup.controllers'), 'cpu memory\n');
    const seen = join(dataDir, 'seen-at-exec');
    // The fake mojo's FIRST act is to check whether it is ALREADY enrolled: under
    // pre-exec enrolment this is deterministic ("yes"), under the old post-spawn
    // migration it raced the parent and read empty. That first line is the
    // revert-red assertion of this whole file.
    const bin = fakeBin('mojo-synth', [
      `procs=$(ls ${cgroupRoot}/botmux.slice/mojo-*/cgroup.procs 2>/dev/null | head -1)`,
      `if [ -n "$procs" ] && grep -q "^$$\\$" "$procs"; then echo enrolled > ${seen}; else echo not-enrolled > ${seen}; fi`,
      `echo '{"type":"system","subtype":"init","session_id":"sid-synth"}'`,
      `echo '{"type":"result","status":"ok","result":"done","session_id":"sid-synth","warnings":[]}'`,
      'exit 0',
    ].join('\n'));
    const backend = new SyntheticCgroupBackend({ bin } as never, 'sess-preexec-synth', cgroupRoot);
    backend.spawn('', [], {} as never);
    backend.write('turn');
    expect(await waitFor(() => existsSync(seen))).toBe(true);
    expect(readFileSync(seen, 'utf8').trim()).toBe('enrolled');
    // The handle minted for the turn is STRONG and points at the prepared
    // boundary — no acquireContainmentHandle migration write involved.
    const handles = containmentHandles('sess-preexec-synth');
    expect(handles).toHaveLength(1);
    expect(handles[0]!.kind).toBe('cgroup');
    const dirs = boundaryDirs(cgroupRoot);
    expect(dirs).toHaveLength(1);
    expect((handles[0] as { cgroupPath: string }).cgroupPath).toBe(dirs[0]);
  });
});

/** Real-kernel layer: needs cgroup v2 AND a delegated (writable) hierarchy. */
const realBoundary = (): ReturnType<typeof prepareContainmentBoundary> => {
  try {
    return prepareContainmentBoundary({ sessionId: 'probe-delegation', generation: 0, nonce: 'probe' });
  } catch {
    return null;
  }
};
const delegated = isLinux && (() => {
  const probe = realBoundary();
  if (probe) killPreparedBoundary(probe);
  return probe !== null;
})();

describe.runIf(delegated)('real cgroup v2: pre-registration fork escape (layer 3)', () => {
  it('a setsid descendant forked at exec+0 is INSIDE the boundary; the strong proof refuses until cgroup.kill reaps it', async () => {
    const prepared = prepareContainmentBoundary({
      sessionId: 'sess-preexec-real', generation: 1, nonce: 'preexec-real',
    })!;
    expect(prepared).not.toBeNull();
    const pidFile = join(dataDir, 'escapee.pid');
    // The escape this P0 was about: fork+setsid IMMEDIATELY at exec, then let
    // the root exit. Post-spawn migration could never capture this descendant;
    // pre-exec enrolment makes it be born inside the cgroup.
    const escape = fakeBin('escape', [
      `setsid bash -c 'echo $$ > ${pidFile}; exec sleep 60' </dev/null >/dev/null 2>&1 &`,
      'exit 0',
    ].join('\n'));
    const child = spawn('/bin/sh', [
      '-c', MOJO_CGROUP_ENROLL_SHIM, 'enroll', `${prepared.cgroupPath}/cgroup.procs`, escape,
    ]);
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const escapee = Number(readFileSync(pidFile, 'utf8').trim());
    strays.push(escapee);
    await waitFor(() => child.exitCode !== null);

    // The kernel's own answer: the setsid'd survivor is a member of the boundary.
    const members = (): number[] => {
      try {
        return readFileSync(`${prepared.cgroupPath}/cgroup.procs`, 'utf8')
          .split('\n').map(l => Number(l.trim())).filter(n => n > 0);
      } catch { return []; }
    };
    expect(await waitFor(() => members().includes(escapee))).toBe(true);

    // Strong proof: refuses while the escapee lives...
    const handle = strongHandleFromPreparedBoundary(prepared);
    expect(proveContainmentQuiescent(handle).proven).toBe(false);

    // ...and cgroup.kill (the record-failure containment path) reaps the whole
    // boundary, escapee included, proving emptiness via rmdir.
    expect(killPreparedBoundary(prepared)).toBe(true);
    expect(await waitFor(() => {
      try { process.kill(escapee, 0); return false; } catch { return true; }
    })).toBe(true);
    expect(proveContainmentQuiescent(handle).proven).toBe(true);
  }, 30_000);
});
