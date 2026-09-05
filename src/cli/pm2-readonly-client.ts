#!/usr/bin/env node
/**
 * Side-effect-free PM2 observer.
 *
 * PM2's public `connect`/CLI path daemonizes when the RPC socket disappears.
 * This helper deliberately calls pingDaemon + launchRPC directly and never
 * calls Client.start/connect, so a status/logs race cannot create a new God in
 * the observer's cgroup.
 */
import { createRequire } from 'node:module';
import {
  inspectLinuxPm2GodOwnership,
  revalidateLinuxPm2GodProcess,
  type LinuxPm2GodProcess,
} from '../core/pm2-lifecycle-owner.js';

const require = createRequire(import.meta.url);
const pm2 = require('pm2') as any;
const mode = process.argv[2];
const target = process.argv[3] || 'all';
const lines = Number.parseInt(process.argv[4] || '50', 10);
const CONNECT_TIMEOUT_MS = 5_000;
const ABSENT_EXIT_CODE = 3;
let expectedGod: LinuxPm2GodProcess | undefined;
try {
  expectedGod = process.env.BOTMUX_PM2_EXPECTED_GOD
    ? JSON.parse(process.env.BOTMUX_PM2_EXPECTED_GOD) as LinuxPm2GodProcess
    : undefined;
} catch (error) {
  fail(`invalid PM2 read-only generation binding: ${error instanceof Error ? error.message : String(error)}`);
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function disableAxonReconnect(socket: any, label: string): void {
  if (!socket?.set) fail(`PM2 read-only ${label} socket cannot disable reconnect`);
  socket.set('retry timeout', 0);
  socket.set('retry max timeout', 0);
  // pm2-axon caches the current backoff separately after connect.
  socket.retry = 0;
}

function revalidateExpectedGod(phase: string): void {
  if (!expectedGod) return;
  const home = process.env.PM2_HOME ?? '';
  const ownership = inspectLinuxPm2GodOwnership(home);
  const current = ownership.kind === 'absent' || ownership.processes.length !== 1
    ? undefined
    : ownership.processes[0];
  if (!expectedGod.startIdentity
      || !current
      || current.pid !== expectedGod.pid
      || current.startIdentity !== expectedGod.startIdentity
      || current.cgroup !== expectedGod.cgroup
      || !revalidateLinuxPm2GodProcess(expectedGod, home)) {
    fail(`PM2 God generation changed before read-only ${phase}`);
  }
}

const timer = setTimeout(() => {
  fail('PM2 read-only RPC connection timed out');
}, CONNECT_TIMEOUT_MS);
timer.unref();

pm2.Client.pingDaemon((alive: boolean) => {
  if (!alive) {
    clearTimeout(timer);
    if (mode === 'jlist') process.exit(ABSENT_EXIT_CODE);
    console.log(mode === 'logs' ? 'daemon 未在运行，暂无 PM2 日志。' : 'daemon 未在运行。');
    process.exit(0);
  }
  pm2.Client.launchRPC((connectError: Error | null | undefined) => {
    if (connectError) fail(`PM2 read-only RPC connection failed: ${connectError.message}`);
    clearTimeout(timer);
    const rpcSocket = pm2.Client.client?.sock;
    disableAxonReconnect(rpcSocket, 'RPC');
    revalidateExpectedGod(mode);
    if (mode === 'jlist') {
      pm2.list((error: Error | null | undefined, list: unknown[]) => {
        if (error) fail(`PM2 read-only jlist failed: ${error.message}`);
        process.stdout.write(JSON.stringify(Array.isArray(list) ? list : []), () => {
          pm2.disconnect(() => process.exit(0));
        });
      });
      return;
    }
    if (mode === 'status') {
      pm2.speedList(null);
      return;
    }
    if (mode === 'logs') {
      const launchBus = pm2.Client.launchBus.bind(pm2.Client);
      pm2.Client.launchBus = (callback: (...args: any[]) => void) => {
        launchBus((error: Error | null | undefined, bus: unknown, busSocket: any) => {
          if (error) fail(`PM2 read-only bus connection failed: ${error.message}`);
          disableAxonReconnect(busSocket, 'bus');
          revalidateExpectedGod('logs bus connection');
          // Closing this generation's publisher must end the observer. Never
          // reconnect to a replacement God that later owns the same pathname.
          busSocket.once('close', () => process.exit(0));
          callback(error, bus, busSocket);
        });
      };
      pm2.streamLogs(target, Number.isFinite(lines) ? lines : 50, false, undefined, false);
      return;
    }
    fail(`unknown PM2 read-only mode: ${mode}`);
  });
});
