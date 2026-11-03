import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const channelCount = Number(process.argv[2] ?? 40);
const capabilityId = process.argv[3] ?? 'fixture.secret.v1';
const reader = fileURLToPath(new URL('./protected-secret-reader.mjs', import.meta.url));
const nodeExecutable = process.env.NODE_BINARY ?? 'node';
const pendingChannels = new Map();
process.on('message', (message, handle) => {
  if (message?.type !== 'protected_mcp_secret_channel_result') return;
  const pending = pendingChannels.get(message.requestId);
  if (!pending) {
    handle?.destroy?.();
    return;
  }
  pendingChannels.delete(message.requestId);
  if (message.ok && handle) pending.resolve(handle);
  else pending.reject(new Error(message.error ?? 'channel unavailable'));
});

const requestChannel = requestId => new Promise((resolve, reject) => {
  pendingChannels.set(requestId, { resolve, reject });
  process.send({
    type: 'protected_mcp_secret_channel_request',
    requestId,
    capabilityId,
  });
});

const channels = await Promise.all(Array.from(
  { length: channelCount },
  (_, index) => requestChannel(String(index)),
));
const children = channels.map((channel, index) => {
  const child = spawn(nodeExecutable, [reader, String(index)], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BOTMUX_PROTECTED_SECRET_FD: '3',
    },
    stdio: ['pipe', 'pipe', 'pipe', channel],
  });
  child.once('spawn', () => channel.destroy());
  child.once('error', () => channel.destroy());
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, closed: once(child, 'close'), stdout: () => stdout, stderr: () => stderr };
});

await Promise.all(children.map(async child => {
  while (!child.stdout().includes('READY\n')) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}));
for (const child of children) child.child.stdin.end('GO\n');

const results = await Promise.all(children.map(async child => {
  const timeout = setTimeout(() => child.child.kill('SIGKILL'), 3_000);
  timeout.unref();
  const [code, signal] = await child.closed;
  clearTimeout(timeout);
  const lines = child.stdout().trim().split('\n');
  const payload = lines.length > 1 ? lines.at(-1) : undefined;
  let result;
  try { result = payload ? JSON.parse(payload) : undefined; } catch { result = undefined; }
  return { code, signal, stderr: child.stderr(), result };
}));

process.stdout.write(`${JSON.stringify(results)}\n`);
process.disconnect?.();
