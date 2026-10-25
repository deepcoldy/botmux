import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { remoteRunnerCommand } from '../src/adapters/backend/remote-runner-protocol.js';

it.each(['signal', 'eof'])('the built-in runner exits after %s shutdown', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'orca-process-'));
  const child = spawnTsScript(resolve('src/cli.ts'), ['__orca-runner', 'codex'], {
    env: { ...process.env, SESSION_DATA_DIR: root, BOTMUX_HOME: root, BOTMUX_NO_CLAIM: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; let errors = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { errors += chunk; });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    child.stdin!.write(JSON.stringify(remoteRunnerCommand('hello', {
      requestId: 'hello', sessionId: 'session', requiredCapabilities: [],
    })) + '\n');
    await expect.poll(() => output.includes('"provider":"orca"'), { timeout: 10_000 }).toBe(true);
    if (mode === 'signal') child.kill('SIGTERM');
    else child.stdin!.end();
    await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
    expect(errors).not.toContain('Unhandled');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited; rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
