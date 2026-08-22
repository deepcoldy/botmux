import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapLegacyPm2 } from '../src/core/legacy-pm2-reaper.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'legacy-pm2-')); dirs.push(d); return d; }

// HERMETIC HOME: reapLegacyPm2 also scans homedir()/.pm2 (the shared default pm2
// home). On a machine whose real ~/.pm2 has a live pm2 God (e.g. CI/dev boxes
// running production pm2), leaving HOME unset would let that real God leak into
// every test. Point HOME at a fresh temp dir so the shared-home scan is empty
// unless a test explicitly populates it.
let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = tmp();
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write an executable fake `pm2` at <pkgRoot>/node_modules/pm2/bin/pm2 that
 *  records its args and emits scripted stdout per subcommand. */
function fakePm2(pkgRoot: string, opts: { jlist: string }): string {
  const binDir = join(pkgRoot, 'node_modules', 'pm2', 'bin');
  mkdirSync(binDir, { recursive: true });
  const logFile = join(pkgRoot, 'pm2-calls.log');
  const bin = join(binDir, 'pm2');
  // A tiny node shim: append the subcommand to the log, print jlist JSON for jlist.
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    `const fs=require('fs');`,
    `const args=process.argv.slice(2);`,
    `fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ')+'\\n');`,
    `if(args[0]==='jlist'){process.stdout.write(${JSON.stringify(opts.jlist)});}`,
    `process.exit(0);`,
  ].join('\n'), { mode: 0o755 });
  chmodSync(bin, 0o755);
  return logFile;
}

/** Create a live pm2 God pidfile pointing at our own (alive) pid. */
function liveGodPidfile(home: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'pm2.pid'), String(process.pid));
}

describe('reapLegacyPm2', () => {
  it('no-ops fail-safe when there is no pm2 God pidfile (fresh install)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(false);
    expect(r.deleted).toEqual([]);
    expect(r.killed).toBe(false);
    expect(r.note).toContain('no live legacy pm2 God');
  });

  it('ignores a pidfile whose pid is not alive (dead God)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    // pid 2147483646 is not a live process.
    mkdirSync(join(configDir, 'pm2'), { recursive: true });
    writeFileSync(join(configDir, 'pm2', 'pm2.pid'), '2147483646');
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(false);
  });

  it('detects a live God, deletes its botmux rows, and kills it', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const jlist = JSON.stringify([
      { name: 'botmux' },
      { name: 'botmux-0' },
      { name: 'botmux-plugin-x' }, // plugin services are NOT botmux core → skip
      { name: 'some-other-app' },  // unrelated → skip
    ]);
    const logFile = fakePm2(pkgRoot, { jlist });
    liveGodPidfile(join(configDir, 'pm2'));

    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(true);
    // Only the two core botmux rows are deleted (not plugin-x, not other-app).
    expect(r.deleted.sort()).toEqual(['botmux', 'botmux-0']);
    expect(r.killed).toBe(true);

    const calls = readFileSync(logFile, 'utf-8');
    expect(calls).toContain('jlist');
    expect(calls).toContain('delete botmux');
    expect(calls).toContain('delete botmux-0');
    expect(calls).not.toContain('delete botmux-plugin-x');
    expect(calls).not.toContain('delete some-other-app');
    expect(calls).toContain('kill');
  });

  it('is best-effort: a jlist failure is swallowed, not thrown', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    // Fake pm2 that exits non-zero on jlist.
    const binDir = join(pkgRoot, 'node_modules', 'pm2', 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, 'pm2');
    writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(3);\n', { mode: 0o755 });
    chmodSync(bin, 0o755);
    liveGodPidfile(join(configDir, 'pm2'));

    // Must not throw; found:true (God was live) but nothing deleted/killed.
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(true);
    expect(r.deleted).toEqual([]);
    expect(r.note).toContain('jlist failed');
  });

  it('never `pm2 kill`s the SHARED ~/.pm2 God — only deletes botmux rows there', () => {
    // The shared default home may host the user's own apps; killing its God is
    // destructive. Simulate a live shared God (~/.pm2) via a fake HOME so the
    // reaper's homedir() resolves to our temp dir.
    const configDir = tmp(); // no exclusive botmux God here
    const pkgRoot = tmp();
    const fakeHome = tmp();
    const jlist = JSON.stringify([{ name: 'botmux-0' }, { name: 'users-own-app' }]);
    const logFile = fakePm2(pkgRoot, { jlist });
    liveGodPidfile(join(fakeHome, '.pm2'));

    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let r;
    try {
      r = reapLegacyPm2(configDir, pkgRoot);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
    expect(r.found).toBe(true);
    expect(r.deleted).toEqual(['botmux-0']); // only the botmux row
    expect(r.killed).toBe(false);            // shared God is left running
    const calls = readFileSync(logFile, 'utf-8');
    expect(calls).toContain('delete botmux-0');
    expect(calls).not.toContain('delete users-own-app');
    expect(calls).not.toContain('kill'); // NEVER kill the shared God
  });

  it('ignores a shared ~/.pm2 God that has NO botmux rows (belongs to the user)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const fakeHome = tmp();
    const jlist = JSON.stringify([{ name: 'users-own-app' }, { name: 'another-app' }]);
    fakePm2(pkgRoot, { jlist });
    liveGodPidfile(join(fakeHome, '.pm2'));

    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let r;
    try {
      r = reapLegacyPm2(configDir, pkgRoot);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
    // No botmux rows in the shared home → not our concern → found stays false.
    expect(r.found).toBe(false);
    expect(r.deleted).toEqual([]);
    expect(r.killed).toBe(false);
  });
});
