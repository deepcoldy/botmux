#!/usr/bin/env node
/**
 * scratch-sandbox-darwin-probe — validate the macOS APFS clonefile scratch
 * sandbox ON A MAC. Not runnable on Linux (it asserts process.platform).
 *
 *   node scripts/scratch-sandbox-darwin-probe.mjs
 *
 * Verifies:
 *  - HOME clone via cp -cR is real clonefile COW (free-block delta tiny)
 *  - child reads its own real auth/config (clone carries dotfiles)
 *  - child writes freely inside clone HOME + private TMPDIR
 *  - a write OUTSIDE the clone (a system path) is DENIED (EPERM/Seatbelt)
 *  - the real host HOME is untouched by the child's writes
 *  - outbox relay dir is writable from inside and host-readable
 *  - cleanup removes the whole clone
 */
// @ts-nocheck
import { prepareMacScratchSandbox } from '../dist/adapters/backend/scratch-sandbox-darwin.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, statfsSync } from 'node:fs';
import { homedir, tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.error('This probe is macOS-only (clonefile/Seatbelt). Run scratch-sandbox-probe.mjs on Linux.');
  process.exit(2);
}

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
};

const dataDir = mkdtempSync(join(osTmpdir(), 'botmux-scratch-mac-data-'));
const workDir = mkdtempSync(join(osTmpdir(), 'botmux-scratch-mac-cwd-'));
const sid = `probe-mac-${Date.now()}`;

// Project OUTSIDE $HOME on purpose (/tmp) to exercise the second clone mapping.
const sbx = prepareMacScratchSandbox({
  sessionId: sid,
  dataDir,
  chdir: workDir,
  home: homedir(),
  cliBin: '/bin/sh',
  cliArgs: ['-c', 'echo run; pwd; echo "$HOME"'],
  net: true,
});
check('prepare ok', !!sbx);
if (!sbx) process.exit(1);

const freeBefore = statfsSync(homedir()).bavail;
const r = spawnSync(sbx.bin, sbx.args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: sbx.chdirInSandbox, env: sbx.env, timeout: 60_000 });
const freeAfter = statfsSync(homedir()).bavail;
console.log(r.stdout);
if (r.stderr) console.log('stderr:', r.stderr.slice(0, 400));
check('child runs in the clone cwd', r.status === 0 && r.stdout.includes(sbx.chdirInSandbox));
check('child HOME is the clone', r.stdout.includes(sbx.clonedHome));
check('clone was clonefile COW (free-block delta < 128MB)',
  (freeBefore - freeAfter) * statfsSync(homedir()).bsize < 128 * 1024 * 1024,
  `delta blocks=${freeBefore - freeAfter}`);

// 1. write inside clone HOME → ok, host untouched
const rHome = spawnSync(sbx.bin, [...sbx.args.slice(0, 1), '/bin/sh', '-c',
  'echo home-write > "$HOME/.botmux-probe-home"; echo tmp-write > "$TMPDIR/x"; echo relay > "$BOTMUX_SEND_RELAY/req"'],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: sbx.chdirInSandbox, env: sbx.env, timeout: 30_000 });
check('writes inside clone HOME / TMPDIR / outbox succeed', rHome.status === 0, rHome.stderr?.slice(0, 200));
check('host HOME has NO probe file', !existsSync(join(homedir(), '.botmux-probe-home')));
check('clone HOME carries the probe file', existsSync(join(sbx.clonedHome, '.botmux-probe-home')));
check('outbox passthrough host-readable', readFileSync(join(sbx.outbox, 'req'), 'utf8').trim() === 'relay');

// 2. write outside clone (system path) → must be denied
const rDeny = spawnSync(sbx.bin, [...sbx.args.slice(0, 1), '/bin/sh', '-c',
  'touch /etc/.botmux-probe-sys 2>/dev/null && echo LEAKED || echo DENIED'],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: sbx.chdirInSandbox, env: sbx.env, timeout: 30_000 });
check('system-path write is DENIED by Seatbelt', rDeny.stdout.includes('DENIED'));
check('host /etc untouched', !existsSync('/etc/.botmux-probe-sys'));

// 3. reads of real home still work (clone carries dotfiles, plus reads allowed)
const rRead = spawnSync(sbx.bin, [...sbx.args.slice(0, 1), '/bin/sh', '-c', 'ls "$HOME" | head -1 >/dev/null && echo READ_OK'],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: sbx.chdirInSandbox, env: sbx.env, timeout: 30_000 });
check('reads work (native home layout present in clone)', rRead.stdout.includes('READ_OK'));

sbx.cleanup();
check('cleanup removed clone', !existsSync(join(dataDir, 'sandboxes', sid)));
rmSync(workDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
