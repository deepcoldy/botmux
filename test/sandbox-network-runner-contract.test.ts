import { describe, expect, it } from 'vitest';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawnTsScript, tsEvalArgs } from './helpers/ts-runner.js';

describe.skipIf(process.platform !== 'linux')('network runner kernel installation contract', () => {
  it.each([false, true])('executes the task only after successful rule installation (installed=%s)', async installed => {
    const task = tsEvalArgs('console.log("TASK_RAN")');
    const plan = {
      nft: installed ? '/bin/true' : '/bin/false', nftRules: 'fixture', ip: '/bin/true',
      command: task.command, args: task.args,
    };
    const encoded = Buffer.from(JSON.stringify(plan)).toString('base64');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string; ready: boolean }>((resolve, reject) => {
      const child = spawnTsScript(fileURLToPath(new URL('../src/sandbox-network-runner.ts', import.meta.url)), [encoded, '--inside'], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = ''; let ready = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('runner contract timed out')); }, 10000);
      child.stdout!.on('data', chunk => stdout += chunk); child.stderr!.on('data', chunk => stderr += chunk);
      child.stdio[3]!.on('data', () => { ready = true; (child.stdio[4] as Writable).write('R'); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ready }); });
    });
    if (installed) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.ready).toBe(true);
      expect(result.stdout).toContain('TASK_RAN');
    } else {
      expect(result.code).not.toBe(0);
      expect(result.ready).toBe(false);
      expect(result.stdout).not.toContain('TASK_RAN');
      expect(result.stderr).toContain('cannot install private nftables policy');
    }
  }, 15000);
});
