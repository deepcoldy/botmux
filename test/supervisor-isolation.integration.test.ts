import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { probeSessionScopeCapabilities, userSystemdBusEnv } from '../src/core/session-scope.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { startIsolatedSupervisor } from '../src/core/supervisor-isolation.js';

async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for isolated supervisor');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function alive(pid: number): boolean {
  try { return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
  catch { return false; }
}

describe('real supervisor/session systemd isolation', () => {
  const supported = probeSessionScopeCapabilities().cleanupSupported;
  it.skipIf(!supported)('keeps a restart driver alive after its old supervisor exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-successor-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const helper = resolve('src/core/supervisor-isolation.ts');
    const parent = join(dir, 'parent.ts');
    const driver = join(dir, 'driver.ts');
    const payload = join(dir, 'payload.cjs');
    const ready = join(dir, 'parent.json');
    const next = join(dir, 'successor.json');
    const trigger = join(dir, 'exit');
    const runner = tsRunnerPrefix();
    const env = { ...process.env, ...userSystemdBusEnv() };
    const logFiles = { cwd: process.cwd(), stdout: join(dir, 'out.log'), stderr: join(dir, 'err.log') };
    writeFileSync(payload, 'setInterval(()=>{},1000);');
    writeFileSync(driver, `import fs from 'node:fs';\nimport { startIsolatedSupervisor, needsSupervisorIsolation } from ${JSON.stringify(helper)};\nwhile(!fs.existsSync(${JSON.stringify(trigger)}))await new Promise(r=>setTimeout(r,50));\nawait new Promise(r=>setTimeout(r,300));\nif(!needsSupervisorIsolation())throw Error('lost prior service ownership');\nconst pid=startIsolatedSupervisor({...${JSON.stringify(logFiles)},command:process.execPath,args:[${JSON.stringify(payload)}],env:process.env});\nfs.writeFileSync(${JSON.stringify(next)},JSON.stringify({pid,cgroup:fs.readFileSync('/proc/'+pid+'/cgroup','utf8')}));\n`);
    writeFileSync(parent, `import fs from 'node:fs';\nimport {spawn} from 'node:child_process';\nconst child=spawn(${JSON.stringify(runner.command)},${JSON.stringify([...runner.prefixArgs, driver])},{detached:true,stdio:'inherit',env:process.env});child.unref();\nfs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));\nsetInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)}))process.exit(0)},25);\n`);
    const units: string[] = [];
    try {
      const pid = startIsolatedSupervisor({ ...logFiles, command: runner.command, args: [...runner.prefixArgs, parent], env });
      await waitFor(() => existsSync(ready));
      const first = JSON.parse(readFileSync(ready, 'utf8'));
      units.push(first.cgroup.match(/botmux-supervisor-[^/\n]+\.service/)[0]);
      writeFileSync(trigger, 'exit');
      await waitFor(() => !alive(pid));
      await waitFor(() => existsSync(next));
      const successor = JSON.parse(readFileSync(next, 'utf8'));
      units.push(successor.cgroup.match(/botmux-supervisor-[^/\n]+\.service/)[0]);
      expect(units[0]).not.toBe(units[1]);
      expect(alive(successor.pid)).toBe(true);
      console.info('[restart verified] old supervisor exited; driver started an independent successor');
    } finally {
      for (const unit of units) {
        try { execFileSync('systemctl', ['--user', 'stop', unit], { env, stdio: 'ignore' }); } catch { /* collected */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(!supported).each(['detached-control', 'isolated-service'] as const)(
    '%s: closing the initiating session only kills session-owned processes', async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), 'fleet-scope-integration-'));
      const unit = `botmux-session-fleet-test-${process.pid}-${Date.now()}.scope`;
      const helper = resolve('src/core/supervisor-isolation.ts');
      const root = join(dir, 'root.ts');
      const payload = join(dir, 'payload.cjs');
      const record = join(dir, 'ready.json');
      const launched = join(dir, 'launched.json');
      const env = { ...process.env, ...userSystemdBusEnv(), FLEET_TEST_LITERAL: 'space $HOME %n\nline' };
      writeFileSync(payload, `const fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),args:process.argv.slice(2),value:process.env.FLEET_TEST_LITERAL}));\nsetInterval(()=>{},1000);\n`);
      const spec = { command: process.execPath, args: [payload, '$HOME', '%n', 'two words'], cwd: dir,
        stdout: join(dir, 'out.log'), stderr: join(dir, 'err.log') };
      writeFileSync(root, `import fs from 'node:fs';\nimport { spawn } from 'node:child_process';\nimport { startIsolatedSupervisor, needsSupervisorIsolation, preflightSupervisorIsolation } from ${JSON.stringify(helper)};\nconst spec={...${JSON.stringify(spec)},env:process.env};\nif(!needsSupervisorIsolation())throw Error('test caller is not in a session scope');\nlet pid;\nif(${JSON.stringify(mode)}==='isolated-service'){preflightSupervisorIsolation();pid=startIsolatedSupervisor(spec);}else{const p=spawn(spec.command,spec.args,{detached:true,stdio:'ignore',env:spec.env});p.unref();pid=p.pid;}\nfs.writeFileSync(${JSON.stringify(launched)},JSON.stringify({pid,root:process.pid}));\nsetInterval(()=>{},1000);\n`);
      const runner = tsRunnerPrefix();
      const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`,
        '--property=KillMode=control-group', '--', runner.command, ...runner.prefixArgs, root],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = '';
      child.stderr?.on('data', b => { errors += String(b); });
      let supervisorPid = 0;
      let supervisorUnit: string | undefined;
      try {
        try { await waitFor(() => existsSync(record) && existsSync(launched)); }
        catch (e) { throw new Error(`${String(e)}: ${errors}`); }
        const data = JSON.parse(readFileSync(record, 'utf8'));
        const launch = JSON.parse(readFileSync(launched, 'utf8'));
        supervisorPid = data.pid;
        supervisorUnit = data.cgroup.match(/botmux-supervisor-[^/\n]+\.service/)?.[0];
        expect(launch.pid).toBe(supervisorPid);
        expect(data.args).toEqual(['$HOME', '%n', 'two words']);
        expect(data.value).toBe(env.FLEET_TEST_LITERAL);
        expect(data.cgroup.includes(unit)).toBe(mode === 'detached-control');
        execFileSync('systemctl', ['--user', 'stop', unit], { env, stdio: 'ignore' });
        await waitFor(() => !alive(launch.root));
        if (mode === 'detached-control') await waitFor(() => !alive(supervisorPid));
        else {
          expect(supervisorUnit).toBeTruthy();
          expect(alive(supervisorPid)).toBe(true);
          console.info('[isolation verified] caller scope stopped; supervisor survives in its own service');
        }
      } finally {
        try { execFileSync('systemctl', ['--user', 'stop', unit], { env, stdio: 'ignore' }); } catch { /* collected */ }
        if (supervisorUnit) {
          try { execFileSync('systemctl', ['--user', 'stop', supervisorUnit], { env, stdio: 'ignore' }); } catch { /* exited */ }
        }
        if (supervisorPid && alive(supervisorPid)) process.kill(supervisorPid, 'SIGTERM');
        child.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000,
  );
});
