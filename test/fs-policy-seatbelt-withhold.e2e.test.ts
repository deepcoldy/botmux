/**
 * macOS Seatbelt kernel-level regression for sandboxWithholdBotSecret (#3649)
 * and the withheld lark-cli keystore seal (#3672) — issue #3676.
 *
 * The unit suite only proves the PROFILE TEXT (rule order, last-match). This
 * file compiles real policies, runs real processes under sandbox-exec and
 * asserts what the kernel actually refuses. Every deny assertion is paired with
 * a positive control in the same profile so a profile that blocks everything
 * (or a probe that cannot run) can never pass as "denied".
 *
 * Uses a fake $HOME under a temp dir: no real key material is ever read.
 * Skipped off darwin / without sandbox-exec; the procargs probe needs clang.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, existsSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildFsPolicy, compileToSeatbelt, type FsPolicyContext, type FsPolicy } from '../src/adapters/cli/fs-policy.js';

const darwin = process.platform === 'darwin'
  && spawnSync('sh', ['-c', 'command -v sandbox-exec'], { stdio: 'ignore' }).status === 0;
const d = darwin ? describe : describe.skip;
const clangAvailable = darwin
  && spawnSync('sh', ['-c', 'command -v clang'], { stdio: 'ignore' }).status === 0;
const ccIt = clangAvailable ? it : it.skip;

const SELF = 'cli_self0000000000';
const SIB = 'cli_sibling0000000';

d('Seatbelt withhold-bot-secret enforcement (real sandbox-exec, #3676)', () => {
  let S: string, HOME: string, STORE: string, BM: string, SD: string, BOT_HOME: string, OUTBOX: string, PROJ: string;
  let n = 0;
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return p; } };

  beforeAll(() => {
    S = canonical(mkdtempSync(join(tmpdir(), 'fsp-withhold-')));
    HOME = join(S, 'home');
    STORE = join(HOME, 'Library/Application Support/lark-cli');
    BM = join(HOME, '.botmux');
    SD = join(BM, 'data');
    BOT_HOME = join(BM, 'bots', SELF);
    OUTBOX = join(SD, 'sandboxes', 'sess-1', 'outbox');
    PROJ = join(S, 'proj');
    for (const dir of [STORE, join(HOME, 'Library/Application Support/other'), BOT_HOME, join(BM, 'bots', SIB), OUTBOX, PROJ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(STORE, 'master.key.file'), 'MASTER');
    writeFileSync(join(STORE, `appsecret_${SELF}.enc`), 'SELF-SECRET');
    writeFileSync(join(STORE, `appsecret_${SIB}.enc`), 'SIB-SECRET');
    writeFileSync(join(HOME, 'Library/Application Support/other/x.txt'), 'other');
    writeFileSync(join(HOME, 'plain.txt'), 'plain');
    writeFileSync(join(BOT_HOME, 'send-cred.json'), '{"larkAppSecret":"PLAINTEXT"}');
    writeFileSync(join(PROJ, 'readme.md'), 'proj');
  });
  afterAll(() => { if (S) rmSync(S, { recursive: true, force: true }); });

  const ctx = (over: Partial<FsPolicyContext> = {}): FsPolicyContext => ({
    platform: 'darwin', homeDir: HOME, botmuxHome: BM, sessionDataDir: SD,
    workingDir: PROJ, currentAppId: SELF, sessionId: 'sess-1', botHome: BOT_HOME,
    outbox: OUTBOX, redirectedCliData: true,
    execPaths: [dirname(canonical(process.execPath)), S],
    net: true, writeRegexes: [],
    ...over,
  });
  const profileOf = (policy: FsPolicy, mutate?: (text: string) => string): string => {
    const p = join(S, `p${n++}.sb`);
    const text = compileToSeatbelt(policy);
    writeFileSync(p, mutate ? mutate(text) : text);
    return p;
  };
  const profile = (over: Partial<FsPolicyContext> = {}) => profileOf(buildFsPolicy(ctx(over)));
  const run = (prof: string, ...argv: string[]) =>
    spawnSync('sandbox-exec', ['-f', prof, ...argv], { encoding: 'utf8', timeout: 10_000 });
  const ok = (prof: string, ...argv: string[]) => run(prof, ...argv).status === 0;

  const keys = () => [join(STORE, 'master.key.file'), join(STORE, `appsecret_${SELF}.enc`), join(STORE, `appsecret_${SIB}.enc`)];
  const expectStoreSealed = (prof: string, label: string) => {
    for (const k of keys()) expect(ok(prof, '/bin/cat', k), `${label}: read ${k}`).toBe(false);
    expect(ok(prof, '/bin/ls', STORE), `${label}: list store`).toBe(false);
    expect(ok(prof, '/usr/bin/touch', join(STORE, 'planted')), `${label}: write into store`).toBe(false);
    expect(ok(prof, '/bin/cp', join(PROJ, 'readme.md'), join(STORE, 'master.key.file')), `${label}: overwrite key`).toBe(false);
  };

  // ── 1. keystore sealed under every grant vector ──────────────────────────────
  describe('withheld keystore stays sealed (#3672 vectors)', () => {
    const W = { withholdSendCredential: true } as const;
    const vectors: [string, () => Partial<FsPolicyContext>, (() => string) | null][] = [
      ['default', () => ({ ...W }), null],
      ['workingDir = keystore', () => ({ ...W, workingDir: STORE }), null],
      ['workingDir = $HOME (ancestor)', () => ({ ...W, workingDir: HOME }), () => join(HOME, 'plain.txt')],
      ['workingDir = Application Support (parent)', () => ({ ...W, workingDir: dirname(STORE) }), () => join(HOME, 'Library/Application Support/other/x.txt')],
      ['user rw = keystore', () => ({ ...W, userPaths: { readWrite: [STORE] } }), null],
      ['user rw = exact keys', () => ({ ...W, userPaths: { readWrite: keys() } }), null],
      ['user ro = exact keys', () => ({ ...W, userPaths: { readOnly: keys() } }), null],
      ['user ro = keystore', () => ({ ...W, userPaths: { readOnly: [STORE] } }), null],
      ['user rw = $HOME', () => ({ ...W, userPaths: { readWrite: [HOME] } }), () => join(HOME, 'plain.txt')],
      ['user ro = /', () => ({ ...W, userPaths: { readOnly: ['/'] } }), () => join(HOME, 'plain.txt')],
      ['mandatory/service ro = exact keys', () => ({ ...W, mandatoryReadOnlyPaths: keys(), serviceCredentialReadOnlyPaths: keys() }), null],
      ['readonlyRoots + extraWrite = $HOME', () => ({ ...W, readonlyRoots: [HOME], extraWritePaths: [HOME] }), () => join(HOME, 'plain.txt')],
      ['assistantMode alone (no withhold flag)', () => ({ assistantMode: true }), null],
    ];
    for (const [label, over, control] of vectors) {
      it(label, () => {
        const prof = profile(over());
        // positive controls: the sandbox works and (where granted) the ancestor grant is live
        expect(ok(prof, '/bin/cat', join(PROJ, 'readme.md')) || label.startsWith('workingDir'), `${label}: control proj`).toBe(true);
        if (control) expect(ok(prof, '/bin/cat', control()), `${label}: control ${control()}`).toBe(true);
        expectStoreSealed(prof, label);
      });
    }

    it('last-match backstop: an injected finalReadOnly "/" grant still cannot reopen the store', () => {
      const policy = buildFsPolicy(ctx({ ...W, workingDir: HOME }));
      policy.finalReadOnlyPaths = [...(policy.finalReadOnlyPaths ?? []), '/', HOME, STORE];
      const prof = profileOf(policy);
      expect(ok(prof, '/bin/cat', join(HOME, 'plain.txt'))).toBe(true);
      expectStoreSealed(prof, 'finalRO /');
      // negative control: without the finalDeny lines the same grant DOES reopen it,
      // proving the kernel honours last-match and the backstop is what holds.
      const noBackstop = profileOf({ ...policy, finalDenyPaths: [] });
      expect(ok(noBackstop, '/bin/cat', join(STORE, `appsecret_${SIB}.enc`))).toBe(true);
    });

    it('send-cred.json in BOT_HOME is denied while BOT_HOME stays usable', () => {
      const prof = profile(W);
      expect(ok(prof, '/bin/cat', join(BOT_HOME, 'send-cred.json'))).toBe(false);
      expect(ok(prof, '/usr/bin/touch', join(BOT_HOME, 'scratch.txt'))).toBe(true);
    });
  });

  // ── 2. KERN_PROCARGS2 / process-info ────────────────────────────────────────
  ccIt('KERN_PROCARGS2: sandbox cannot read a host process env; host still can; both denies are required', async () => {
    const src = join(S, 'procargs.c');
    const bin = join(S, 'procargs');
    writeFileSync(src, [
      '#include <sys/sysctl.h>', '#include <stdio.h>', '#include <stdlib.h>', '#include <string.h>',
      'int main(int c, char **v) {',
      '  int pid = atoi(v[1]); int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};',
      '  size_t sz = 0; int am = 0; size_t asz = sizeof(am);',
      '  int mibm[2] = {CTL_KERN, KERN_ARGMAX};',
      '  if (sysctl(mibm, 2, &am, &asz, NULL, 0) != 0) am = 1 << 20;',
      '  char *buf = malloc(am); sz = am;',
      '  if (sysctl(mib, 3, buf, &sz, NULL, 0) != 0) { printf("DENIED\\n"); return 0; }',
      '  for (size_t i = 0; i + 1 < sz; i++) if (memcmp(buf + i, "WITHHOLD_MARKER=", 16) == 0) { printf("LEAK %s\\n", buf + i); return 0; }',
      '  printf("NOMARK\\n"); return 0;',
      '}',
    ].join('\n'));
    const cc = spawnSync('clang', ['-o', bin, src], { encoding: 'utf8' });
    expect(cc.status, cc.stderr).toBe(0);

    // detached = own process group, like production: the pane runs under tmux or
    // node-pty, both of which setsid() the pane, so the worker that holds the
    // secret is never in the sandboxed process's group. (Same-group: see below.)
    const host: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, env: { ...process.env, WITHHOLD_MARKER: 'top-secret-42' } });
    const verdict = (...argv: string[]) => {
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 8_000 });
      const out = (r.stdout ?? '').trim();
      expect(['DENIED', 'NOMARK', 'LEAK WITHHOLD_MARKER=top-secret-42'], `${argv.join(' ')} → ${r.status} ${r.signal} ${r.stderr}`).toContain(out);
      return out;
    };
    try {
      const pid = String(host.pid);
      const LEAK = 'LEAK WITHHOLD_MARKER=top-secret-42';
      expect(verdict(bin, pid)).toBe(LEAK); // unsandboxed host process: unaffected
      const policy = buildFsPolicy(ctx({ withholdSendCredential: true }));
      expect(verdict('sandbox-exec', '-f', profileOf(policy), bin, pid)).toBe('DENIED');
      // flag off → the same probe leaks: the denies are what blocks it
      expect(verdict('sandbox-exec', '-f', profile({}), bin, pid)).toBe(LEAK);
      // each deny alone is NOT enough (the reason both are emitted)
      const noProcInfo = profileOf(policy, t => t.replace('(deny process-info* (target others))\n', ''));
      const noSysctl = profileOf(policy, t => t.replace('(deny sysctl-read (sysctl-name-prefix "kern.procargs"))\n', ''));
      expect(verdict('sandbox-exec', '-f', noProcInfo, bin, pid), 'only sysctl deny').toBe(LEAK);
      expect(verdict('sandbox-exec', '-f', noSysctl, bin, pid), 'only process-info deny').toBe(LEAK);

      // KNOWN KERNEL LIMIT (measured macOS 26.5.2): neither deny is enforced when
      // the target shares the caller's PROCESS GROUP — a sandboxed child spawned
      // without setsid/setpgid still reads its parent's env. Pinned here so a
      // future spawn path that skips the new session (or an OS change) is noticed.
      const sameGroup = spawnSync(process.execPath, ['-e',
        `const r=require('child_process').spawnSync('sandbox-exec',['-f',${JSON.stringify(profileOf(policy))},${JSON.stringify(bin)},String(process.pid)],{encoding:'utf8'});process.stdout.write(r.stdout)`],
        { encoding: 'utf8', env: { ...process.env, WITHHOLD_MARKER: 'top-secret-42' } });
      expect(sameGroup.stdout.trim(), 'same-pgid parent').toBe(LEAK);
      const ownGroup = spawnSync(process.execPath, ['-e',
        `const r=require('child_process').spawnSync('sandbox-exec',['-f',${JSON.stringify(profileOf(policy))},${JSON.stringify(bin)},String(process.pid)],{encoding:'utf8',detached:true});process.stdout.write(r.stdout)`],
        { encoding: 'utf8', env: { ...process.env, WITHHOLD_MARKER: 'top-secret-42' } });
      expect(ownGroup.stdout.trim(), 'parent, child in own group').toBe('DENIED');

      // reverse direction: a host process reading a SANDBOXED process is unaffected
      const boxed = spawn('sandbox-exec', ['-f', profileOf(policy), '/usr/bin/env', 'WITHHOLD_MARKER=top-secret-42', process.execPath, '-e', 'setTimeout(()=>{},30000)']);
      await new Promise(r => setTimeout(r, 500));
      const pg = spawnSync('pgrep', ['-P', String(boxed.pid)], { encoding: 'utf8' }).stdout.trim() || String(boxed.pid);
      try { expect(verdict(bin, pg.split('\n')[0])).toBe(LEAK); } finally { boxed.kill(); }

      // runtimes still start with self process-info allowed
      expect(ok(profileOf(policy), 'node', '-e', 'require("os").cpus(); process.exit(0)')).toBe(true);
    } finally { host.kill(); }
  });

  // ── 3. BOT_HOME / outbox pinned against rename/unlink ───────────────────────
  describe('BOT_HOME and outbox pinned (file-write-unlink)', () => {
    let prof: string;
    beforeAll(() => { prof = profile({ withholdSendCredential: true }); });

    it('directory itself cannot be renamed or removed', () => {
      expect(ok(prof, '/bin/mv', BOT_HOME, join(PROJ, "moved-bothome"))).toBe(false);
      expect(ok(prof, '/bin/mv', OUTBOX, join(PROJ, "moved-outbox"))).toBe(false);
      expect(ok(prof, '/bin/rmdir', OUTBOX)).toBe(false);
      expect(ok(prof, '/bin/rm', '-rf', OUTBOX)).toBe(false);
      expect(ok(prof, 'node', '-e', `require('fs').renameSync(${JSON.stringify(OUTBOX)}, ${JSON.stringify(join(PROJ, 'stolen'))})`)).toBe(false);
      expect(existsSync(BOT_HOME) && existsSync(OUTBOX)).toBe(true);
    });

    it('normal writes inside keep working', () => {
      for (const dir of [BOT_HOME, OUTBOX]) {
        expect(ok(prof, '/usr/bin/touch', join(dir, 'a'))).toBe(true);
        expect(ok(prof, '/bin/mv', join(dir, 'a'), join(dir, 'b'))).toBe(true);
        expect(ok(prof, '/bin/mkdir', join(dir, 'sub'))).toBe(true);
        expect(ok(prof, '/bin/rm', '-r', join(dir, 'b'), join(dir, 'sub'))).toBe(true);
      }
    });

    it('control: without the flag the same renames succeed (pin is what blocks them)', () => {
      const off = profile({});
      for (const dir of [OUTBOX, BOT_HOME]) {
        const tmp = join(PROJ, 'moved-' + dir.split('/').pop());
        expect(ok(off, '/bin/mv', dir, tmp), dir).toBe(true);
        spawnSync('/bin/mv', [tmp, dir]);
        expect(existsSync(dir)).toBe(true);
      }
    });

    it('host fs.watch on the outbox sees files written from inside the sandbox', async () => {
      const seen: string[] = [];
      const w = watch(OUTBOX, (_e, f) => { if (f) seen.push(String(f)); });
      try {
        expect(ok(prof, 'node', '-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(OUTBOX, 'req.tmp'))},'{}');fs.renameSync(${JSON.stringify(join(OUTBOX, 'req.tmp'))},${JSON.stringify(join(OUTBOX, 'req.json'))})`)).toBe(true);
        for (let i = 0; i < 20 && !seen.includes('req.json'); i++) await new Promise(r => setTimeout(r, 100));
        expect(seen).toContain('req.json');
      } finally { w.close(); }
    });
  });

  // ── 4. flag off: own-key carve-out still works ───────────────────────────────
  it('flag off: own master.key + appsecret readable read-only, sibling denied', () => {
    const prof = profile({});
    expect(ok(prof, '/bin/cat', join(STORE, 'master.key.file'))).toBe(true);
    expect(ok(prof, '/bin/cat', join(STORE, `appsecret_${SELF}.enc`))).toBe(true);
    expect(ok(prof, '/bin/cat', join(STORE, `appsecret_${SIB}.enc`))).toBe(false);
    expect(ok(prof, '/bin/cp', join(PROJ, 'readme.md'), join(STORE, `appsecret_${SELF}.enc`))).toBe(false);
    expect(ok(prof, '/usr/bin/touch', join(STORE, 'planted'))).toBe(false);
  });
});
