/**
 * Linux bwrap e2e: compile a real FsPolicy → bwrap argv, launch real processes
 * under bubblewrap, and assert the three access tiers hold at the KERNEL level
 * (not just in the pure accessForPath model). Skipped off Linux and when bwrap
 * / unprivileged user namespaces are unavailable.
 *
 * Guards the blocker-1 findings from the 2026-07-24 review:
 *  (a) DIRECTORY deny masked with `--tmpfs` was WRITABLE inside the sandbox —
 *      hid contents but let the CLI write into the "denied" path. Fixed with a
 *      read-only bind of a mode-000 empty source.
 *  (b) A nonexistent deny was SKIPPED, leaving the path inside the read-write
 *      parent bind: the sandbox could mkdir+write it onto the host, and the
 *      host creating a secret there mid-session became readable (stat→exec
 *      TOCTOU). Fixed by ALWAYS masking a reachable deny (worker pre-creates
 *      the mountpoint so the empty mask always binds).
 *  (c) 0755/0644 masks were themselves listable (`ls`/`cat` succeeded on the
 *      empty mask). Fixed with mode 000 → for a NON-root uid the access command
 *      fails; a root uid (CAP_DAC_OVERRIDE) can still list, but the mask is empty
 *      so no real content leaks either way (emptiness is the guarantee).
 *
 * This runs the compiler exactly as the worker does: resolve symlinks, split
 * file- vs dir-shaped denies, mode-000 the empty sources, pre-create missing
 * mask mountpoints, then invoke bwrap.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync, mkdirSync, chmodSync, realpathSync, existsSync, statSync, lstatSync, readlinkSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildFsPolicy, compileToBwrap } from '../src/adapters/cli/fs-policy.js';
import { createOhMyPiAdapter, ompSessionDir } from '../src/adapters/cli/oh-my-pi.js';

const bwrapUsable = process.platform === 'linux'
  && spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0
  && spawnSync('bwrap', [
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    ...(existsSync('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
    ...(existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
    '--unshare-user', '--unshare-pid', '/bin/true',
  ], { stdio: 'ignore' }).status === 0;

const d = bwrapUsable ? describe : describe.skip;

const USRMERGE = ['/bin', '/lib', '/lib64', '/sbin', '/lib32', '/libx32'];

d('bwrap three-tier enforcement (real bubblewrap)', () => {
  let S: string;
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return p; } };

  // Build the bwrap argv the SAME way the worker does (deny masks: mode-000
  // empty sources, missing mountpoints pre-created). Returns the created-mask
  // list too so cleanup tests can assert rmdir-if-empty.
  function build(userPaths: { readWrite?: string[]; readOnly?: string[]; deny?: string[] }) {
    const emptiesDir = join(S, 'sbx/empties');
    const emptyDir = join(S, 'sbx/empty');
    mkdirSync(emptiesDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });

    const policy = buildFsPolicy({
      platform: 'linux', homeDir: canonical(homedir()),
      botmuxHome: join(S, 'botmux-home'), sessionDataDir: join(S, 'botmux-home/data'),
      sessionId: 'e2e-session',
      workingDir: join(S, 'proj'), currentAppId: 'cli_e2e', botHome: join(S, 'botmux-home/bots/cli_e2e'),
      redirectedCliData: true,
      execPaths: [dirname(canonical(process.execPath))],
      userPaths: { readOnly: [join(S, 'ref'), ...(userPaths.readOnly ?? [])], readWrite: userPaths.readWrite, deny: userPaths.deny },
      net: true, writeRegexes: [],
    });
    policy.rules = policy.rules.filter(r => r.access === 'deny' || existsSync(r.path));

    const symlinks: { path: string; target: string }[] = [];
    for (const p of USRMERGE) {
      try { if (lstatSync(p).isSymbolicLink()) symlinks.push({ path: p, target: readlinkSync(p) }); } catch { /* */ }
    }
    const filePaths = new Set<string>();
    for (const r of policy.rules) {
      if (r.access !== 'deny') continue;
      try { if (statSync(r.path).isFile()) filePaths.add(r.path); } catch { /* absent → dir mask */ }
    }
    const compiled = compileToBwrap(policy, { symlinks, emptyDir, emptiesDir, filePaths, chdir: join(S, 'proj') });
    chmodSync(emptyDir, 0o000);
    for (const f of compiled.emptyFiles) writeFileSync(f.path, '', { mode: 0o000 });
    // Mirror the worker: pre-create missing mask mountpoints (leaf + ancestors).
    const created: { path: string; kind: 'dir' | 'file' }[] = [];
    for (const m of compiled.maskMounts) {
      if (existsSync(m.path)) continue;
      if (m.kind === 'file') { mkdirSync(dirname(m.path), { recursive: true }); writeFileSync(m.path, ''); }
      else mkdirSync(m.path, { recursive: true });
      created.push(m);
    }
    return { args: compiled.args, created };
  }

  function run(args: string[], cmd: string) {
    const r = spawnSync('bwrap', [...args, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  beforeAll(() => {
    S = canonical(mkdtempSync(join(tmpdir(), 'fsp-bwrap-e2e-')));
    for (const dir of ['proj/secrets', 'proj/work', 'botmux-home/data', 'botmux-home/bots/cli_e2e', 'ref']) {
      mkdirSync(join(S, dir), { recursive: true });
    }
    writeFileSync(join(S, 'proj/readme.md'), 'proj');
    writeFileSync(join(S, 'proj/secrets/key.txt'), 'TOPSECRET');
    writeFileSync(join(S, 'proj/.env'), 'API_KEY=zzz');
    writeFileSync(join(S, 'ref/doc.md'), 'ref');
  });
  afterAll(() => { if (S) rmSync(S, { recursive: true, force: true }); });

  it('readWrite: reads AND writes the project', () => {
    const { args } = build({});
    expect(run(args, `cat ${JSON.stringify(join(S, 'proj/readme.md'))}`).status).toBe(0);
    expect(run(args, `echo hi > ${JSON.stringify(join(S, 'proj/work/new.txt'))}`).status).toBe(0);
  });

  it('readOnly: reads but cannot write', () => {
    const { args } = build({});
    expect(run(args, `cat ${JSON.stringify(join(S, 'ref/doc.md'))}`).status).toBe(0);
    expect(run(args, `echo x > ${JSON.stringify(join(S, 'ref/hack'))}`).status).not.toBe(0);
  });

  it('deny DIR (existing): real content unreadable, and mask empty/unlistable for non-root (root may list but sees nothing real)', () => {
    const dir = join(S, 'proj/secrets');
    const { args } = build({ deny: [dir] });
    const read = run(args, `cat ${JSON.stringify(join(dir, 'key.txt'))}`);
    expect(read.status).not.toBe(0);
    expect(read.out).not.toContain('TOPSECRET');
    // The mask is a mode-000 empty tmpfs. For a NON-root uid the kernel's DAC check
    // makes `ls` itself fail; but root bypasses DAC (CAP_DAC_OVERRIDE) and can still
    // traverse a 000 dir — and the sandboxed process here is root (no uid drop). The
    // real guarantee in BOTH cases is that no real entry leaks: the mask replaced the
    // host dir with an empty one, so key.txt must be absent regardless of ls status.
    const ls = run(args, `ls -A ${JSON.stringify(dir)}`);
    if (process.getuid?.() === 0) {
      expect(ls.status).toBe(0);            // root traverses the 000 mask…
      expect(ls.out).not.toContain('key.txt'); // …but the mask is empty — no real content
    } else {
      expect(ls.status).not.toBe(0);        // non-root: DAC blocks listing the 000 dir
    }
  });

  it('deny DIR (existing): NOT writable — regression guard for the writable-tmpfs bug', () => {
    const dir = join(S, 'proj/secrets');
    const evil = join(dir, 'evil.txt');
    const { args } = build({ deny: [dir] });
    expect(run(args, `echo PWNED > ${JSON.stringify(evil)}`).status).not.toBe(0);
    expect(existsSync(evil)).toBe(false); // nothing leaked to the host
  });

  it('deny FILE (existing): content hidden, cat fails (000), write rejected', () => {
    const f = join(S, 'proj/.env');
    const { args } = build({ deny: [f] });
    const r = run(args, `cat ${JSON.stringify(f)}; echo x > ${JSON.stringify(f)} && echo WROTE`);
    expect(r.out).not.toContain('API_KEY');
    expect(r.out).not.toContain('WROTE');
  });

  it('NONEXISTENT deny under a RW parent: sandbox mkdir/write is REJECTED and nothing lands on the host', () => {
    const ghost = join(S, 'proj/ghost'); // never created as a real secret
    expect(existsSync(join(ghost, 'x'))).toBe(false);
    const { args } = build({ deny: [ghost] });
    const r = run(args, `mkdir -p ${JSON.stringify(join(ghost, 'sub'))} 2>&1; echo LEAK > ${JSON.stringify(join(ghost, 'secret'))} 2>&1 && echo WROTE`);
    expect(r.out).not.toContain('WROTE');
    expect(existsSync(join(ghost, 'secret'))).toBe(false);
    expect(existsSync(join(ghost, 'sub'))).toBe(false);
  });

  it('RO parent + deny created by the HOST mid-session: sandbox still cannot read it', () => {
    // ref/ is readOnly; ref/private does NOT exist at build time. The mask must
    // still be installed so a host-created secret is unreadable in-sandbox.
    const priv = join(S, 'ref/private');
    rmSync(priv, { recursive: true, force: true });
    const { args } = build({ deny: [priv] });
    // simulate the host/another process creating the secret AFTER the mask was
    // installed (the compiler is stat-free; the worker pre-created the mount).
    // Under the mask, the in-sandbox view is the mode-000 empty source, so even
    // if the host writes into the REAL dir, the sandbox sees EPERM.
    writeFileSync(join(priv, 'k'), 'LATESECRET');
    const r = run(args, `cat ${JSON.stringify(join(priv, 'k'))}`);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('LATESECRET');
    rmSync(priv, { recursive: true, force: true });
  });

  it('cleanup: rmdir-if-empty removes a pre-created empty mount, KEEPS one the host wrote into', () => {
    const ghostEmpty = join(S, 'proj/ghost-empty');
    const ghostFilled = join(S, 'proj/ghost-filled');
    rmSync(ghostEmpty, { recursive: true, force: true });
    rmSync(ghostFilled, { recursive: true, force: true });
    const { created } = build({ deny: [ghostEmpty, ghostFilled] });
    expect(created.map(m => m.path).sort()).toEqual([ghostFilled, ghostEmpty].sort());
    // host writes into one of them during the session
    writeFileSync(join(ghostFilled, 'hostdata'), 'x');
    // reclaim: rmdir only empty ones (mirrors reclaimMaskMounts semantics)
    for (const m of created) {
      try { rmdirSync(m.path); } catch { /* ENOTEMPTY → kept */ }
    }
    expect(existsSync(ghostEmpty)).toBe(false); // empty → reclaimed
    expect(existsSync(ghostFilled)).toBe(true); // non-empty → preserved, never rm -rf
    rmSync(ghostFilled, { recursive: true, force: true });
  });

  it('white-in-black: RW → deny → RW carve-out launches, carve-out readable+writable, denied root hidden+unwritable', () => {
    // The bug: a mode-000 ro-bind mask at /proj/wib can't host the nested
    // /proj/wib/self mountpoint (bwrap: "Can't mkdir … Read-only file system").
    // Fix: tmpfs mask + deferred --remount-ro.
    const denied = join(S, 'proj/wib');
    const self = join(denied, 'self');
    mkdirSync(self, { recursive: true });
    writeFileSync(join(denied, 'secret'), 'DENIEDSECRET');
    writeFileSync(join(self, 'ok'), 'SELF');
    const { args } = build({ deny: [denied], readWrite: [self] });
    // carve-out reads
    expect(run(args, `cat ${JSON.stringify(join(self, 'ok'))}`).out).toContain('SELF');
    // carve-out writes (lands on host)
    expect(run(args, `echo w > ${JSON.stringify(join(self, 'w'))}`).status).toBe(0);
    expect(existsSync(join(self, 'w'))).toBe(true);
    // denied root: real content hidden
    expect(run(args, `cat ${JSON.stringify(join(denied, 'secret'))}`).out).not.toContain('DENIEDSECRET');
    // denied root: not writable (remount-ro sealed the tmpfs parent)
    expect(run(args, `echo x > ${JSON.stringify(join(denied, 'evil'))} && echo WROTE`).out).not.toContain('WROTE');
    expect(existsSync(join(denied, 'evil'))).toBe(false);
    rmSync(denied, { recursive: true, force: true });
  });

  it('OMP state stays writable while only the current transcript directory is carved through the sessions mask', () => {
    const realHome = join(S, 'omp-real-home');
    const linkedHome = join(S, 'omp-linked-home');
    mkdirSync(realHome);
    symlinkSync(realHome, linkedHome, 'dir');
    vi.stubEnv('HOME', linkedHome);
    try {
      const agentRoot = join(realpathSync(realHome), '.omp', 'agent');
      const sessionsRoot = join(agentRoot, 'sessions');
      const own = ompSessionDir('self');
      const sibling = join(sessionsRoot, 'botmux/sibling');
      const terminalSessions = join(agentRoot, 'terminal-sessions');
      const siblingTranscript = join(sibling, 'secret.jsonl');
      const breadcrumb = join(terminalSessions, 'pane');
      expect(own).toBe(join(sessionsRoot, 'botmux/self'));
      const adapterArgs = createOhMyPiAdapter('/usr/bin/omp').buildArgs({ sessionId: 'self', resume: false });
      expect(adapterArgs[adapterArgs.indexOf('--session-dir') + 1]).toBe(own);

      mkdirSync(own, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      mkdirSync(terminalSessions, { recursive: true });
      writeFileSync(join(agentRoot, 'agent.db'), 'state');
      writeFileSync(join(agentRoot, 'agent.db-wal'), 'wal');
      writeFileSync(join(agentRoot, 'config.yml'), 'config');
      writeFileSync(siblingTranscript, 'SIBLING_SECRET');
      writeFileSync(breadcrumb, `${join(S, 'proj')}\n${siblingTranscript}\nfresh\n`);

      const { args } = build({
        readWrite: [agentRoot, own],
        deny: [sessionsRoot],
      });
      expect(args).toContain(own);

      expect(run(args, `printf updated >> ${JSON.stringify(join(agentRoot, 'agent.db'))}`).status).toBe(0);
      expect(readFileSync(join(agentRoot, 'agent.db'), 'utf8')).toContain('updated');
      expect(run(args, `printf own > ${JSON.stringify(join(own, 'new.jsonl'))}`).status).toBe(0);
      expect(readFileSync(join(own, 'new.jsonl'), 'utf8')).toBe('own');

      const breadcrumbRead = run(args, `cat ${JSON.stringify(breadcrumb)}`);
      expect(breadcrumbRead.status).toBe(0);
      expect(breadcrumbRead.out).toContain(siblingTranscript);
      const siblingRead = run(args, `cat ${JSON.stringify(siblingTranscript)}`);
      expect(siblingRead.status).not.toBe(0);
      expect(siblingRead.out).not.toContain('SIBLING_SECRET');

      const other = join(sessionsRoot, 'botmux/other');
      expect(run(args, `mkdir ${JSON.stringify(other)}`).status).not.toBe(0);
      expect(existsSync(other)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('deny → allow → deny (4 layers): the DEEPEST deny is masked, secret unreadable+unwritable, middle carve-out still works', () => {
    // Security regression: an ancestor deny must NOT make a deeper deny look
    // redundant when an allow re-exposed the tree between them. outer denied,
    // self re-allowed, secret denied again → secret must be a real mask.
    const outer = join(S, 'proj/dad-outer');
    const self = join(outer, 'self');
    const secret = join(self, 'secret');
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, 'key'), 'TOPSECRET');
    writeFileSync(join(self, 'ok'), 'SELF');
    const { args } = build({ deny: [outer, secret], readWrite: [self] });
    // middle carve-out reads + writes
    expect(run(args, `cat ${JSON.stringify(join(self, 'ok'))}`).out).toContain('SELF');
    expect(run(args, `echo w > ${JSON.stringify(join(self, 'w'))}`).status).toBe(0);
    // deepest deny: real content NOT readable (was leaking TOPSECRET before the fix)
    const read = run(args, `cat ${JSON.stringify(join(secret, 'key'))}`);
    expect(read.status).not.toBe(0);
    expect(read.out).not.toContain('TOPSECRET');
    // deepest deny: not writable
    expect(run(args, `echo x > ${JSON.stringify(join(secret, 'evil'))} && echo WROTE`).out).not.toContain('WROTE');
    rmSync(outer, { recursive: true, force: true });
  });

  it('redundant nested deny (deny /a + deny /a/b) launches — inner deny skipped, still fully denied', () => {
    // Two stacked denies with no allow between would fail: the inner mask can't
    // mount on the outer mode-000 RO mask. The compiler skips the redundant
    // inner deny; the outer mask still hides everything below.
    const a = join(S, 'proj/rr');
    const b = join(a, 'b');
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'secret'), 'INNERSECRET');
    const { args } = build({ deny: [a, b] });
    // launches (would exit non-zero on the mkdir failure otherwise) and the
    // inner path is still denied by the ancestor mask
    const r = run(args, `cat ${JSON.stringify(join(b, 'secret'))} 2>&1; echo "---"; ls ${JSON.stringify(a)} 2>&1`);
    expect(r.out).not.toContain('INNERSECRET');
    expect(r.out).toContain('---'); // process actually ran
    rmSync(a, { recursive: true, force: true });
  });
});
