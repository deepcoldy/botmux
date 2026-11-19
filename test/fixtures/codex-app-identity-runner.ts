/** Signed states for live-engine violations and legitimate engine recovery. */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import {
  consumeCodexAppControlBootstrap,
  encodeCodexAppControlAuth,
  encodeCodexAppSignedControlMarker,
  parseCodexAppControlWireRecord,
  readCodexAppControlLocator,
} from '../../src/utils/codex-app-control.js';
import { readProcessStartIdentity } from '../../src/utils/process-identity.js';

const sessionId = process.argv[process.argv.indexOf('--session-id') + 1]!;
const bootstrap = consumeCodexAppControlBootstrap(process.env.BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP!, sessionId);
const endpoint = bootstrap.socketPath
  ?? readCodexAppControlLocator(bootstrap.locatorPath!, sessionId)?.endpoint;
if (!endpoint) throw new Error('missing test control endpoint');
const mode = process.env.FAKE_CODEX_IDENTITY_MODE;
const recovering = mode === 'restart' || mode === 'gap-restart';
const children: ChildProcess[] = [];
async function startEngine() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return { pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! };
}
process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); });
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
const proofs = [await startEngine()];
if (!recovering) proofs.push(await startEngine());
const report = (entry: unknown) => appendFileSync(process.env.FAKE_CODEX_IDENTITY_REPORT!, `${JSON.stringify(entry)}\n`);
report({ proofs });
const socket = createConnection(endpoint);
let challenge: string;
let buffer = '';
let nextSent = false;
const state = (seq: number, proof: typeof proofs[number] | null = proofs[0]!, acceptingInput = true) => {
  socket.write(`${encodeCodexAppSignedControlMarker(
    bootstrap.privateKey, sessionId, bootstrap.generation, challenge, seq, 'state', {
      busy: false, acceptingInput,
      ...(proof ? { appServerProcess: proof } : {}),
    },
  )}\n`);
};
async function publishReplacement(seq: number) {
  const replacement = await startEngine();
  report({ replacement });
  state(seq, replacement);
}
const fatal = (error: unknown) => { console.error(error); process.exit(1); };
socket.on('data', chunk => {
  buffer += chunk.toString();
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const record = parseCodexAppControlWireRecord(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (record?.type === 'challenge') {
      challenge = record.challenge;
      socket.write(`${encodeCodexAppControlAuth(bootstrap.privateKey, sessionId, bootstrap.generation, challenge)}\n`);
    } else if (record?.type === 'accepted') state(1);
    else if (record?.type === 'ack') {
      report({ ack: record.seq });
      if (record.seq === 2 && mode === 'gap-restart') void publishReplacement(3).catch(fatal);
    }
  }
});
socket.on('error', () => { /* the worker closes the rejected generation */ });
setInterval(() => {
  if (nextSent || !existsSync(process.env.FAKE_CODEX_IDENTITY_TRIGGER!)) return;
  nextSent = true;
  if (!recovering) {
    state(2, mode === 'dropped' ? null : proofs[mode === 'changed' ? 1 : 0]!);
    return;
  }
  void (async () => {
    const old = children[0]!;
    await new Promise<void>(resolve => {
      old.once('exit', () => resolve());
      old.kill('SIGTERM');
    });
    report({ oldExited: true });
    if (mode === 'gap-restart') state(2, null, false);
    else await publishReplacement(2);
  })().catch(fatal);
}, 20);
process.stdin.resume();
