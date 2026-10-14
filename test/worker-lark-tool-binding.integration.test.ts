import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { fakeLarkHelpScript } from './helpers/lark-tool-help.js';
import { nodeTsRunnerPrefix, spawnNodeTsScript } from './helpers/ts-runner.js';
const headlessId = 'hl_11111111-1111-4111-8111-111111111111';
const headlessChat = `headless_${headlessId}`;

it('a real direct Trae worker pins managed tool PATH after the CLI launcher resets its environment', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worker-trae-tool-path-')));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const output = join(root, 'tool-result.json');
  const botBin = join(root, 'bot-bin'); mkdirSync(botBin);
  const node = realpathSync(nodeTsRunnerPrefix().command);
  const fakeCli = join(root, 'fake-trae');
  writeFileSync(join(botBin, 'lark-cli'), '#!' + node + '\n' + fakeLarkHelpScript()
    + 'process.stdout.write(process.env.LARKSUITE_CLI_APP_ID);\n', { mode: 0o755 });
  const fixture = [
    '#!' + node,
    'const fs = require("node:fs"), {spawnSync} = require("node:child_process");',
    'const explicit = {}; const prefix = "shell_environment_policy.set.";',
    'for (const a of process.argv.slice(2)) { if (a.startsWith(prefix)) {const i = a.indexOf("="); explicit[a.slice(prefix.length,i)] = JSON.parse(a.slice(i+1));}}',
    // Native tool runners may rebuild inherited PATH; explicit policy survives.
    'const env = {...process.env, PATH:"/usr/bin:/bin", ...explicit};',
    'const result = spawnSync("lark-cli", ["--version"], {env,encoding:"utf8"});',
    'fs.writeFileSync(' + JSON.stringify(output) + ',JSON.stringify({status:result.status,out:result.stdout,err:result.stderr,path:env.PATH}));',
    'process.stdout.write("Ready\\n");setInterval(()=>{},1000);',
  ].join('\n');
  writeFileSync(fakeCli, fixture, { mode: 0o755 });
  const env = { ...process.env, HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'),
    SESSION_DATA_DIR: dataDir, BOTMUX_NO_CLAIM: '1' };
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore','pipe','pipe','ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(done => child.once('exit', done));
  try {
    child.send!({ type:'init', sessionId:randomUUID(), chatId:headlessChat, rootMessageId:headlessChat,
      headless:{id:headlessId,source:'cli'}, workingDir:dataDir, cliId:'traex', cliPathOverride:fakeCli,
      backendType:'pty', prompt:'', larkAppId:'cli_current_app', larkAppSecret:'', sandbox:false,
      env:{PATH:botBin + ':' + process.env.PATH} });
    const deadline = Date.now()+25000;
    while (!existsSync(output) && child.exitCode === null && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    expect(existsSync(output),logs).toBe(true);
    const result = JSON.parse(readFileSync(output,'utf8'));
    expect(result.status,result.err).toBe(0);
    expect(result.out).toBe('cli_current_app');
    expect(result.path.split(':')[0]).toContain('cli-identity');
  } finally {
    if(child.connected) child.send!({type:'close'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    await exit;clearTimeout(timer);rmSync(root,{recursive:true,force:true});
  }
},35000);

it.each([
  { resume: false, daemonTool: true, headless: false },
  { resume: false, daemonTool: false, headless: false },
  { resume: true, daemonTool: true, headless: false },
  { resume: false, daemonTool: true, headless: true },
  { resume: false, daemonTool: false, headless: true },
  { resume: true, daemonTool: true, headless: true },
])('a real worker resolves the configured PATH (resume=$resume, daemonTool=$daemonTool, headless=$headless)', async ({ resume, daemonTool, headless }) => {
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
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({status:result.status,out:result.stdout,err:result.stderr,path:process.env.PATH,hasAppSecret:!!process.env.BOTMUX_LARK_APP_SECRET,hasUserToken:!!process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN}));
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
    child.send!({ type: 'init', sessionId: randomUUID(),
      chatId: headless ? headlessChat : 'oc_test',
      rootMessageId: headless ? headlessChat : 'om_root',
      headless: headless ? { id: headlessId, source: 'cli' } : undefined,
      resume,
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: headless ? '' : 'test-only-secret',
      env: { PATH: `${botBin}:${process.env.PATH}`, LARKSUITE_CLI_APP_ID: 'cli_wrong' } });
    const deadline = Date.now() + 25_000;
    while (!existsSync(output) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(output), logs).toBe(true);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    expect(result.status, result.err).toBe(0);
    expect(result.out).toBe(resume ? 'cli_wrong' : 'cli_current_app');
    expect(result.path.split(':')[0].includes('cli-identity')).toBe(!resume);
    if (headless) {
      expect(result.hasAppSecret).toBe(false);
      expect(result.hasUserToken).toBe(false);
    }
  } finally {
    if (child.connected) child.send!({ type: 'close' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
  }
}, 35_000);

it.each([false, true])('aligns a real worker system prompt with the managed bot-default lark identity (headless=%s)', async headless => {
  const root = mkdtempSync(join(tmpdir(), 'worker-lark-prompt-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const output = join(root, 'prompt-result.json');
  const fakeCli = join(root, 'fake-pi');
  const botBin = join(root, 'bot-bin'); mkdirSync(botBin);
  writeFileSync(join(botBin, 'lark-cli'), '#!/usr/bin/env node\n' + fakeLarkHelpScript(), { mode: 0o755 });
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({prompt:process.env.BOTMUX_APPEND_SYSTEM_PROMPT}));
process.stdout.write('Ready\\n');
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'),
    SESSION_DATA_DIR: dataDir, PATH: process.env.PATH, BOTMUX_NO_CLAIM: '1' };
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    child.send!({ type: 'init', sessionId: randomUUID(),
      chatId: headless ? headlessChat : 'oc_test',
      rootMessageId: headless ? headlessChat : 'om_root',
      headless: headless ? { id: headlessId, source: 'cli' } : undefined,
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: headless ? '' : 'test-only-secret', locale: 'zh',
      triggerUserAuth: { enabled: true, tools: ['lark-cli', 'bytedcli'], fallback: 'bot-identity' },
      env: { PATH: `${botBin}:${process.env.PATH}` } });
    const deadline = Date.now() + 25_000;
    while (!existsSync(output) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(output), logs).toBe(true);
    const { prompt } = JSON.parse(readFileSync(output, 'utf8'));
    expect(prompt).toContain('lark-cli 固定使用当前机器人的应用 cli_current_app');
    expect(prompt).toContain('默认以 bot 身份调用');
    expect(prompt).toContain('--as user');
    if (headless) {
      const larkPrompt = prompt.slice(prompt.indexOf('<botmux_lark_tool>'), prompt.indexOf('</botmux_lark_tool>'));
      expect(larkPrompt).toContain('没有真人授权通道');
      expect(larkPrompt).not.toContain('可用 --as user');
      expect(larkPrompt).not.toContain('botmux auth request');
    }
    expect(prompt).toContain('已为 bytedcli 启用按当前消息发起人身份注入授权');
    expect(prompt).not.toContain('已为 lark-cli / bytedcli 启用');
    expect(prompt).not.toContain('已为 lark-cli 启用按当前消息发起人身份注入授权');
  } finally {
    if (child.connected) child.send!({ type: 'close' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
  }
}, 35_000);

const canSandbox = process.platform === 'linux' && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/true',
], { stdio: 'ignore', timeout: 5000 }).status === 0;

it.skipIf(!canSandbox).each([
  { useAlias: false, headless: false }, { useAlias: true, headless: false },
  { useAlias: false, headless: true }, { useAlias: true, headless: true },
])('keeps application binding in a real sandbox (symlink data root=$useAlias, headless=$headless)', async ({ useAlias, headless }) => {
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
    // This fixture is self-contained: host preloads are intentionally outside
    // its sandbox grants and must not prevent the fake CLI from starting.
    NODE_OPTIONS: '',
    PATH: `${join(root, 'daemon-bin')}:${process.env.PATH}` };
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  child.on('message', (message: any) => {
    if (message.type === 'screen_update' || message.type === 'error') logs += JSON.stringify(message) + '\n';
  });
  const exit = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    child.send!({ type: 'init', sessionId: 'sandbox-binding',
      chatId: headless ? headlessChat : 'oc_test', rootMessageId: headless ? headlessChat : 'om_root',
      headless: headless ? { id: headlessId, source: 'cli' } : undefined,
      workingDir: join(root, 'work'), cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: headless ? '' : 'test-only-secret', sandbox: true,
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
