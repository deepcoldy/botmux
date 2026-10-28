/** ECOP is a ByteCloud companion: use the existing bytedcli turn record.
 * This is standalone Node source, not a serialized function/closure: compiled
 * Bun builds must emit exactly the same external wrapper as source builds. */
const ECOP_WRAPPER_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const real = process.argv[1];
const options = JSON.parse(process.argv[2]);
const args = process.argv.slice(3);
const deny = (message) => {
  process.stderr.write('botmux: ecop ' + message + '\n');
  process.exit(77);
};
const safe = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
// No shell evaluation: accept only assignments emitted by renderIdentityEnv.
function parseIdentity(text) {
  const result = Object.create(null);
  const expression = /^([A-Z_]+)=('(?:[^']|'\\'')*')$/gm;
  for (const match of text.matchAll(expression)) {
    const raw = match[2];
    const value = raw.slice(1, -1).replaceAll("'\\''", "'");
    if ("'" + value.replaceAll("'", "'\\''") + "'" !== raw) deny('身份记录格式错误，命令未执行。');
    if (Object.hasOwn(result, match[1])) deny('身份记录有重复字段，命令未执行。');
    result[match[1]] = value;
  }
  return result;
}
// Managed execution never lets argv select another credential or impersonate.
for (const arg of args) {
  if (/^--(?:user-cloud-jwt|fake-user)(?:=|$)/.test(arg)
      || arg === 'fake-user'
      || arg === '--begin' || /^--complete(?:=|$)/.test(arg)
      || (arg === 'begin' && args.includes('login'))) {
    deny('受管模式不允许覆盖用户身份、附身或另行发起 SSO；请使用当前触发人的平台授权。');
  }
}
const session = process.env.BOTMUX_SESSION_ID;
const dataDir = process.env.SESSION_DATA_DIR;
if (!safe(session) || !dataDir || !path.isAbsolute(dataDir)) deny('缺少可信会话，命令未执行。');
const identityDir = path.join(dataDir, 'cli-identity', session + '.bin', '.data');
const identityPath = path.join(identityDir, 'bytedcli.env');
const turnPath = path.join(identityDir, 'turn');
let raw, live, identity;
try {
  if (options.model === 'proven') {
    // Request the existing bytedcli identity from the trusted process-proof
    // runner. Never consult a legacy file after a failed proof.
    const resolver = options.identityResolver;
    const response = spawnSync(resolver[0], [...resolver.slice(1), 'bytedcli'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 65536,
    });
    if (response.status !== 0 || !response.stdout) deny('无法验证本轮执行身份，命令未执行。');
    raw = response.stdout;
  } else {
    const stat = fs.lstatSync(identityPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) deny('身份记录权限错误，命令未执行。');
    raw = fs.readFileSync(identityPath, 'utf8');
    live = fs.readFileSync(turnPath, 'utf8');
  }
  identity = parseIdentity(raw);
} catch { deny('本轮没有可用凭证，请完成 ByteCloud 授权后重试。'); }
if (identity.BOTMUX_IDENTITY_MODE !== 'user') {
  deny(identity.BOTMUX_IDENTITY_DENY_MSG || '本轮没有可用凭证，请完成 ByteCloud 授权后重试。');
}
const [turn, caller] = options.model === 'proven'
  ? [identity.BOTMUX_IDENTITY_TURN, identity.BOTMUX_IDENTITY_OPEN_ID]
  : live.split('\n');
if (!turn || !safe(caller) || !identity.BOTMUX_IDENTITY_TURN
    || identity.BOTMUX_IDENTITY_TURN !== turn || identity.BOTMUX_IDENTITY_OPEN_ID !== caller) {
  deny('凭证与当前回合或发送人不一致，命令未执行；请由本轮发起人重试。');
}
const jwt = (identity.BYTEDCLI_USER_CLOUD_JWT || '').trim();
let claims;
try {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
  claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
} catch { deny('本轮 ByteCloud JWT 缺失或无效，命令未执行。'); }
if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() + 30000) {
  deny('本轮 ByteCloud JWT 已过期，请由发起人发送新消息后重试。');
}
// Token authenticity comes from the daemon-owned record; decoding only checks
// expiry. Never select a principal from CLI arguments or JWT display fields.
const selectors = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--boe') selectors.push('--boe');
  else if (/^--(?:profile|base-url)=/.test(args[i])) selectors.push(args[i]);
  else if (args[i] === '--profile' || args[i] === '--base-url') selectors.push(args[i] + '=' + (args[++i] || ''));
}
const environment = crypto.createHash('sha256').update(JSON.stringify(selectors)).digest('hex').slice(0, 20);
const cache = path.join(dataDir, 'ecop-runtime', session, caller, environment);
process.umask(0o077);
try {
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  // Capture one consistent published generation immediately before execution.
  if (options.model === 'single' && (fs.readFileSync(identityPath, 'utf8') !== raw || fs.readFileSync(turnPath, 'utf8') !== live)) {
    deny('身份在启动前已切换，命令未执行；请重试。');
  }
} catch { deny('无法准备本轮隔离目录或读取身份，命令未执行。'); }
const env = { ...process.env };
for (const key of ['USER_CLOUD_JWT', 'BYTEDCLI_USER_CLOUD_JWT', 'BYTEDCLI_USER_CODE_JWT',
  'AIME_USER_CLOUD_JWT', 'AIME_USER_CODE_JWT', 'CODEBASE_CLI_USER_JWT',
  'ECOP_CLI_DATA_DIR', 'BOTMUX_IDENTITY_MODE', 'BOTMUX_IDENTITY_DENY_MSG',
  'BOTMUX_IDENTITY_TURN', 'BOTMUX_IDENTITY_OPEN_ID', 'BOTMUX_IDENTITY_HOME']) delete env[key];
env.USER_CLOUD_JWT = jwt;
env.ECOP_CLI_DATA_DIR = cache;
const child = spawn(real, args, { cwd: process.cwd(), env, stdio: 'inherit' });
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const handlers = new Map(signals.map(signal => [signal, () => child.kill(signal)]));
for (const [signal, handler] of handlers) process.on(signal, handler);
child.on('error', () => {
  process.stderr.write('botmux: ecop 真实 CLI 启动失败。\n');
  process.exitCode = 126;
});
child.on('close', (code, signal) => {
  for (const [name, handler] of handlers) process.removeListener(name, handler);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code === null ? 126 : code;
});
`;

export function renderEcopIdentityWrapper(
  realBinaryPath: string,
  model: 'single' | 'proven',
  identityResolver: readonly string[] | undefined,
  wrapperMarker: string,
): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  if (realBinaryPath.includes('\0') || realBinaryPath.includes('\n')) throw new Error('Invalid ecop binary path');
  if (model !== 'single' && model !== 'proven') throw new Error('Invalid ecop identity model');
  if (model === 'proven' && !identityResolver?.length) throw new Error('ECOP requires an execution identity resolver');
  const options = JSON.stringify({ model, identityResolver });
  return `#!/bin/sh\n${wrapperMarker}\nexec node --input-type=commonjs -e ${quote(ECOP_WRAPPER_SOURCE)} ${quote(realBinaryPath)} ${quote(options)} "$@"\n`;
}
