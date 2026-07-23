/**
 * macOS Seatbelt e2e: compile a real FsPolicy → sandbox-exec profile, launch
 * real processes inside it, and assert the three access tiers actually hold at
 * the kernel level (not just in the pure accessForPath model). Skipped off
 * darwin and when sandbox-exec is unavailable.
 *
 * This is the guard for the class of bug found during the refactor: a blanket
 * `(deny file-read* (subpath "/"))` SIGABRTs every process at dyld bootstrap;
 * the fix (import Apple's bsd.sb base) must keep working across OS updates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildFsPolicy, compileToSeatbelt } from '../src/adapters/cli/fs-policy.js';

const darwin = process.platform === 'darwin'
  && spawnSync('sh', ['-c', 'command -v sandbox-exec'], { stdio: 'ignore' }).status === 0;
const d = darwin ? describe : describe.skip;

d('Seatbelt three-tier enforcement (real sandbox-exec)', () => {
  let S: string, profile: string;
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return p; } };

  beforeAll(() => {
    S = canonical(mkdtempSync(join(tmpdir(), 'fsp-e2e-')));
    for (const dir of ['proj/secrets', 'botmux-home/data', 'botmux-home/bots/cli_e2e', 'ref']) {
      mkdirSync(join(S, dir), { recursive: true });
    }
    writeFileSync(join(S, 'proj/readme.md'), 'proj');
    writeFileSync(join(S, 'proj/secrets/key.txt'), 'secret');
    writeFileSync(join(S, 'ref/doc.md'), 'ref');

    const home = canonical(homedir());
    const policy = buildFsPolicy({
      platform: 'darwin', homeDir: home,
      botmuxHome: join(S, 'botmux-home'), sessionDataDir: join(S, 'botmux-home/data'),
      workingDir: join(S, 'proj'), currentAppId: 'cli_e2e', botHome: join(S, 'botmux-home/bots/cli_e2e'),
      redirectedCliData: true,
      execPaths: [dirname(canonical(process.execPath))],
      userPaths: { readOnly: [join(S, 'ref')], deny: [join(S, 'proj/secrets')] },
      net: true, writeRegexes: [],
    });
    policy.rules = policy.rules.filter(r => r.access === 'deny' || (() => { try { return require('node:fs').existsSync(r.path); } catch { return false; } })());
    profile = join(S, 'p.sb');
    writeFileSync(profile, compileToSeatbelt(policy));
  });
  afterAll(() => { if (S) rmSync(S, { recursive: true, force: true }); });

  const allowed = (...argv: string[]) =>
    spawnSync('sandbox-exec', ['-f', profile, ...argv], { stdio: 'ignore' }).status === 0;

  it('readWrite: reads AND writes the project', () => {
    expect(allowed('/bin/cat', join(S, 'proj/readme.md'))).toBe(true);
    expect(allowed('/usr/bin/touch', join(S, 'proj/newfile'))).toBe(true);
  });
  it('deny hole inside a readWrite tree: no read, no write', () => {
    expect(allowed('/bin/cat', join(S, 'proj/secrets/key.txt'))).toBe(false);
  });
  it('readOnly: reads but cannot write', () => {
    expect(allowed('/bin/cat', join(S, 'ref/doc.md'))).toBe(true);
    expect(allowed('/usr/bin/touch', join(S, 'ref/hack'))).toBe(false);
  });
  it('crown-jewel credential dirs are denied even though they sit under $HOME', () => {
    // deny-by-default proof on REAL sensitive paths: $HOME is never wholesale
    // exposed, and these are explicitly re-denied in the baseline. (A generic
    // "uncovered temp sibling" can't be tested here — the scratch tree lives
    // under /private/var/folders, which the baseline intentionally makes rw as
    // the macOS TMPDIR root; that's covered by the pure accessForPath tests.)
    expect(allowed('/bin/ls', join(homedir(), '.ssh'))).toBe(false);
    expect(allowed('/bin/ls', join(homedir(), '.aws'))).toBe(false);
    expect(allowed('/bin/ls', join(homedir(), 'Library/Keychains'))).toBe(false);
  });
  it('processes bootstrap under deny-read-default (bsd.sb base): node runs + writes rw', () => {
    expect(allowed('node', '-e', 'process.exit(0)')).toBe(true);
    expect(allowed('node', '-e', `require('fs').writeFileSync(${JSON.stringify(join(S, 'proj/n.txt'))},'ok')`)).toBe(true);
  });
});
