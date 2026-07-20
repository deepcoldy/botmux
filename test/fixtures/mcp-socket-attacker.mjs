import { readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const socketRoot = process.argv[2];
if (!socketRoot) throw new Error('socket root is required');

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'same-uid-attacker', version: '1.0.0' },
  },
});

function probe(socketPath) {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let output = '';
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(accepted);
    };

    socket.setTimeout(3_000, () => finish(false));
    socket.once('connect', () => socket.write(`${initialize}\n`));
    socket.on('data', chunk => {
      output += chunk.toString('utf8');
      const accepted = output.split(/\r?\n/).some(line => {
        try {
          const message = JSON.parse(line);
          return message?.jsonrpc === '2.0' && message?.id === 1 && message?.result;
        } catch {
          return false;
        }
      });
      if (accepted) finish(true);
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

const candidates = readdirSync(socketRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^bmcp-\d+-/.test(entry.name))
  .map(entry => join(socketRoot, entry.name, 'g.sock'));
const accepted = (await Promise.all(candidates.map(probe))).filter(Boolean).length;
process.stdout.write(`${JSON.stringify({ scanned: candidates.length, accepted })}\n`);
if (accepted > 0) process.exitCode = 1;
