import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { fakeLarkHelpScript } from './helpers/lark-tool-help.js';
import { nodeTsRunnerPrefix, spawnNodeTsScript } from './helpers/ts-runner.js';

it.each([
  { resume: false, daemonTool: true }, { resume: false, daemonTool: false }, { resume: true, daemonTool: true },
])('a real worker resolves the configured PATH (resume=$resume, daemonTool=$daemonTool)', async ({ resume, daemonTool }) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-lark-binding-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const output = join(root, 'tool-result.json');
  const fakeCli = join(root, 'fake-pi');
  const botBin = join(root, 'bot-bin'); mkdirSync(botBin);
  const fakeLark = join(botBin, 'lark-cli');
  if (daemonTool) writeFileSync(join(root, 'lark-cli'), '#!/usr/bin/env node\n' + fakeLarkHelpScript() + 'process.stdout.write("WRONG_DAEMON_TOOL");\n', { mode: 0o755 });
  writeFileSync(fakeLark, '#!/usr/bin/env node\n' + fakeLarkHelpScript() + 'process.stdout.write(process.env.LARKSUITE_CLI_APP_ID);\n', { mode: 0o755 });
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const result = spawnSync('lark-cli', ['--version'], {encoding:'utf8'});
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({status:result.status,out:result.stdout,err:result.stderr,path:process.env.PATH}));
process.stdout.write('Ready\\n');
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'),
    SESSION_DATA_DIR: dataDir,
    PATH: `${root}:${(process.env.PATH ?? '').split(':').filter(p => daemonTool || !existsSync(join(p, 'lark-cli'))).join(':')}`,
    BOTMUX_NO_CLAIM: '1' };
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(resolve => child.once('exit', resolve));
  try {
    child.send!({ type: 'init', sessionId: randomUUID(), chatId: 'oc_test', rootMessageId: 'om_root',
      resume,
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: 'test-only-secret',
      env: { PATH: `${botBin}:${process.env.PATH}`, LARKSUITE_CLI_APP_ID: 'cli_wrong' } });
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

const canSandbox = process.platform === 'linux' && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/true',
], { stdio: 'ignore', timeout: 5000 }).status === 0;

it.skipIf(!canSandbox).each([false, true])('keeps application binding in a real sandbox (symlink data root=%s)', async useAlias => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worker-lark-sandbox-')));
  const node = realpathSync(nodeTsRunnerPrefix().command);
  for (const path of ['real/data', 'work', 'home', 'daemon-bin', 'bot-bin']) mkdirSync(join(root, path), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'alias'));
  const dataDir = join(root, useAlias ? 'alias' : 'real', 'data');
  const output = join(root, 'work/result.json');
  const fakeCli = join(root, 'daemon-bin/pi');
  for (const name of ['daemon-bin', 'bot-bin']) {
    writeFileSync(join(root, name, 'lark-cli'), `#!${node}\n` + fakeLarkHelpScript()
      + `process.stdout.write(${JSON.stringify(name)}+'|'+process.env.LARKSUITE_CLI_APP_ID);\n`, { mode: 0o755 });
  }
  writeFileSync(fakeCli, `#!${node}
const fs = require('node:fs'), {spawnSync} = require('node:child_process');
const run = (bin, args) => { const r = spawnSync(bin, args, {encoding:'utf8'}); return {status:r.status,out:r.stdout,err:r.stderr}; };
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  direct: run('lark-cli', ['--version']),
  sh: run('/bin/sh', ['-c', 'lark-cli --version']),
  bash: run('/bin/bash', ['-c', 'lark-cli --version']),
  path: process.env.PATH, binding: process.env.BOTMUX_LARK_TOOL_BINDING,
}));
process.stdout.write('Ready\\n'); setInterval(()=>{},1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    BOTMUX_HOME: join(root, 'home/.botmux'), SESSION_DATA_DIR: dataDir, BOTMUX_NO_CLAIM: '1',
    PATH: `${join(root, 'daemon-bin')}:${process.env.PATH}` };
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    child.send!({ type: 'init', sessionId: 'sandbox-binding', chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: join(root, 'work'), cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: 'test-only-secret', sandbox: true,
      sandboxPaths: { readOnly: [join(root, 'bot-bin')] },
      env: { PATH: `${join(root, 'bot-bin')}:${process.env.PATH}`, LARKSUITE_CLI_APP_ID: 'cli_wrong' } });
    const deadline = Date.now() + 25_000;
    while (!existsSync(output) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(output), logs).toBe(true);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    for (const mode of ['direct', 'sh', 'bash']) {
      expect(result[mode], `${mode}: ${logs}`).toEqual({ status: 0, out: 'bot-bin|cli_current_app', err: '' });
    }
    expect(result.path.split(':')[0]).toBe('/run/sbxbin');
    expect(result.binding).toBe(join(root, 'real/data/cli-identity/sandbox-binding.bin/.data/lark-tool-binding.json'));
  } finally {
    if (child.connected) child.send!({ type: 'close' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
  }
}, 35_000);
