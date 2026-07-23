#!/usr/bin/env node
/**
 * sandbox-probe — verify the fs-policy file sandbox on THIS machine.
 *
 * Builds the SAME FsPolicy the worker would for a given bot, compiles it to a
 * real Seatbelt profile (macOS) — or bwrap argv (Linux) — and launches real
 * processes inside it, asserting the three access tiers actually hold at the
 * kernel level. No daemon / no Feishu round-trip required.
 *
 * Usage:
 *   pnpm build                       # dist must be current
 *   node scripts/sandbox-probe.mjs                 # auto-detect a bot
 *   node scripts/sandbox-probe.mjs --app cli_xxx   # a specific bot
 *   node scripts/sandbox-probe.mjs --tools         # also probe python/perl/etc.
 *
 * Exit code 0 = all expectations met, 1 = at least one mismatch.
 */
import { buildFsPolicy, compileToSeatbelt, compileToBwrap } from '../dist/adapters/cli/fs-policy.js';
import { realpathSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const wantTools = args.includes('--tools');
const appArg = (() => { const i = args.indexOf('--app'); return i >= 0 ? args[i + 1] : undefined; })();
const c = (p) => { try { return realpathSync(p); } catch { return p; } };
const home = c(homedir());

function detectApp() {
  if (appArg) return appArg;
  if (process.env.BOTMUX_LARK_APP_ID) return process.env.BOTMUX_LARK_APP_ID;
  try {
    const bots = readdirSync(join(home, '.botmux', 'bots')).filter((n) => /^cli_/.test(n));
    if (bots[0]) return bots[0];
  } catch { /* */ }
  return 'cli_probe'; // synthetic — sibling-isolation checks still meaningful
}
const APP = detectApp();
const botmuxHome = c(join(home, '.botmux'));
const sessionDataDir = c(join(botmuxHome, 'data'));
const botHome = join(botmuxHome, 'bots', APP);

// A throwaway project with the three tiers materialized. Canonicalize it: the
// worker canonicalizes every policy path (Seatbelt matches canonical paths), so
// the probe must too — else a deny/readOnly rule written with the /var/folders
// form won't match the canonical /private/var/folders access and the baseline's
// TMPDIR-root rw grant would wrongly win (this bit the probe's first draft).
const proj = c(mkdtempSync(join(tmpdir(), 'sbx-probe-')));
mkdirSync(join(proj, 'src'), { recursive: true });
mkdirSync(join(proj, 'secrets'), { recursive: true });
mkdirSync(join(proj, 'ref'), { recursive: true });
writeFileSync(join(proj, 'src', 'app.txt'), 'project source');
writeFileSync(join(proj, 'secrets', 'key.txt'), 'PROJECT SECRET');
writeFileSync(join(proj, 'ref', 'doc.md'), 'reference material');

// Executable dirs the worker would expose (claude/node/lark-cli + fnm farms).
const execCandidates = ['claude', 'node', 'lark-cli']
  .map((b) => { const r = spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }); return r.status === 0 ? c(r.stdout.trim()) : null; })
  .filter(Boolean);
const execDirs = [...new Set([process.execPath, ...execCandidates].map((p) => dirname(c(p))))];
const ccPkg = execCandidates.find((p) => p.includes('claude-code')) ? dirname(dirname(execCandidates.find((p) => p.includes('claude-code')))) : undefined;

// The botmux install/checkout root (this script lives at <checkout>/scripts/).
const botmuxInstallRoot = c(dirname(dirname(fileURLToPath(import.meta.url))));

const policy = buildFsPolicy({
  platform: process.platform === 'darwin' ? 'darwin' : 'linux',
  homeDir: home, botmuxHome, sessionDataDir,
  workingDir: c(proj), currentAppId: APP, botHome: c(botHome),
  redirectedCliData: true,
  execPaths: execDirs,
  readonlyRoots: ccPkg ? [ccPkg] : [],
  botmuxInstallRoot,
  extraWritePaths: process.env.TMPDIR ? [c(process.env.TMPDIR)] : [],
  userPaths: { readOnly: [join(proj, 'ref')], deny: [join(proj, 'secrets')] },
  net: true, writeRegexes: [],
});
policy.rules = policy.rules.filter((r) => r.access === 'deny' || existsSync(r.path));

if (process.platform !== 'darwin') {
  console.error('[sandbox-probe] Live Seatbelt probing is macOS-only. On Linux the daemon');
  console.error('  wraps the CLI in bwrap with the SAME policy; verify via a real bot session');
  console.error('  (set sandbox:true, message it, confirm it cannot read ~/.ssh). Policy rules:');
  console.error(compileToBwrap(policy, { emptiesDir: '/tmp', chdir: c(proj) }).args.join(' '));
  process.exit(0);
}

if (spawnSync('sh', ['-c', 'command -v sandbox-exec'], { stdio: 'ignore' }).status !== 0) {
  console.error('[sandbox-probe] sandbox-exec not found — cannot probe.');
  process.exit(1);
}
const profile = join(proj, 'profile.sb');
writeFileSync(profile, compileToSeatbelt(policy));

// A probe runs `argv` inside the sandbox with cwd = the project (as a real
// session does — the CLI launches chdir'd into workingDir).
function inside(argv) {
  return spawnSync('sandbox-exec', ['-f', profile, ...argv], { cwd: proj, env: { ...process.env, HOME: home }, encoding: 'utf8' });
}
let fails = 0;
function check(desc, want, argv, extraEnv) {
  const r = spawnSync('sandbox-exec', ['-f', profile, ...argv], { cwd: proj, env: { ...process.env, HOME: home, ...extraEnv }, encoding: 'utf8' });
  const got = r.status === 0 ? 'ALLOWED' : 'DENIED';
  const ok = got === want;
  if (!ok) fails++;
  console.log(`  ${ok ? '✓' : '✗ FAIL'}  [${got.padEnd(7)} want ${want.padEnd(7)}]  ${desc}`);
}

console.log(`\nsandbox-probe — bot=${APP}  project=${proj}  rules=${policy.rules.length}\n`);
console.log('三档权限:');
check('读 readWrite 项目文件', 'ALLOWED', ['/bin/cat', join(proj, 'src', 'app.txt')]);
check('写 readWrite 项目文件', 'ALLOWED', ['/usr/bin/touch', join(proj, 'src', 'new.txt')]);
check('读 deny 凿洞 (project/secrets)', 'DENIED', ['/bin/cat', join(proj, 'secrets', 'key.txt')]);
check('读 readOnly 参考目录', 'ALLOWED', ['/bin/cat', join(proj, 'ref', 'doc.md')]);
check('写 readOnly 参考目录', 'DENIED', ['/usr/bin/touch', join(proj, 'ref', 'hack')]);

console.log('\n密钥 / 跨-bot 隔离:');
check('读 ~/.ssh', 'DENIED', ['/bin/ls', join(home, '.ssh')]);
check('读 ~/.aws', 'DENIED', ['/bin/ls', join(home, '.aws')]);
check('读 ~/Library/Keychains', 'DENIED', ['/bin/ls', join(home, 'Library', 'Keychains')]);
check('读 lark-cli 密钥库根 (兄弟密文所在)', 'DENIED', ['/bin/ls', join(home, 'Library', 'Application Support', 'lark-cli')]);
const ownSecret = join(home, 'Library', 'Application Support', 'lark-cli', `appsecret_${APP}.enc`);
if (existsSync(ownSecret)) check('读 自己的 appsecret (carve-out)', 'ALLOWED', ['/bin/cat', ownSecret]);
const sibling = (() => { try { return readdirSync(join(home, 'Library', 'Application Support', 'lark-cli')).find((n) => /^appsecret_/.test(n) && !n.includes(APP)); } catch { return undefined; } })();
if (sibling) check('读 兄弟 bot 的 appsecret', 'DENIED', ['/bin/cat', join(home, 'Library', 'Application Support', 'lark-cli', sibling)]);

console.log('\n未覆盖路径 (deny-by-default):');
check('读未列出的敏感目录 ~/Documents', 'DENIED', ['/bin/ls', join(home, 'Documents')]);

console.log('\nbotmux CLI 运行时面 (allow-list，非 umbrella):');
// Install dir + the allow-listed ~/.botmux reads the CLI/hooks need.
check('读 botmux 安装目录 dist/cli.js', 'ALLOWED', ['/bin/cat', join(botmuxInstallRoot, 'dist', 'cli.js')]);
check('读 allow-list: data/dashboard-daemons (daemon 发现)', 'ALLOWED', ['/bin/ls', join(sessionDataDir, 'dashboard-daemons')]);
check('读 allow-list: data/bots-info.json', 'ALLOWED', ['/bin/cat', join(sessionDataDir, 'bots-info.json')]);
check('读 allow-list: .dashboard-port', 'ALLOWED', ['/bin/cat', join(botmuxHome, '.dashboard-port')]);
// codex 泄漏点回归守卫：这些含真凭证/跨-bot 内容，必须 DENIED
check('读 config.json (voice 凭证, codex#1)', 'DENIED', ['/bin/cat', join(botmuxHome, 'config.json')]);
check('读 .env (daemon 配置, codex#1)', 'DENIED', ['/bin/cat', join(botmuxHome, '.env')]);
check('读 data/webhook-master.key (AES 主密钥, codex#1)', 'DENIED', ['/bin/cat', join(sessionDataDir, 'webhook-master.key')]);
check('读写 data/schedules.json (RMW 定时任务, owner 接受泄漏)', 'ALLOWED', ['/bin/cat', join(sessionDataDir, 'schedules.json')]);
check('读 ~/.botmux/bots.json (敏感)', 'DENIED', ['/bin/cat', join(botmuxHome, 'bots.json')]);
check('读 ~/.botmux/logs (跨-bot)', 'DENIED', ['/bin/ls', join(botmuxHome, 'logs')]);
// End-to-end: actually run the botmux CLI inside the sandbox (loads cli.js + reads
// ~/.botmux). `botmux --help` exercises the load path without side effects.
const bmxCli = join(botmuxInstallRoot, 'dist', 'cli.js');
const nodeBin = execCandidates.find((p) => /\/node$/.test(p)) || process.execPath;
if (existsSync(bmxCli)) check('沙盒内跑 botmux CLI (node dist/cli.js --help)', 'ALLOWED', [nodeBin, bmxCli, '--help']);
// The claude SessionStart / AskUserQuestion hooks exec this same shape.
if (existsSync(bmxCli)) check('沙盒内跑 hook 形态 (node dist/cli.js session-ready --help)', 'ALLOWED', [nodeBin, bmxCli, 'session-ready', '--help']);
// Footer role-name fix: with the worker-injected BOTMUX_BRAND_LABEL, resolveBrandLabel
// must return it WITHOUT reading the (denied) bots.json → `botmux send` renders the
// role footer. Assert the env-first path resolves in-sandbox.
const registryJs = join(botmuxInstallRoot, 'dist', 'bot-registry.js');
if (existsSync(registryJs)) {
  check('沙盒内 resolveBrandLabel 从 env 拿到 brandLabel (不碰 bots.json)', 'ALLOWED',
    [nodeBin, '--input-type=module', '-e',
     `import{resolveBrandLabel as r}from ${JSON.stringify(registryJs)};process.exit(r(process.env.BOTMUX_LARK_APP_ID)==='[probe-role](u)'?0:1)`],
    { BOTMUX_LARK_APP_ID: APP, BOTMUX_BRAND_LABEL: '[probe-role](u)' });
}

if (wantTools) {
  console.log('\n工具链 (需 --tools):');
  check('python3 运行', 'ALLOWED', ['/usr/bin/python3', '-c', 'print(1+1)']);
  check('perl 运行', 'ALLOWED', ['/usr/bin/perl', '-e', 'print "ok"']);
  check('bash 运行', 'ALLOWED', ['/bin/bash', '-c', 'echo ok']);
  const claude = execCandidates.find((p) => p.includes('claude'));
  if (claude) check('claude --version', 'ALLOWED', ['env', `CLAUDE_CONFIG_DIR=${join(botHome, 'claude')}`, claude, '--version']);
}

rmSync(proj, { recursive: true, force: true });
console.log(`\n${fails === 0 ? '✓ 全部符合预期' : `✗ ${fails} 项不符预期`}\n`);
process.exit(fails === 0 ? 0 : 1);
