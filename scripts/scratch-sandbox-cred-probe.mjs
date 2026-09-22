/**
 * Regression (PR #1513 pi review P1-1): Linux scratch must hide transport
 * credentials from inside the sandbox — bots.json (+sidecars), dashboard
 * secret, per-bot send-cred.json, webhook keys, shared lark-cli keystore.
 *
 * File-shaped denies are ro-bound to a mode-000 empty placeholder (same
 * mechanism as oncall): reads SUCCEED but return EMPTY content, never the
 * secret. Dir denies return ENOENT/EPERM. Either way the secret bytes never
 * reach the child. This probe asserts on CONTENT, not on errno.
 *
 * Linux + bwrap only. Uses a temp fake botmux home; never touches real creds.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareScratchSandbox, teardownScratchSession } from '../dist/adapters/backend/scratch-sandbox.js';
import { enumerateScratchSecretPaths } from '../dist/adapters/backend/scratch-credentials.js';

if (process.platform !== 'linux') {
  console.log('skip: linux-only');
  process.exit(0);
}

const failures = [];
const check = (n, c, d = '') => {
  console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  if (!c) failures.push(n);
};

const root = mkdtempSync(join(tmpdir(), 'botmux-scratch-cred-'));
const botmuxHome = join(root, 'home');
const dataDir = join(botmuxHome, 'data');
const appId = 'app-cred-probe';
const cwd = mkdtempSync(join(tmpdir(), 'botmux-scratch-cred-cwd-'));
const sid = `probe-cred-${process.pid}-${Date.now()}`;

mkdirSync(join(botmuxHome, 'bots', appId), { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(homedir(), '.lark-cli'), { recursive: true });
mkdirSync(join(homedir(), '.local', 'share', 'lark-cli'), { recursive: true });
mkdirSync(join(dataDir, 'vc-meeting-daemon-auth'), { recursive: true });
mkdirSync(join(dataDir, 'bytedcli-home', 'ou-someone'), { recursive: true });
const BOTS = join(botmuxHome, 'bots.json');
const SECRET = join(botmuxHome, '.dashboard-secret');
const SIDECAR = `${BOTS}.bak-1`;
const SEND_CRED = join(botmuxHome, 'bots', appId, 'send-cred.json');
const WEBHOOK = join(dataDir, 'webhook-master.key');
const LARK_STORE = join(homedir(), '.lark-cli');
const LARK_STORE_REAL = join(homedir(), '.local', 'share', 'lark-cli');
const USER_TOKEN = join(dataDir, `user-token-cli_x-${'ou'.repeat(8)}.json`);
const VC_TOKEN = join(dataDir, 'vc-meeting-daemon-auth', '57');
const BYTEDCLI_LOGIN = join(dataDir, 'bytedcli-home', 'ou-someone', 'login.json');
writeFileSync(BOTS, JSON.stringify([{ larkAppId: appId, larkAppSecret: 'SECRET-appsecret-XYZ' }]));
writeFileSync(SIDECAR, 'OLD-SECRET-sidecar');
writeFileSync(SECRET, 'SECRET-dashboard-hmac-123');
writeFileSync(SEND_CRED, JSON.stringify({ sendSecret: 'SECRET-sendcred-ABC' }));
writeFileSync(WEBHOOK, 'SECRET-webhook-key');
writeFileSync(USER_TOKEN, JSON.stringify({ access_token: 'SECRET-user-access-token' }));
writeFileSync(VC_TOKEN, '57-SECRET-vcda');
writeFileSync(BYTEDCLI_LOGIN, JSON.stringify({ openId: 'SECRET-bytedcli-login' }));
writeFileSync(join(LARK_STORE_REAL, 'master.key'), 'SECRET-real-lark-master');
const larkMarker = join(LARK_STORE, '.cred-probe-marker');
let larkStoreProbeable = false;
try { writeFileSync(larkMarker, 'SECRET-larkstore'); larkStoreProbeable = true; } catch { /* TCC */ }

try {
  const denyPaths = enumerateScratchSecretPaths({
    botmuxHomes: [botmuxHome],
    dataDirs: [dataDir],
    botsConfigPath: BOTS,
  });
  check('enumerator found bots.json', denyPaths.includes(BOTS));
  check('enumerator found bots.json sidecar', denyPaths.includes(SIDECAR));
  check('enumerator found dashboard secret', denyPaths.includes(SECRET));
  check('enumerator found per-bot send-cred.json', denyPaths.includes(SEND_CRED));
  check('enumerator found webhook key', denyPaths.includes(WEBHOOK));
  check('enumerator found per-person user-token', denyPaths.includes(USER_TOKEN));
  check('enumerator found vc daemon auth dir', denyPaths.includes(join(dataDir, 'vc-meeting-daemon-auth')));
  check('enumerator found bytedcli-home dir', denyPaths.includes(join(dataDir, 'bytedcli-home')));
  check('enumerator found legacy ~/.lark-cli store', denyPaths.includes(LARK_STORE));
  check('enumerator found REAL ~/.local/share/lark-cli store', denyPaths.includes(LARK_STORE_REAL));

  const sbx = prepareScratchSandbox({
    sessionId: sid,
    dataDir,
    storage: 'disk',
    chdir: cwd,
    home: homedir(),
    cliBin: '/bin/sh',
    cliArgs: ['-c', 'true'],
    denyPaths,
  });
  check('prepare ok', !!sbx);
  if (!sbx) process.exit(1);

  const dash = sbx.args.indexOf('--');
  const pre = sbx.args.slice(0, dash);
  const readInside = (path) => {
    const r = spawnSync(sbx.bin, [...pre, '/bin/sh', '-c', `cat ${JSON.stringify(path)} 2>/dev/null; echo RC=$?`],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return r.stdout;
  };

  // Content-based assertion: the secret marker must never appear, regardless of
  // whether the file deny surfaces as empty content or ENOENT/EPERM.
  const secretHidden = (path, marker) => !readInside(path).includes(marker);
  check('bots.json secret content hidden', secretHidden(BOTS, 'appsecret-XYZ'), readInside(BOTS).trim().slice(0, 60));
  check('bots.json sidecar content hidden', secretHidden(SIDECAR, 'OLD-SECRET'));
  check('dashboard secret hidden', secretHidden(SECRET, 'dashboard-hmac'));
  check('per-bot send-cred.json hidden', secretHidden(SEND_CRED, 'sendcred-ABC'));
  check('webhook key hidden', secretHidden(WEBHOOK, 'webhook-key'));
  check('per-person user access token hidden', secretHidden(USER_TOKEN, 'user-access-token'));
  check('vc daemon auth token hidden (dir mask)', secretHidden(VC_TOKEN, 'SECRET-vcda'));
  check('bytedcli login hidden (dir mask)', secretHidden(BYTEDCLI_LOGIN, 'SECRET-bytedcli-login'));
  check('REAL lark-cli master.key hidden', secretHidden(join(LARK_STORE_REAL, 'master.key'), 'real-lark-master'));
  if (larkStoreProbeable) check('shared lark-cli store hidden', secretHidden(larkMarker, 'larkstore'));

  // Non-secret system file still readable (read-all posture intact).
  const etc = spawnSync(sbx.bin, [...pre, '/bin/sh', '-c', 'cat /etc/hostname'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  check('non-secret system file still readable', etc.status === 0 && etc.stdout.trim().length > 0);

  sbx.cleanup();
} finally {
  teardownScratchSession(sid, dataDir);
  try { rmSync(larkMarker, { force: true }); } catch { /* */ }
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILURE(S): ${failures.join('; ')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
