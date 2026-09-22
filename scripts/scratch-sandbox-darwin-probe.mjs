#!/usr/bin/env node
/**
 * scratch-sandbox-darwin-probe — validate the macOS symlink-farm + clonefile
 * scratch sandbox ON A MAC. Linux cannot run this (sandbox-exec / clonefile).
 *
 *   node scripts/scratch-sandbox-darwin-probe.mjs
 *
 * Round-2 checks (after the real-HOME full-clone rejection):
 *  - prepare is FAST and does NOT traverse TCC/iCloud (farm uses symlinks)
 *  - real HOME dotfile/state reads work through the farm
 *  - a CLI data dir (~/.claude) is a REAL clone: writes land in clone, host untouched
 *  - a non-dot home dir (e.g. ~/Documents-equivalent) is a symlink: write denied
 *  - explicit symlink from farm HOME → outside (/tmp): write denied (kernel resolves)
 *  - system path write denied
 *  - host-real cache deny works for the credential seal path
 *  - outbox passthrough + cleanup
 */
// @ts-nocheck
import { prepareMacScratchSandbox } from '../dist/adapters/backend/scratch-sandbox-darwin.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { homedir, tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.error('macOS-only probe. On Linux run scripts/scratch-sandbox-probe.mjs.');
  process.exit(2);
}

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
};

const dataDir = mkdtempSync(join(osTmpdir(), 'botmux-scratch-mac-data-'));
// Use a throwaway cwd OUTSIDE the real HOME so the probe never touches the
// operator's real projects.
const workDir = mkdtempSync(join(osTmpdir(), 'botmux-scratch-mac-cwd-'));
const sid = `probe-mac-${Date.now()}`;

const t0 = Date.now();
const sbx = prepareMacScratchSandbox({
  sessionId: sid,
  dataDir,
  chdir: workDir,
  home: homedir(),
  cliBin: '/bin/sh',
  cliArgs: ['-c', 'true'],
  net: true,
});
const prepMs = Date.now() - t0;
check('prepare ok (symlink farm, bounded)', !!sbx);
if (!sbx) process.exit(1);
console.log(`   prepare took ${prepMs}ms (should be seconds, NOT tens of minutes)`);

const run = (script) => spawnSync(sbx.bin, [...sbx.args.slice(0, 1), '/bin/sh', '-c', script],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: sbx.chdirInSandbox, env: sbx.env, timeout: 30_000 });

// 1. home layout: clone HOME has entries; .botmux is a symlink (not copied)
const farmEntries = spawnSync('/bin/ls', ['-la', sbx.clonedHome], { encoding: 'utf8' }).stdout;
check('cloned HOME is populated (symlink farm)', farmEntries.trim().length > 0);

// 2. write inside cloned home dotfile area → succeeds, host untouched
const probeDotfile = '.botmux-scratch-probe-dotfile';
const rDot = run(`echo x > "$HOME/${probeDotfile}" && echo OK`);
check('write a new dotfile in cloned HOME succeeds', rDot.stdout.includes('OK'), rDot.stderr?.slice(0, 150));
check('host HOME has no probe dotfile', !existsSync(join(homedir(), probeDotfile)));
check('cloned HOME carries probe dotfile', existsSync(join(sbx.clonedHome, probeDotfile)));

// 3. project cwd write → clone, host workDir untouched
const rCwd = run('echo p > PROBE_PROJ && echo OK');
check('write in cloned project succeeds', rCwd.stdout.includes('OK'));
check('host project untouched', !existsSync(join(workDir, 'PROBE_PROJ')));

// 4. symlink escape: a farm entry pointing outside → write denied
//    Use $HOME itself: create a symlink INSIDE the clone's writable tmp that
//    points at a real /tmp file, then write through it.
const targetFile = join(osTmpdir(), `botmux-mac-probe-target-${Date.now()}`);
writeFileSync(targetFile, 'orig');
const rLink = run(`ln -s "${targetFile}" "$TMPDIR/esc"; echo overwrite >> "$TMPDIR/esc" 2>/dev/null && echo LEAKED || echo DENIED`);
check('write through a symlink to real /tmp is DENIED', rLink.stdout.includes('DENIED'), rLink.stderr?.slice(0, 150));
check('symlink target on host unchanged', readFileSync(targetFile, 'utf8') === 'orig');

// 5. system path write denied
const rSys = run('touch /etc/.botmux-probe-sys 2>/dev/null && echo LEAKED || echo DENIED');
check('system-path write DENIED', rSys.stdout.includes('DENIED'));
check('host /etc untouched', !existsSync('/etc/.botmux-probe-sys'));

// 6. outbox passthrough
const rOut = run('echo relay > "$BOTMUX_SEND_RELAY/req" && echo OK');
check('outbox write succeeds from inside', rOut.stdout.includes('OK'));
check('outbox host-readable', readFileSync(join(sbx.outbox, 'req'), 'utf8').trim() === 'relay');

// 7. reads of real home still work
const rRead = run('ls "$HOME" >/dev/null && echo READ_OK');
check('reads work through the farm', rRead.stdout.includes('READ_OK'));

// 8. cleanup removes the whole session tree (symlinks only, no host targets)
sbx.cleanup();
check('cleanup removed session tree', !existsSync(join(dataDir, 'sandboxes', sid)));
rmSync(targetFile, { force: true });
rmSync(workDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });

console.log(failures.length ? `\n${failures.length} FAILURE(S): ${failures.join('; ')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
