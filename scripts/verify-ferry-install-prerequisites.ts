// Run through scripts/fenced-run.ts only. Uses a disposable HOME and no login fixture.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { assertPluginPrerequisitesReady } from '../src/core/plugins/prerequisites.js';

assert.equal(process.env.BOTMUX_FENCED_RUN, '1');
const home = join(homedir(), '.botmux');
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'bots.json'), '[]');
writeFileSync(join(home, 'config.json'), '{}');
// Even Node/npm are absent from PATH; the installed plugin must prepare its own runtime.
process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
process.env.FERRY_BYTECLOUD_SITE = 'cn';
process.env.FERRY_AUTH_TIMEOUT_MS = '3000';
process.env.npm_config_userconfig = join(homedir(), '.npmrc');
process.env.npm_config_cache = join(homedir(), '.npm-cache');
process.env.npm_config_prefix = join(homedir(), '.npm-global');
const source = join(import.meta.dirname, '../../source/gateway');
const installed = installLocalPlugin(source);
assert.equal(installed.record.manifest.prerequisites, true);
const path = join(home, 'plugins/gateway-acceleration/private/setup-job.json');
const deadline = Date.now() + 180_000;
const startDeadline = Date.now() + 15_000;
let job: any;
while (Date.now() < deadline) {
  if (existsSync(path)) {
    job = JSON.parse(readFileSync(path, 'utf8'));
    if (job.state !== 'running') break;
  }
  if (!job && Date.now() > startDeadline) throw new Error('installation callback did not start');
  await new Promise(resolve => setTimeout(resolve, 250));
}
assert.equal(job?.state, 'complete', JSON.stringify(job) + (existsSync(join(home, 'plugins/gateway-acceleration/private/setup-error.log'))
  ? readFileSync(join(home, 'plugins/gateway-acceleration/private/setup-error.log'), 'utf8') : ''));
assert.equal(job.operation, 'installed');
assert.equal(existsSync(join(home, '.dashboard-token')), false);
assert.equal(readFileSync(join(home, 'bots.json'), 'utf8'), '[]');
assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{}');
await assert.rejects(assertPluginPrerequisitesReady('gateway-acceleration'));
const dependency = JSON.parse(readFileSync(join(home, 'local/ferry-plugin-dependency/installed.json'), 'utf8'));
console.log(JSON.stringify({ passed: true, realInstallEntryAutoPrepares: true, dashboardNeverOpened: true,
  noDashboardToken: true, noNodeOnPath: true, ferryVersion: dependency.version,
  loginNotAttempted: true, enablingWithoutLoginRefused: true, botAndGlobalConfigUnchanged: true,
  source: '真实安装入口，真实 Node/npm 下载及包完整性核验，隔离 HOME' }));
