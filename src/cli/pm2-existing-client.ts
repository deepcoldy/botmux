#!/usr/bin/env node
/** Execute a bounded PM2 mutation only when its RPC daemon already exists. */
import { createRequire } from 'node:module';
import {
  inspectLinuxPm2GodOwnership,
  revalidateLinuxPm2GodProcess,
  type LinuxPm2GodProcess,
} from '../core/pm2-lifecycle-owner.js';

const require = createRequire(import.meta.url);
const pm2 = require('pm2') as any;
const ABSENT_EXIT_CODE = 4;
const CONNECT_TIMEOUT_MS = 5_000;
const MUTATION_TIMEOUT_MS = 25_000;

type Mutation =
  | { operation: 'start'; target: string; only?: string; updateEnv?: boolean }
  | { operation: 'restart'; target: string; updateEnv?: boolean }
  | { operation: 'stop' | 'delete'; target: string };
type Request = Mutation & { expectedGod: LinuxPm2GodProcess };

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

let request: Request;
try {
  request = JSON.parse(process.argv[2] ?? '') as Request;
} catch (error) {
  fail(`invalid PM2 existing-daemon request: ${error instanceof Error ? error.message : String(error)}`);
}

const timer = setTimeout(() => fail('PM2 existing-daemon RPC connection timed out'), CONNECT_TIMEOUT_MS);
timer.unref();
let mutationTimer: NodeJS.Timeout | undefined;
let mutationSettled = false;

function complete(error?: Error | null): void {
  mutationSettled = true;
  if (mutationTimer) clearTimeout(mutationTimer);
  if (error) fail(`PM2 existing-daemon ${request.operation} failed: ${error.message}`);
  pm2.disconnect((disconnectError?: Error | null) => {
    if (disconnectError) fail(`PM2 existing-daemon disconnect failed: ${disconnectError.message}`);
    process.exit(0);
  });
}

pm2.Client.pingDaemon((alive: boolean) => {
  if (!alive) {
    clearTimeout(timer);
    fail('PM2 God disappeared before mutation; refusing to daemonize from this caller', ABSENT_EXIT_CODE);
  }
  pm2.Client.launchRPC((connectError: Error | null | undefined) => {
    if (connectError) fail(`PM2 existing-daemon RPC connection failed: ${connectError.message}`);
    clearTimeout(timer);
    const rpcSocket = pm2.Client.client?.sock;
    if (!rpcSocket?.set) fail('PM2 existing-daemon RPC socket cannot disable reconnect');
    // pm2-axon otherwise queues an in-flight request and reconnects to a new
    // rpc.sock owner after 100ms. A generation check cannot bind the eventual
    // recipient unless reconnection is disabled before the check and send.
    rpcSocket.set('retry timeout', 0);
    rpcSocket.set('retry max timeout', 0);
    rpcSocket.retry = 0;
    rpcSocket.once('close', () => {
      if (!mutationSettled) fail(`PM2 God disconnected before ${request.operation} completed`);
    });
    // launchRPC pins this client to one socket generation. Revalidate the exact
    // PID/birth/cgroup only after that connection exists: a God replaced after
    // the parent's ownership check can no longer receive a mutation first.
    const home = process.env.PM2_HOME ?? '';
    const ownership = inspectLinuxPm2GodOwnership(home);
    const current = ownership.kind === 'absent' || ownership.processes.length !== 1
      ? undefined
      : ownership.processes[0];
    if (!request.expectedGod?.startIdentity
        || !current
        || current.pid !== request.expectedGod.pid
        || current.startIdentity !== request.expectedGod.startIdentity
        || current.cgroup !== request.expectedGod.cgroup
        || !revalidateLinuxPm2GodProcess(request.expectedGod, home)) {
      mutationSettled = true;
      pm2.disconnect(() => fail(
        `PM2 God generation changed before mutation (expected pid ${request.expectedGod?.pid ?? 'unknown'})`,
        ABSENT_EXIT_CODE,
      ));
      return;
    }
    // Keep the helper alive until PM2 acknowledges the mutation. With Axon
    // reconnect disabled, a closed socket must never let an unacknowledged
    // queued request fall through Node's beforeExit path with status 0.
    mutationTimer = setTimeout(
      () => fail(`PM2 existing-daemon ${request.operation} response timed out`),
      MUTATION_TIMEOUT_MS,
    );
    switch (request.operation) {
      case 'start':
        pm2.start(request.target, {
          ...(request.only ? { only: request.only } : {}),
          ...(request.updateEnv ? { updateEnv: true } : {}),
        }, complete);
        return;
      case 'restart':
        pm2.restart(request.target, { updateEnv: request.updateEnv === true }, complete);
        return;
      case 'stop':
        pm2.stop(request.target, complete);
        return;
      case 'delete':
        pm2.delete(request.target, complete);
        return;
      default:
        fail('unsupported PM2 existing-daemon mutation');
    }
  });
});
