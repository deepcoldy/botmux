// Self-probe for the overlay sandbox: build prepareSandbox for codex against
// /root/sandbox-demo, run bwrap with a sh -c that exercises read/write isolation,
// then clean up. Run with: node scripts/sandbox-overlay-probe.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandbox } from '../dist/adapters/backend/sandbox.js';

const SRC = '/root/sandbox-demo';
const LEAK = '/root/iserver/botmux/SBXLEAK.txt';
const dataDir = mkdtempSync(join(tmpdir(), 'sbx-probe-'));
const sid = 'probe-' + Date.now();

// pre-clean leak target so a stale file from a prior run doesn't false-positive
try { rmSync(LEAK, { force: true }); } catch {}

const inSandboxScript = `
  set +e
  echo "PROBE: hostname read = $(cat /etc/hostname 2>&1)"
  echo "PROBE: project README first line = $(head -1 README.md 2>&1)"
  echo "PROBE: credentials readable = $( [ -r "$HOME/.claude/.credentials.json" ] && echo YES || echo NO )"
  # write a NEW file inside the project (should land in proj-upper, real untouched)
  echo "edited-by-sandbox" > sandbox_probe_new.txt
  echo "appended-by-sandbox" >> app.py
  echo "PROBE: wrote project files"
  # try to write a real file OUTSIDE the project (must be ephemeral, not landed)
  echo "LEAKED" > ${LEAK} 2>&1 && echo "PROBE: wrote leak file (will check host)" || echo "PROBE: leak write FAILED (good)"
  echo "PROBE: leak file visible inside sandbox = $( [ -f ${LEAK} ] && echo YES || echo NO )"
`;

const sbx = prepareSandbox({
  enabled: true,
  cliId: 'codex',
  sessionId: sid,
  sourceWorkingDir: SRC,
  dataDir,
  cliBin: '/bin/sh',
  cliArgs: ['-c', inSandboxScript],
  hidePaths: [],
});

if (!sbx) {
  console.log('RESULT: prepareSandbox returned null (mount failed / unsupported) — FAIL');
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(2);
}

console.log('PROBE: bwrap bin =', sbx.bin);
console.log('PROBE: upper (changeset) dir =', sbx.workDir);

const env = { ...process.env, ...sbx.env };
const r = spawnSync(sbx.bin, sbx.args, { env, encoding: 'utf8' });
console.log('--- sandbox stdout ---');
console.log(r.stdout || '(none)');
if (r.stderr && r.stderr.trim()) {
  console.log('--- sandbox stderr ---');
  console.log(r.stderr);
}
console.log('PROBE: bwrap exit status =', r.status);

// HOST-side verification
const leakOnHost = existsSync(LEAK);
console.log('VERIFY: leak file present on REAL host =', leakOnHost, leakOnHost ? '(BAD — escape!)' : '(good — isolated)');

const upperNew = join(sbx.workDir, 'sandbox_probe_new.txt');
const upperHasNew = existsSync(upperNew);
console.log('VERIFY: new project file present in proj-upper =', upperHasNew, upperHasNew ? '(good)' : '(BAD)');
if (upperHasNew) console.log('VERIFY: upper new file content =', JSON.stringify(readFileSync(upperNew, 'utf8').trim()));

const upperApp = join(sbx.workDir, 'app.py');
const upperHasApp = existsSync(upperApp);
console.log('VERIFY: modified app.py copied-up into proj-upper =', upperHasApp, upperHasApp ? '(good)' : '(BAD)');

// real project must be UNTOUCHED
const realNew = existsSync(join(SRC, 'sandbox_probe_new.txt'));
const realApp = readFileSync(join(SRC, 'app.py'), 'utf8');
console.log('VERIFY: real project got the NEW file (should be false until /land) =', realNew);
console.log('VERIFY: real app.py contains sandbox append (should be false) =', realApp.includes('appended-by-sandbox'));

// cleanup (unmount overlays + rm trees)
sbx.cleanup();
try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
try { rmSync(LEAK, { force: true }); } catch {}

// final mountpoint sanity
const mp1 = spawnSync('mountpoint', ['-q', join(dataDir, 'sandboxes', sid, 'proj-merged')], { stdio: 'ignore' });
console.log('VERIFY: proj-merged still mounted after cleanup =', mp1.status === 0, '(should be false)');

const pass = !leakOnHost && upperHasNew && upperHasApp && !realNew && !realApp.includes('appended-by-sandbox');
console.log('RESULT:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
