import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

it.each([false, true])('a real worker binds only a new session (old session=%s)', async resume => {
  const root = mkdtempSync(join(tmpdir(), 'worker-lark-binding-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const output = join(root, 'tool-result.json');
  const fakeCli = join(root, 'fake-pi');
  const fakeLark = join(root, 'lark-cli');
  writeFileSync(fakeLark, '#!/bin/sh\nprintf "%s" "$LARKSUITE_CLI_APP_ID"\n', { mode: 0o755 });
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const result = spawnSync('lark-cli', ['--help'], {encoding:'utf8'});
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({status:result.status,out:result.stdout,err:result.stderr,path:process.env.PATH}));
process.stdout.write('Ready\\n');
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'),
    SESSION_DATA_DIR: dataDir, PATH: `${root}:${process.env.PATH}`, BOTMUX_NO_CLAIM: '1' };
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(resolve => child.once('exit', resolve));
  try {
    child.send!({ type: 'init', sessionId: randomUUID(), chatId: 'oc_test', rootMessageId: 'om_root',
      resume,
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: 'test-only-secret',
      env: { PATH: `${root}:${process.env.PATH}`, LARKSUITE_CLI_APP_ID: 'cli_wrong' } });
    const deadline = Date.now() + 25_000;
    while (!existsSync(output) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(output), logs).toBe(true);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    expect(result.status, result.err).toBe(0);
    expect(result.out).toBe(resume ? 'cli_wrong' : 'cli_current_app');
    expect(result.path.split(':')[0].includes('cli-identity')).toBe(!resume);
  } finally {
    if (child.connected) child.send!({ type: 'close' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
  }
}, 35_000);
