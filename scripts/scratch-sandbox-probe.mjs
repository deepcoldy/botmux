#!/usr/bin/env node
/**
 * scratch-sandbox-probe — verify the SCRATCH full-root COW sandbox on THIS
 * machine by driving the real prepareScratchSandbox() (no daemon / Feishu).
 *
 *   bun run build
 *   node scripts/scratch-sandbox-probe.mjs           # tmpfs storage (default)
 *   node scripts/scratch-sandbox-probe.mjs --disk    # disk-backed upper
 *
 * Exit 0 = every expectation held; 1 = at least one failure (printed).
 */
import { prepareScratchSandbox, sweepOrphanScratchSandboxes, remapIntoMerged } from '../dist/adapters/backend/scratch-sandbox.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const storage = process.argv.includes('--disk') ? 'disk' : 'tmpfs';
const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
};

const dataDir = mkdtempSync(join(tmpdir(), 'botmux-scratch-data-'));
const workDir = mkdtempSync(join(tmpdir(), 'botmux-scratch-cwd-'));
const sid = `probe-${process.pid}-${Date.now()}`;

// A real host file + dir to attempt touching.
const canaryFile = join(workDir, 'CANARY_HOST');
writeFileSync(canaryFile, 'host-original');
const denyFile = join(homedir(), '.botmux-probe-deny');
mkdirSync(join(homedir()), { recursive: true });
writeFileSync(denyFile, 'SECRET');

const script = [
  'set -e',
  // 1. whole real fs readable
  'echo READ_ETC=$(head -c 4 /etc/hostname | wc -c)',
  `echo READ_HOMEFILE=$(cat ${JSON.stringify(canaryFile)})`,
  // 2. writes anywhere COW, never host
  'echo container > /etc/PROBE_SCRATCH_ETC || true',
  'echo container > /root/PROBE_SCRATCH_HOME || true',
  'echo mutated >> ' + JSON.stringify(canaryFile),
  'echo proj > ' + JSON.stringify(join(workDir, 'PROBE_PROJECT')) ,
  // 3. deny mask really denies
  `echo DENIED_CONTENT=$(cat ${JSON.stringify(denyFile)} 2>&1 || true)`,
  `echo WRITE_DENIED=$(echo x >> ${JSON.stringify(denyFile)} 2>&1 && echo YES || echo NO)`,
  // 4. outbox passthrough is host-real (written by CLI, read by daemon)
  'echo relay-payload > "$BOTMUX_SEND_RELAY/req.json"',
  // 5. fresh tmpfs scratch areas usable
  'echo tmp > /tmp/PROBE_TMP && echo TMP_OK',
  // 6. submount (/data00 on this host) visible, not empty shadow
  '[ -d /data00 ] && ls /data00 | head -1 | sed "s/^/DATA00_FIRST=/" || true',
].join('; ');

let sbx = null;
try {
  sbx = prepareScratchSandbox({
    sessionId: sid,
    dataDir,
    storage,
    chdir: workDir,
    home: homedir(),
    cliBin: '/bin/sh',
    cliArgs: ['-c', script],
    denyPaths: [denyFile],
  });

  check('prepareScratchSandbox returned spawn', !!sbx, sbx ? `merged=${sbx.mergedHostPath} storage=${sbx.effectiveStorage}` : 'null');
  if (!sbx) process.exit(1);

  const r = spawnSync(sbx.bin, sbx.args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  console.log('--- container stdout ---');
  process.stdout.write(r.stdout);
  if (r.stderr) { console.log('--- container stderr ---'); process.stdout.write(r.stderr); }
  check('container exited 0', r.status === 0, `status=${r.status}`);
  const out = r.stdout ?? '';

  check('reads whole fs (/etc)', /READ_ETC=4/.test(out));
  check('reads real home/project file', /READ_HOMEFILE=host-original/.test(out));
  check('deny file unreadable in sandbox', /DENIED_CONTENT=(\s*$|Permission|No such)/m.test(out));
  check('deny file not writable', /WRITE_DENIED=NO/.test(out));
  check('tmp areas writable', /TMP_OK/.test(out));
  check('submount /data00 has real content', /DATA00_FIRST=\S+/.test(out), 'empty shadow would print nothing');

  // Host-side: zero leak checks.
  check('host /etc untouched', !existsSync('/etc/PROBE_SCRATCH_ETC'));
  check('host /root untouched', !existsSync('/root/PROBE_SCRATCH_HOME'));
  check('host project canary unchanged', readFileSync(canaryFile, 'utf8') === 'host-original');
  check('host project dir has no container file', !existsSync(join(workDir, 'PROBE_PROJECT')));
  check('deny file host content intact', readFileSync(denyFile, 'utf8') === 'SECRET');

  // Outbox written by container is readable at the REAL host outbox path.
  check('outbox passthrough host-real', readFileSync(join(sbx.outbox, 'req.json'), 'utf8').trim() === 'relay-payload');

  // Container products visible via merged remap.
  const remapped = remapIntoMerged(sbx.mergedHostPath, join(workDir, 'PROBE_PROJECT'));
  check('remapIntoMerged points at COW copy', remapped && readFileSync(remapped, 'utf8').trim() === 'proj');

  // While mounted, merged carries the changes.
  check('COW etc file present in merged only', readFileSync(join(sbx.mergedHostPath, 'etc/PROBE_SCRATCH_ETC'), 'utf8').trim() === 'container');

  sbx.cleanup();
  check('cleanup unmounted merged', spawnSync('mountpoint', ['-q', sbx.mergedHostPath]).status !== 0);
  check('cleanup removed session tree', !existsSync(join(dataDir, 'sandboxes', sid)));
  check('cleanup removed tmpfs slot', !existsSync(join('/var/tmp/botmux-sbx', sid)));
} finally {
  try { sbx?.cleanup(); } catch { /* */ }
  // sweep should no-op on the absent tree and never throw
  sweepOrphanScratchSandboxes(dataDir, new Set());
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  try { rmSync(denyFile, { force: true }); } catch { /* */ }
}

console.log(failures.length ? `\n${failures.length} FAILURE(S): ${failures.join('; ')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
