import { spawn } from 'node:child_process';
import { readLarkToolBinding, parseLarkToolInvocation, larkToolChildEnv, LARK_TOOL_ROUTE, larkToolPrompt } from './core/lark-tool-binding.js';
import { loopbackFetch } from './core/loopback-fetch.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '__lark-tool-runner') argv.shift();
  if (argv[0] !== '--binding' || !argv[1] || argv[2] !== '--') throw new Error('Invalid managed lark-cli invocation');
  const binding = readLarkToolBinding(argv[1]);
  const invocation = parseLarkToolInvocation(argv.slice(3), binding);
  let identity: { mode: 'bot' | 'user'; credential: string } | undefined;
  if (!invocation.offline) {
    const port = binding.ipcPort ?? Number(process.env.BOTMUX_DAEMON_IPC_PORT);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('The bound bot daemon is unavailable');
    const payload = JSON.stringify({ mode: invocation.mode });
    const response = await loopbackFetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(binding.sessionId)}/${LARK_TOOL_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: payload, signal: AbortSignal.timeout(15_000),
    });
    const raw = await response.text();
    const result = JSON.parse(raw) as { ok?: boolean; appId?: string; mode?: string; credential?: string; error?: string };
    if (!response.ok || result.ok !== true) throw new Error(result.error ?? 'lark_tool_identity_unavailable');
    if (result.appId !== binding.appId || result.mode !== invocation.mode || !result.credential) {
      throw new Error('The lark-cli identity does not match this invocation');
    }
    identity = { mode: invocation.mode, credential: result.credential };
  }
  if (invocation.args.includes('--help') || invocation.args.includes('-h')) {
    process.stderr.write(`botmux: ${larkToolPrompt(binding.appId, process.env.LANG?.startsWith('zh') ? 'zh' : 'en')}\n`);
  }
  const args = [...invocation.args];
  // Place mode before `--`, which terminates flags. Management reads such as
  // auth status use env identity and do not expose an --as flag.
  if (!invocation.offline && args[0] !== 'auth') {
    const literal = args.indexOf('--');
    args.splice(literal < 0 ? args.length : literal, 0, '--as', invocation.mode);
  }
  const child = spawn(binding.realBinary, args, {
    env: larkToolChildEnv(process.env, binding, identity), cwd: process.cwd(), stdio: 'inherit',
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
