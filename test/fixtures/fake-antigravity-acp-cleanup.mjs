/** ACP peer with a same-group tool descendant that outlives SIGTERM and closes its stdio. */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const stateFile = process.argv[process.argv.indexOf('--state-file') + 1];
if (!stateFile) throw new Error('cleanup fixture requires --state-file');

if (process.argv.includes('--descendant')) {
  process.on('SIGTERM', () => {});
  // Announce only after the signal handler and liveness resource are installed.
  setInterval(() => {}, 1_000);
  process.stdout.end('descendant-ready\n');
} else {
  /** Keep native progress and the prompt terminal ordered after descendant readiness. */
  const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (request.method === 'session/new') {
      send({ id: request.id, result: { sessionId: 'cleanup-native-session' } });
    } else if (request.method === 'session/prompt') {
      const child = spawn(process.execPath, [
        fileURLToPath(import.meta.url), '--state-file', stateFile, '--descendant',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      const state = { nativePid: process.pid, descendantPid: child.pid, ready: false };
      writeFileSync(stateFile, JSON.stringify(state));
      child.stdout.once('data', () => {
        child.stdout.destroy();
        writeFileSync(stateFile, JSON.stringify({ ...state, ready: true }));
        if (process.env.AGY_CLEANUP_MODE === 'complete') {
          send({ method: 'session/update', params: { sessionId: 'cleanup-native-session',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cleanup answer' } } } });
          send({ id: request.id, result: { stopReason: 'end_turn' } });
        }
      });
    }
  });
}
