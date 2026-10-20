import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { tsEvalArgs } from '../helpers/ts-runner.js';
import { verifyCodexAppProcessAttestation } from '../../src/utils/codex-app-process-attestation.js';

describe('Codex App namespace process proof', () => {
  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'verifies real nested PID namespace identities', async () => {
      const { command, args } = tsEvalArgs(`
        import { spawn } from 'node:child_process';
        import { readFileSync } from 'node:fs';
        const engine = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        const start = pid => { const raw = readFileSync('/proc/' + pid + '/stat', 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]; };
        console.log(JSON.stringify({ runnerPid: process.pid, runnerProcStart: start(process.pid), enginePid: engine.pid, engineProcStart: start(engine.pid) }));
        setInterval(() => {}, 1000);
      `);
      const child = spawn('/usr/bin/bwrap', ['--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', command, ...args]);
      const exited = once(child, 'exit');
      let stderr = ''; child.stderr.on('data', data => { stderr += data; });
      try {
        const raw = await Promise.race([
          once(child.stdout, 'data').then(([data]) => String(data)),
          exited.then(() => { throw new Error(`namespace probe exited: ${stderr}`); }),
        ]);
        const local = JSON.parse(raw);
        const proof = verifyCodexAppProcessAttestation(local, child.pid);
        expect(proof).toBeDefined();
        expect(proof!.runnerPid).not.toBe(local.runnerPid);
        expect(proof!.enginePid).not.toBe(local.enginePid);
        expect(proof!.engineProcStart).toBe(local.engineProcStart);
      } finally {
        child.kill('SIGKILL'); await exited;
      }
    },
  );
});
