// The compiled __daemon entry leaves module evaluation pending in cli.ts.
// Bun (1.4.3 and 1.4.4 alike) then prints uncaught WS errors and continues by default.
import { createServer } from 'node:net';
import { type AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { installDaemonFatalErrorGuard } from '../../src/utils/daemon-fatal-error.js';

installDaemonFatalErrorGuard();
const gateway = createServer(peer => {
  peer.once('data', () => {
    // Exercise the original Bun error path independently of our socket fix.
    socket.removeAllListeners();
    socket.terminate();
  });
});
let socket: WebSocket;
gateway.listen(0, '127.0.0.1', () => {
  socket = new WebSocket(`ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`);
  socket.on('error', () => {});
});
setTimeout(() => process.exit(42), 2_000); // An unguarded parked process reaches this.
await new Promise<never>(() => {});
