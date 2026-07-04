// Real-mechanics probe for the overlay sandbox AFTER the issue fixes.
// Verifies: reads pass through to real fs, writes outside project are ephemeral,
// project edits show in proj-upper, ~/.claude/.credentials.json readable, and
// the FIFO-in-outbox DoS no longer hangs the relay materialize path.
import { prepareSandbox, materializeOutboxFile } from '../dist/adapters/backend/sandbox.js';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const out = (k, v) => console.log(`${k}=${v}`);
const SRC = '/root/sandbox-demo';
const dataDir = mkdtempSync(join(tmpdir(), 'sbx-probe-'));
const sid = 'probe-' + Math.random().toString(36).slice(2);
const leak = '/root/iserver/botmux/SBXLEAK.txt';

const sbx = prepareSandbox({
  enabled: true, cliId: 'codex', sessionId: sid, sourceWorkingDir: SRC,
  dataDir, cliBin: '/bin/sh', cliArgs: [], hidePaths: [],
});
if (!sbx) { out('PREPARE', 'NULL (overlay mount failed?)'); process.exit(1); }
out('PREPARE', 'OK');
out('UPPER', sbx.workDir);
out('OUTBOX', sbx.outbox);

// The script run inside bwrap: read a real file, attempt an out-of-project write,
// edit a project file, read a credential file.
const inner = [
  'echo "--- read real /etc/hostname ---"',
  'cat /etc/hostname',
  'echo "--- attempt out-of-project write (should be ephemeral, NOT hit real host) ---"',
  `echo SBXLEAK_FROM_AGENT > ${leak} && echo "wrote-inside-sandbox=$(cat ${leak})"`,
  'echo "--- edit a project file ---"',
  `echo "EDITED BY AGENT" > ${SRC}/greeting.txt && echo "in-sandbox greeting=$(cat ${SRC}/greeting.txt)"`,
  `echo "NEW FILE" > ${SRC}/added-by-agent.txt`,
  'echo "--- read ~/.claude credentials ---"',
  `test -r ${join(homedir(), '.claude/.credentials.json')} && echo "creds-readable=YES" || echo "creds-readable=NO"`,
  'echo "--- env relay/home ---"',
  'echo "HOME=$HOME"; echo "BOTMUX_SEND_RELAY=$BOTMUX_SEND_RELAY"; echo "PATH=$PATH"',
].join('\n');

// sbx.args ends with: -- /bin/sh ; replace cliArgs by appending -c <inner>.
const args = [...sbx.args, '-c', inner];
const r = spawnSync(sbx.bin, args, { encoding: 'utf8', env: { ...process.env, ...sbx.env } });
console.log('=== INNER STDOUT ===');
console.log(r.stdout ?? '');
if (r.stderr) { console.log('=== INNER STDERR ==='); console.log(r.stderr.slice(0, 2000)); }
out('INNER_EXIT', r.status);

// Host-side checks after the run.
out('HOST_LEAK_FILE_EXISTS', existsSync(leak));               // MUST be false (write was ephemeral)
out('HOST_PROJECT_GREETING', JSON.stringify(readFileSync(join(SRC, 'greeting.txt'), 'utf8'))); // MUST be unchanged real
out('UPPER_HAS_GREETING', existsSync(join(sbx.workDir, 'greeting.txt')));   // edit copied-up here
out('UPPER_HAS_ADDED', existsSync(join(sbx.workDir, 'added-by-agent.txt')));
try { out('UPPER_LISTING', JSON.stringify(readdirSync(sbx.workDir))); } catch (e) { out('UPPER_LISTING', 'ERR ' + e.message); }

// FIFO-in-outbox DoS: drop a FIFO and confirm materialize returns immediately false.
try {
  execFileSync('mkfifo', [join(sbx.outbox, 'evil')], { stdio: 'ignore' });
  const t0 = Date.now();
  const fr = materializeOutboxFile(sbx.outbox, 'evil', join(dataDir, 'fifo-dest'));
  out('FIFO_MATERIALIZE_RESULT', fr);                          // MUST be false
  out('FIFO_MATERIALIZE_MS', Date.now() - t0);                 // MUST be small (no hang)
  out('FIFO_DEST_CREATED', existsSync(join(dataDir, 'fifo-dest')));
} catch (e) { out('FIFO_TEST', 'skip ' + e.message); }

sbx.cleanup();
out('CLEANUP', 'done');
out('MOUNT_AFTER_CLEANUP_PROJ', spawnSync('mountpoint', ['-q', join(dataDir, 'sandboxes', sid, 'proj-merged')]).status === 0);
out('MOUNT_AFTER_CLEANUP_HOME', spawnSync('mountpoint', ['-q', join(dataDir, 'sandboxes', sid, 'home-merged')]).status === 0);
out('SESSIONROOT_AFTER_CLEANUP', existsSync(join(dataDir, 'sandboxes', sid)));
out('VARTMP_AFTER_CLEANUP', existsSync(join('/var/tmp/botmux-sbx', sid)));
