// Fresh runtime isolates built-in fs mocks from every other test. Bun snapshots
// named built-in imports; Node exposes them through syncBuiltinESMExports.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hop = process.argv[2];
if (hop !== 'root' && hop !== 'intermediate') throw new Error('invalid_probe');
const root = fs.mkdtempSync(join(tmpdir(), 'background-uid-probe-'));
try {
  fs.mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
  fs.writeFileSync(join(root, 'sys/kernel/random/boot_id'), 'probe-boot');
  for (const [pid, parent, birth] of [[100, 1, '1000'], [101, 100, '1001'], [102, 101, '1002']] as const) {
    fs.mkdirSync(join(root, String(pid)));
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[19] = birth;
    fs.writeFileSync(join(root, String(pid), 'stat'), `${pid} (fixture) ${fields.join(' ')}`);
  }
  const actual = fs.statSync;
  let armed = false, beforePeerCheck = true, mismatches = 0;
  const actualRead = fs.readFileSync;
  const readFileSync = ((path: fs.PathOrFileDescriptor, options?: any) => {
    if (armed && String(path) === join(root, '102', 'stat')) beforePeerCheck = false;
    return actualRead(path, options);
  }) as typeof fs.readFileSync;
  const statSync = ((path: fs.PathLike, options?: any) => {
    const stat = actual(path, options);
    // Only the first root observation differs: the later ancestry check must
    // not accidentally cover deletion of the independent initial root check.
    const wrong = armed && (hop === 'root'
      ? String(path) === join(root, '100') && beforePeerCheck
      : String(path) === join(root, '101'));
    if (wrong) mismatches++;
    return wrong ? { ...stat, uid: stat.uid + 1 } : stat;
  }) as typeof fs.statSync;
  if (typeof (globalThis as any).Bun !== 'undefined') {
    const { mock } = await import('bun:test');
    mock.module('node:fs', () => ({ ...fs, statSync, readFileSync }));
  } else {
    fs.statSync = statSync;
    fs.readFileSync = readFileSync;
    syncBuiltinESMExports();
  }
  const { backgroundPeerBelongsToJob } = await import('../../src/core/background-execution-policy.js');
  const job: import('../../src/core/background-execution-policy.js').BackgroundExecutionRegistration = {
    id: '12345678-1234-1234-1234-123456789abc', appId: 'cli_probe', sessionId: 's-probe', taskId: 'abcd1234',
    turnId: 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc', root: { pid: 100, procStart: '1000' },
    uid: process.getuid!(), bootId: 'probe-boot', expiresAt: Date.now() + 60_000,
    openId: 'ou_probe', unionId: 'on_probe', authEpoch: 0, authorityKey: '', credentialPolicyKey: '',
  };
  const peer = { pid: 102, procStart: '1002' };
  const baseline = backgroundPeerBelongsToJob(job, peer, root);
  armed = true;
  const guarded = backgroundPeerBelongsToJob(job, peer, root);
  process.stdout.write(JSON.stringify({ baseline, guarded, mismatches }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
