/* Integration harness for ZellijBackend managed mode against real zellij.
 * Run: node_modules/.bin/tsx scripts/zellij-harness.ts
 */
import { ZellijBackend } from '../src/adapters/backend/zellij-backend.js';
import { readlinkSync } from 'node:fs';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SID = 'harness01-' + process.pid;
const name = ZellijBackend.sessionName(SID);

function banner(s: string) { console.log(`\n=== ${s} ===`); }

async function main() {
  // Clean any stale corpse.
  ZellijBackend.killSession(name);

  banner('1) fresh spawn: a read-echo loop as the "CLI"');
  let out = '';
  const be = new ZellijBackend(name, { ownsSession: true });
  be.spawn('bash', ['-c', 'echo READY; while IFS= read -r l; do echo "GOT:$l"; done'], {
    cwd: '/tmp', cols: 100, rows: 30, env: process.env as Record<string, string>,
  });
  be.onData(d => { out += d; });
  let exited = false;
  be.onExit((code) => { exited = true; console.log(`onExit code=${code}`); });
  await sleep(2500);
  console.log('isReattach:', be.isReattach, '(expect false)');
  console.log('hasSession after spawn:', ZellijBackend.hasSession(name), '(expect true)');
  console.log('READY seen:', /READY/.test(out));

  banner('2) input round-trip: write + sendSpecialKeys(Enter)');
  be.sendText('hello-zellij');
  be.sendSpecialKeys('Enter');
  await sleep(1200);
  console.log('GOT:hello-zellij seen:', /GOT:hello-zellij/.test(out));

  banner('3) getChildPid');
  const pid = be.getChildPid();
  console.log('childPid:', pid, '(expect a number; /proc cwd below)');
  if (pid) {
    try { console.log('  pid cwd:', readlinkSync(`/proc/${pid}/cwd`)); } catch (e: any) { console.log('  cwd read err', e.message); }
  }

  banner('4) kill (detach) — session must SURVIVE');
  be.kill();
  await sleep(800);
  console.log('exited after kill:', exited, '(expect false — intentional detach suppresses onExit)');
  console.log('hasSession after kill:', ZellijBackend.hasSession(name), '(expect true)');

  banner('5) reattach with a NEW backend (simulates daemon restart)');
  let out2 = '';
  const be2 = new ZellijBackend(name, { ownsSession: true });
  be2.spawn('bash', ['ignored-on-reattach'], { cwd: '/tmp', cols: 100, rows: 30, env: process.env as Record<string, string> });
  be2.onData(d => { out2 += d; });
  await sleep(2000);
  console.log('isReattach:', be2.isReattach, '(expect true)');
  be2.sendText('after-restart');
  be2.sendSpecialKeys('Enter');
  await sleep(1200);
  console.log('GOT:after-restart seen post-reattach:', /GOT:after-restart/.test(out2));

  banner('6) destroySession — session must be GONE');
  be2.destroySession();
  await sleep(1000);
  console.log('hasSession after destroy:', ZellijBackend.hasSession(name), '(expect false)');

  // Final cleanup safety.
  ZellijBackend.killSession(name);
  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error('HARNESS ERROR', e); ZellijBackend.killSession(name); process.exit(1); });
