import { watch } from 'node:fs';
import { createServer } from 'node:http';

// Only this test-owned worker, socket and watcher are destroyed. Readiness is
// published after EVERY resource and the close handler has been installed.
const watcher = watch(process.argv[2], () => {});
const timer = setInterval(() => {}, 60_000);
const server = createServer((_req, res) => res.end('isolated-workspace-worker'));
process.on('message', message => {
  if ((message as { type?: string })?.type !== 'close') return;
  watcher.close(); clearInterval(timer);
  server.close(() => process.exit(0));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker_port_missing');
  process.send?.({ type: 'fixture_ready', pid: process.pid, port: address.port });
});
