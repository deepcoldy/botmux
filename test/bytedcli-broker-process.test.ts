import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bytedcliMinimalEnv, discoverBytedcliTrustedCli, runBoundedBytedcliChild } from '../src/core/bytedcli-broker-process.js';
import { tsEvalArgs, resolveNodeExecutable } from './helpers/ts-runner.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function setup() { const root = mkdtempSync(join(tmpdir(), 'broker-process-')); roots.push(root); return root; }
function invoke(root: string, source: string, extra: Record<string, any> = {}) {
  const evalArgs = tsEvalArgs(source);
  return runBoundedBytedcliChild({ executable: evalArgs.command, argv: evalArgs.args, cwd: root,
    env: bytedcliMinimalEnv(root, root, `${dirname(process.execPath)}:/usr/bin:/bin`),
    signal: new AbortController().signal, timeoutMs: 2000, outputLimitBytes: 1024, ...extra });
}
describe('private bounded CLI processes', () => {
  it('executes with the fixed HOME and cwd and denies inherited Node injection', async () => {
    const root = setup(); const result = await invoke(root, 'console.log(JSON.stringify({home:process.env.HOME,cwd:process.cwd(),injected:process.env.NODE_OPTIONS}))');
    expect(JSON.parse(result.stdout.toString())).toEqual({ home: root, cwd: root });
  });
  it('kills a process and its delayed descendant on timeout', async () => {
    const root = setup(); const marker = join(root, 'descendant-marker');
    const source = `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),500)`)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
    await expect(invoke(root, source, { timeoutMs: 150 })).rejects.toMatchObject({ code: 'timeout' });
    await new Promise(resolve => setTimeout(resolve, 550)); expect(() => readFileSync(marker)).toThrow();
  });
  it('enforces a combined output cap while the child is still running', async () => {
    const root = setup(); await expect(invoke(root, 'process.stdout.write("x".repeat(800));process.stderr.write("y".repeat(800));setInterval(()=>{},1000)'))
      .rejects.toMatchObject({ code: 'output_limit' });
  });
  it('kills a running child when the request is cancelled', async () => {
    const root = setup(); const controller = new AbortController();
    const running = invoke(root, 'setInterval(()=>{},1000)', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50); await expect(running).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('pins an explicit runtime and source entry instead of trusting a shebang Node shim', async () => {
    const root = setup(); const entry = join(root, 'bytedcli.mjs'); writeFileSync(entry, 'console.log("0.199.0")'); chmodSync(entry, 0o700);
    const home = join(root, 'home'); const cwd = join(root, 'cwd'); mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
    const node = realpathSync(resolveNodeExecutable()!);
    const cli = await discoverBytedcliTrustedCli({ candidates: [entry], installationRoots: [root], runtimeExecutable: node,
      path: '/usr/bin:/bin', probeHome: home, probeCwd: cwd, signal: new AbortController().signal });
    expect(cli.executable).toBe(node); expect(cli.prefixArgs).toEqual([entry]);
    expect(cli.path.split(':')[0]).toBe(dirname(node)); expect(cli.stillCurrent()).toBe(true);
    writeFileSync(entry, 'console.log("0.200.0")'); expect(cli.stillCurrent()).toBe(false);
  });
});
