import { execFileSync, spawn } from 'node:child_process';
import { readLarkToolBinding, parseLarkToolInvocation, larkToolChildEnv, larkToolPassthroughEnv, LARK_TOOL_ROUTE, larkToolPrompt } from './core/lark-tool-binding.js';
import { larkToolExecutionArgs } from './core/lark-tool-command.js';
import { loopbackFetch } from './core/loopback-fetch.js';
import { isHeadlessSessionChatId } from './core/types.js';
import { GRANT_ROUTE_CLIENT_TIMEOUT_MS } from './platform/credential-grant-budget.js';
import { findOnlineDaemon, parseDaemonIpcPort } from './utils/daemon-discovery.js';

const isLarkAppId = (value: string): boolean => /^cli_[A-Za-z0-9]{4,64}$/.test(value);

/** `（<name>）` of the user this machine's own lark-cli is logged in as, or nothing when it does not say. Run here, in the caller's own environment, like the call itself. */
function machineUserSuffix(realBinary: string): string {
  try {
    const out = execFileSync(realBinary, ['auth', 'status', '--json'], {
      env: larkToolPassthroughEnv(process.env), encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const status = JSON.parse(out) as { userName?: unknown; identities?: { user?: { userName?: unknown; name?: unknown } } };
    const value = status.userName ?? status.identities?.user?.userName ?? status.identities?.user?.name;
    const name = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64) : '';
    return name ? `（${name}）` : '';
  } catch { return ''; }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '__lark-tool-runner') argv.shift();
  if (argv[0] !== '--binding' || !argv[1] || argv[2] !== '--') throw new Error('Invalid managed lark-cli invocation');
  const binding = readLarkToolBinding(argv[1]);
  const invocation = parseLarkToolInvocation(argv.slice(3), binding, command => execFileSync(
    binding.realBinary, [...command, '--help'], {
      env: larkToolChildEnv(process.env, binding), encoding: 'utf8',
      timeout: 5_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    },
  ));
  const isPassthrough = Boolean(invocation.passthroughProfile);
  if (isPassthrough && !invocation.offline && process.env.BOTMUX_AS) {
    throw new Error('BOTMUX_AS cannot be used with --profile: that call runs with the profile\'s own login, not as a person of the turn');
  }
  let identity: { mode: 'bot' | 'user'; credential: string; appId?: string } | undefined;
  let native = false;
  if (!invocation.offline && !isPassthrough) {
    const port = parseDaemonIpcPort(findOnlineDaemon(binding.appId, binding.dataDir)?.ipcPort)
      ?? binding.ipcPort ?? Number(process.env.BOTMUX_DAEMON_IPC_PORT);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('The bound bot daemon is unavailable');
    const payload = JSON.stringify({ mode: invocation.mode, ...(invocation.mode === 'user' && process.env.BOTMUX_AS ? { as: process.env.BOTMUX_AS } : {}) });
    // `--as user` can run a platform credential grant inside this request.
    const response = await loopbackFetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(binding.sessionId)}/${LARK_TOOL_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: payload, signal: AbortSignal.timeout(GRANT_ROUTE_CLIENT_TIMEOUT_MS),
    });
    const raw = await response.text();
    const result = JSON.parse(raw) as { ok?: boolean; appId?: string; mode?: string; credentialType?: string; credential?: string; native?: boolean; error?: string; code?: string; issuer?: string };
    if (!response.ok || result.ok !== true) throw new Error(result.error ?? result.code ?? 'lark_tool_identity_unavailable');
    // The daemon says `native` when this bot leaves `--as user` to the machine's own lark-cli login.
    native = invocation.mode === 'user' && result.native === true;
    if (native) process.stderr.write(`botmux: --as user 使用本机 lark-cli 登录${machineUserSuffix(binding.realBinary)}\n`);
    if (!native) {
      const credentialType = invocation.mode === 'bot' ? 'tenant_access_token' : 'user_access_token';
      // A user grant issued by the botmux platform belongs to the platform's own
      // application; the daemon says so explicitly. Bot calls and every other user
      // grant stay pinned to the bound application.
      const platformUser = invocation.mode === 'user' && result.issuer === 'platform'
        && typeof result.appId === 'string' && isLarkAppId(result.appId);
      if ((platformUser ? false : result.appId !== binding.appId) || result.mode !== invocation.mode
        || result.credentialType !== credentialType || typeof result.credential !== 'string' || !result.credential) {
        throw new Error('The lark-cli identity does not match this invocation');
      }
      identity = { mode: invocation.mode, credential: result.credential, ...(platformUser ? { appId: result.appId } : {}) };
    }
  }
  if (invocation.showHelp) {
    process.stderr.write(`botmux: ${larkToolPrompt(binding.appId, process.env.LANG?.startsWith('zh') ? 'zh' : 'en', isHeadlessSessionChatId(process.env.BOTMUX_CHAT_ID ?? ''), binding.userNative === true)}\n`);
  }
  const args = larkToolExecutionArgs(invocation);
  const childEnv = isPassthrough || native
    ? larkToolPassthroughEnv(process.env)
    : larkToolChildEnv(process.env, binding, identity);
  const child = spawn(binding.realBinary, args, {
    env: childEnv, cwd: process.cwd(), stdio: 'inherit',
  });
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  const onTerm = () => forward('SIGTERM');
  const onInt = () => forward('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  await new Promise<void>(resolve => {
    child.once('error', () => { process.stderr.write('botmux: lark-cli is unavailable; the command was not executed.\n'); process.exitCode = 127; resolve(); });
    child.once('close', (code, signal) => {
      process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); resolve();
    });
  });
}

await main().catch(error => {
  process.stderr.write(`botmux: ${error instanceof Error ? error.message : 'lark_tool_identity_unavailable'}\n`);
  process.exitCode = 77;
});
