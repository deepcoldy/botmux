import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker } from '../src/types.js';

const fixtures: { root: string; child: ChildProcess; cliObservation: string }[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, logs: string[], timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${logs.join('')}`);
    await pause(20);
  }
}
afterEach(async () => {
  for (const { root, child, cliObservation } of fixtures.splice(0)) {
    if (child.connected) try { child.send({ type: 'close' }, () => {}); } catch { /* exiting */ }
    await until(() => child.exitCode !== null || child.signalCode !== null, [], 3000).catch(() => child.kill('SIGKILL'));
    await until(() => child.exitCode !== null || child.signalCode !== null, [], 3000);
    if (existsSync(cliObservation)) {
      const { pid } = JSON.parse(readFileSync(cliObservation, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real worker session temp injection', () => {
  it.each(['inherit', 'strict'] as const)('pins worker and CLI temp directories with %s environment', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-temp-'));
    const dataDir = join(root, 'data');
    const ambientTemp = join(root, 'ambient');
    mkdirSync(dataDir); mkdirSync(ambientTemp);
    const cliObservation = join(root, 'cli-env.json');
    const workerObservation = join(root, 'worker-env.json');
    const cli = join(root, 'fake-pi');
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('pi 0.1.0'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(cliObservation)}, JSON.stringify({ pid: process.pid, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, tmpdir: require('node:os').tmpdir() }));
process.stdin.resume();
process.stdout.write('Ready\\n');
setInterval(() => {}, 1000);
`);
    chmodSync(cli, 0o755);
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('test/fixtures/session-temp-worker-probe.ts'), [], {
      cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, HOME: root, USERPROFILE: root, SESSION_DATA_DIR: dataDir,
        TMPDIR: ambientTemp, TMP: ambientTemp, TEMP: ambientTemp,
        SESSION_TEMP_CLI_OBSERVATION: cliObservation, SESSION_TEMP_WORKER_OBSERVATION: workerObservation,
        BOTMUX_SESSION_ID: 'temp-env-probe', BOTMUX_TIME_SCALE: '0.05',
        LARK_APP_ID: 'app_temp_test', LARK_APP_SECRET: 'fixture-only',
      },
    });
    fixtures.push({ root, child, cliObservation });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', msg => logs.push(JSON.stringify(msg)));
    child.send({ type: 'init', sessionId: 'temp-env-probe', chatId: 'oc_temp', rootMessageId: 'om_temp',
      workingDir: dataDir, cliId: 'pi', cliPathOverride: cli, backendType: 'pty', prompt: '',
      envPolicy: { mode }, larkAppId: 'app_temp_test', larkAppSecret: 'fixture-only',
    } satisfies DaemonToWorker);
    await until(() => existsSync(workerObservation) && existsSync(cliObservation), logs);
    const profile = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16);
    const expected = join(root, '.cache', 'botmux', 'session-tmp', profile, 'temp-env-probe');
    for (const file of [workerObservation, cliObservation]) {
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ TMPDIR: expected, TMP: expected, TEMP: expected, tmpdir: expected });
    }
    expect(existsSync(expected)).toBe(true);
  }, 25000);
});
