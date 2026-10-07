/**
 * Regression (PR #1513 reviews): Linux scratch must hide transport
 * credentials from inside the sandbox — bots.json (+sidecars), dashboard
 * secret, per-bot send-cred.json, webhook keys, per-person user tokens,
 * vc/bytedcli dirs, cli-identity, lark-cli keystores.
 *
 * SAFETY — this probe runs against FULLY ISOLATED temp homes only:
 *  - a temp HOME (passed as `homeDir` to the enumerator AND to
 *    prepareScratchSandbox), never the operator's real homedir();
 *  - a temp BOTMUX_HOME / BOTMUX_DATA_HOME / LARKSUITE_CLI_DATA_DIR;
 *  - every secret path it writes is UNDER those temp dirs;
 *  - it refuses (exit 1) to write any fixture path that already exists outside
 *    the freshly-created temp root (fail-closed: never clobber a real key).
 *
 * File denies are ro-bound to empty placeholders (content hidden), dir denies
 * return ENOENT. Assertions are on secret CONTENT, not errno.
 *
 * Linux + bwrap only.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

// ── Fully isolated roots ────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'botmux-scratch-cred-'));
const fakeHome = join(root, 'home');                 // passed as HOME / homeDir
const botmuxHome = join(fakeHome, '.botmux');        // $BOTMUX_HOME
const dataDir = join(botmuxHome, 'data');
const larkData = join(root, 'larkdata');            // $LARKSUITE_CLI_DATA_DIR
// Pin lark-cli resolution to the temp root for the WHOLE probe process — the
// enumerator resolves $LARKSUITE_CLI_DATA_DIR at call time, so the var must be
// set before enumeration (and kept out of the operator's real store).
process.env.LARKSUITE_CLI_DATA_DIR = larkData;
process.env.HOME = fakeHome;
const appId = 'app-cred-probe';
const cwd = mkdtempSync(join(tmpdir(), 'botmux-scratch-cred-cwd-'));
const sid = `probe-cred-${process.pid}-${Date.now()}`;

const writeSecret = (path, content) => {
  // Fail-closed: never overwrite a pre-existing path outside the fresh temp
  // root (this probe once clobbered the operator's real lark-cli master.key).
  if (existsSync(path) && !path.startsWith(root) && !path.startsWith(cwd)) {
    console.error(`REFUSING to clobber pre-existing path outside temp root: ${path}`);
    process.exit(2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
};

// Layout the fake authority home + lark keystore ENTIRELY under temp roots.
mkdirSync(join(botmuxHome, 'bots', appId), { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(larkData, 'lark-cli'), { recursive: true });
mkdirSync(join(dataDir, 'vc-meeting-daemon-auth'), { recursive: true });
mkdirSync(join(dataDir, 'bytedcli-home', 'ou-someone'), { recursive: true });
mkdirSync(join(dataDir, 'cli-identity', `${sid}.bin`, '.data'), { recursive: true });
mkdirSync(join(dataDir, 'cli-identity', 'session-OTHER.bin', '.data'), { recursive: true });

const OWN_ENV = join(dataDir, 'cli-identity', `${sid}.bin`, '.data', 'lark-cli.env');
const OTHER_ENV = join(dataDir, 'cli-identity', 'session-OTHER.bin', '.data', 'lark-cli.env');
const BOTS = join(botmuxHome, 'bots.json');
const SECRET = join(botmuxHome, '.dashboard-secret');
const SIDECAR = `${BOTS}.bak-1`;
const SEND_CRED = join(botmuxHome, 'bots', appId, 'send-cred.json');
const WEBHOOK = join(dataDir, 'webhook-master.key');
const LEGACY_LARK_STORE = join(fakeHome, '.lark-cli');
const REAL_LARK_STORE = join(larkData, 'lark-cli');
const USER_TOKEN = join(dataDir, `user-token-cli_x-${'ou'.repeat(8)}.json`);
const VC_TOKEN = join(dataDir, 'vc-meeting-daemon-auth', '57');
const BYTEDCLI_LOGIN = join(dataDir, 'bytedcli-home', 'ou-someone', 'login.json');

writeSecret(BOTS, JSON.stringify([{ larkAppId: appId, larkAppSecret: 'SECRET-appsecret-XYZ' }]));
writeSecret(SIDECAR, 'OLD-SECRET-sidecar');
writeSecret(SECRET, 'SECRET-dashboard-hmac-123');
writeSecret(SEND_CRED, JSON.stringify({ sendSecret: 'SECRET-sendcred-ABC' }));
writeSecret(WEBHOOK, 'SECRET-webhook-key');
writeSecret(USER_TOKEN, JSON.stringify({ access_token: 'SECRET-user-access-token' }));
writeSecret(VC_TOKEN, '57-SECRET-vcda');
writeSecret(BYTEDCLI_LOGIN, JSON.stringify({ openId: 'SECRET-bytedcli-login' }));
writeSecret(OWN_ENV, "TOKEN='SECRET-own-session-token'");
writeSecret(OTHER_ENV, "TOKEN='SECRET-other-person-token'");
// lark keystores (fake home — both the legacy ~/.lark-cli form and the real
// ~/.local/share form resolved from $LARKSUITE_CLI_DATA_DIR).
mkdirSync(LEGACY_LARK_STORE, { recursive: true });
writeSecret(join(LEGACY_LARK_STORE, '.cred-probe-marker'), 'SECRET-larkstore');
writeSecret(join(REAL_LARK_STORE, 'master.key'), 'SECRET-real-lark-master');

// Defensive: assert NONE of the keystore paths we just used are inside the
// operator's real ~/.local/share/lark-cli or ~/.lark-cli.
for (const p of [REAL_LARK_STORE, LEGACY_LARK_STORE]) {
  if (p.includes('/.local/share/lark-cli') && !p.startsWith(root)) {
    console.error('refusing: lark store path escapes temp root'); process.exit(2);
  }
}

try {
  const secretSet = enumerateScratchSecretPaths({
    botmuxHomes: [botmuxHome],
    dataDirs: [dataDir],
    botsConfigPath: BOTS,
    sessionId: sid,
    homeDir: fakeHome,
  });
  const denyPaths = secretSet.denyPaths;
  const roCarves = secretSet.readOnlyCarvePaths;
  check('enumerator found bots.json', denyPaths.includes(BOTS));
  check('enumerator found bots.json sidecar', denyPaths.includes(SIDECAR));
  check('enumerator found dashboard secret', denyPaths.includes(SECRET));
  check('enumerator found per-bot send-cred.json', denyPaths.includes(SEND_CRED));
  check('enumerator found webhook key', denyPaths.includes(WEBHOOK));
  check('enumerator found per-person user-token', denyPaths.includes(USER_TOKEN));
  check('enumerator found vc daemon auth dir', denyPaths.includes(join(dataDir, 'vc-meeting-daemon-auth')));
  check('enumerator found bytedcli-home dir', denyPaths.includes(join(dataDir, 'bytedcli-home')));
  check('enumerator sealed cli-identity dir', denyPaths.includes(join(dataDir, 'cli-identity')));
  check('enumerator carved OWN <sid>.bin dir read-only', roCarves.includes(join(dataDir, 'cli-identity', `${sid}.bin`)));
  check('enumerator did NOT carve other .bin dir', !roCarves.includes(join(dataDir, 'cli-identity', 'session-OTHER.bin')));
  check('enumerator found legacy ~/.lark-cli store', denyPaths.includes(LEGACY_LARK_STORE));
  check('enumerator found REAL lark-cli store (LARKSUITE_CLI_DATA_DIR)', denyPaths.includes(REAL_LARK_STORE));

  const sbx = prepareScratchSandbox({
    sessionId: sid,
    dataDir,
    storage: 'disk',
    chdir: cwd,
    home: fakeHome,
    cliBin: '/bin/sh',
    cliArgs: ['-c', 'true'],
    denyPaths,
    readOnlyCarvePaths: roCarves,
    env: {
      // Keep ALL lark-cli resolution pointed at the fake roots inside the
      // sandbox too, so nothing ever resolves to the operator's store.
      BOTMUX_HOME: botmuxHome,
      LARKSUITE_CLI_DATA_DIR: larkData,
    },
  });
  check('prepare ok', !!sbx);
  if (!sbx) process.exit(1);

  const dash = sbx.args.indexOf('--');
  const pre = sbx.args.slice(0, dash);
  const readInside = (path) => {
    const r = spawnSync(sbx.bin, [...pre, '/bin/sh', '-c', `cat ${JSON.stringify(path)} 2>/dev/null; echo RC=$?`],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, HOME: fakeHome } });
    return r.stdout;
  };

  const secretHidden = (path, marker) => !readInside(path).includes(marker);
  check('bots.json secret content hidden', secretHidden(BOTS, 'appsecret-XYZ'));
  check('bots.json sidecar hidden', secretHidden(SIDECAR, 'OLD-SECRET'));
  check('dashboard secret hidden', secretHidden(SECRET, 'dashboard-hmac'));
  check('per-bot send-cred.json hidden', secretHidden(SEND_CRED, 'sendcred-ABC'));
  check('webhook key hidden', secretHidden(WEBHOOK, 'webhook-key'));
  check('per-person user access token hidden', secretHidden(USER_TOKEN, 'user-access-token'));
  check('vc daemon auth token hidden', secretHidden(VC_TOKEN, 'SECRET-vcda'));
  check('bytedcli login hidden', secretHidden(BYTEDCLI_LOGIN, 'SECRET-bytedcli-login'));
  check('OTHER session trigger-user token hidden', secretHidden(OTHER_ENV, 'SECRET-other-person-token'));
  check('OWN session identity still readable (ro carve)', readInside(OWN_ENV).includes('SECRET-own-session-token'));
  check('REAL lark-cli master.key hidden', secretHidden(join(REAL_LARK_STORE, 'master.key'), 'real-lark-master'));
  check('legacy lark-cli store hidden', secretHidden(join(LEGACY_LARK_STORE, '.cred-probe-marker'), 'larkstore'));

  sbx.cleanup();
} finally {
  teardownScratchSession(sid, dataDir);
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILURE(S): ${failures.join('; ')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
