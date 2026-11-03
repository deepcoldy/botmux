/**
 * End-to-end harness for `botmux dispatch` inside a production-shape Linux
 * credential-only pane, driven all the way to "the task was actually sent".
 *
 * What is real: the built CLI (dist/cli.js run by Node), the credential-only
 * bwrap wrapper (seccomp launcher, device-auth / `.dashboard-secret` masks,
 * private capability dirs, relay outbox + its --setenv pair), the host relay
 * watcher (startOutboxWatcher re-executing the same build with the host secret).
 *
 * What is faked: the source/target daemons (one loopback server registered for
 * both apps in `dashboard-daemons/`) and the Lark Open API (a preloaded stub
 * redirects the SDK's HTTPS requests for open.feishu.cn to a loopback server).
 *
 * "Sent" means the daemon received the kickoff delivery request
 * (`/api/dispatch-user/deliver`) — or, for `--standby`, the seed registration
 * plus the `/repo` prime reply through Lark.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCredentialOnlySandboxArgs,
  prepareCredentialOnlyRelayOutbox,
  startOutboxWatcher,
} from '../../src/adapters/backend/sandbox.js';
import { linuxIsolationLaunch } from '../../src/core/linux-isolation.js';
import {
  ensureManagedOriginAttestationDirectory,
  ensureManagedOriginCapabilityLeafSafe,
  managedOriginAttestationDirectory,
  managedOriginCapabilityDirectory,
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../../src/core/managed-origin-capability.js';
import { seedPersistedSessionRows } from './session-store-disk.js';

export interface DispatchFlowCall {
  url: string;
  method: string;
  /** Pane-direct calls carry the managed-origin capability in the body; host
   *  (relay re-exec) calls are HMAC-signed instead. */
  viaCapability: boolean;
  viaHostAuth: boolean;
  /** Which capability a pane request presented (rotation scenarios). */
  presented: 'initial' | 'rotated' | 'none';
  status: number;
  body: string;
}

export interface DispatchFlowResult {
  code: number | null;
  stderr: string;
  stdout: string;
  relayRequests: number;
  daemonCalls: DispatchFlowCall[];
  larkCalls: Array<{ method: string; url: string }>;
  /** Kickoff delivery reached the daemon (the task was actually sent). */
  delivered: boolean;
  /** Kickoff delivery reached the daemon AND was accepted (2xx). */
  deliveredAccepted: boolean;
  /** Seed registration reached the daemon (new topic created). */
  registered: boolean;
  /** `/repo` prime (or any message reply) reached Lark. */
  larkReplies: number;
  path: 'relay' | 'direct' | 'refused';
}

export function resolveNodeBinary(): string | null {
  const r = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' });
  const p = r.status === 0 ? String(r.stdout ?? '').trim() : '';
  if (!p.startsWith('/')) return null;
  try { return realpathSync(p); } catch { return null; }
}

const LARK_STUB = `
import http from 'node:http';
import https from 'node:https';
const port = Number(process.env.FAKE_LARK_PORT);
const isLark = host => /(^|\\.)(feishu\\.cn|larksuite\\.com)$/.test(String(host || '').replace(/:\\d+$/, ''));
const original = https.request;
function redirect(input, options, callback) {
  let opts;
  if (typeof input === 'string' || input instanceof URL) {
    const u = new URL(input);
    opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search };
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (options) opts = { ...opts, ...options };
  } else {
    opts = { ...input };
    if (typeof options === 'function') callback = options;
  }
  if (!port || !isLark(opts.hostname || opts.host)) return original.call(https, input, options, callback);
  const headers = { ...(opts.headers || {}) };
  return http.request({
    method: opts.method || 'GET', host: '127.0.0.1', port, path: opts.path || '/', headers,
  }, callback);
}
https.request = (input, options, callback) => redirect(input, options, callback);
https.get = (input, options, callback) => { const req = redirect(input, options, callback); req.end(); return req; };
`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

export async function runCredentialOnlyDispatch(input: {
  repoRoot: string;
  bwrap: string;
  node: string;
  dispatchArgs: string[];
  /** Strip the credential-only scope marker → a relay-only (full-sandbox
   *  shaped) pane, as a control. */
  dropScopeMarker?: boolean;
  /** Emulate the real daemon's origin check (a non-host request must present
   *  the LIVE capability, else 403 origin_unproven) and rotate the live
   *  capability — exactly as a turn interruption does, including the atomic
   *  rewrite of the pane-visible capability files — right after the daemon
   *  answers the first request whose URL ends with this suffix. */
  rotateCapabilityAfter?: string;
}): Promise<DispatchFlowResult> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'credonly-flow-')));
  const botmuxHome = join(root, '.botmux');
  const dataDir = join(botmuxHome, 'data');
  mkdirSync(dataDir, { recursive: true });
  const sessionId = `sess-${randomBytes(6).toString('hex')}`;
  const channelId = randomBytes(32).toString('hex');
  const capability = randomBytes(32).toString('hex');
  const row = {
    sessionId, chatId: 'oc_src', rootMessageId: 'om_root', title: 't', status: 'active',
    createdAt: new Date(0).toISOString(), larkAppId: 'cli_src',
  };
  seedPersistedSessionRows(dataDir, 'cli_src', { [sessionId]: row });
  const bots = join(root, 'bots.json');
  writeFileSync(bots, JSON.stringify([
    { larkAppId: 'cli_src', larkAppSecret: 'src-secret', cliId: 'claude-code' },
    { larkAppId: 'cli_target', larkAppSecret: 'target-secret', cliId: 'claude-code' },
  ]));
  writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
    { larkAppId: 'cli_src', botName: '源Bot' },
    { larkAppId: 'cli_target', botName: '目标Bot' },
  ]));
  writeFileSync(join(root, 'brief.md'), 'brief from file');
  // Host-only trust root: exists on the host, masked inside the pane.
  const dashboardSecret = join(botmuxHome, '.dashboard-secret');
  writeFileSync(dashboardSecret, randomBytes(32).toString('hex'), { mode: 0o600 });
  const authorityDir = join(botmuxHome, 'device-auth');
  mkdirSync(authorityDir, { mode: 0o700 });
  const stub = join(root, 'lark-stub.mjs');
  writeFileSync(stub, LARK_STUB);
  // The watcher re-execs `process.execPath <cliPath>`; under Bun that is bun,
  // so hand it a launcher that always runs the build with Node + the stub.
  const hostLauncher = join(root, 'host-cli.cjs');
  writeFileSync(hostLauncher, `
const { spawnSync } = require('node:child_process');
const r = spawnSync(${JSON.stringify(input.node)}, ['--import', ${JSON.stringify(stub)}, ${JSON.stringify(join(input.repoRoot, 'dist', 'cli.js'))}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
`);

  ensureManagedOriginCapabilityLeafSafe(managedOriginCapabilityPath(dataDir, sessionId, channelId));
  ensureManagedOriginAttestationDirectory(dataDir, sessionId, channelId);
  writeFileSync(managedOriginCapabilityPath(dataDir, sessionId, channelId), JSON.stringify({
    sessionId, channelId, capability, larkAppId: 'cli_src', turnId: 'turn-1',
  }), { mode: 0o600 });
  const relay = prepareCredentialOnlyRelayOutbox({ sessionId, dataDir })!;
  writeFileSync(join(relay.outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
    sessionId, channelId, token: capability, larkAppId: 'cli_src', turnId: 'turn-1',
  }), { mode: 0o600 });

  const daemonCalls: DispatchFlowCall[] = [];
  const rotatedCapability = randomBytes(32).toString('hex');
  let liveCapability = capability;
  let rotated = false;
  const rotate = (): void => {
    rotated = true;
    liveCapability = rotatedCapability;
    replaceManagedOriginCapabilityFile(managedOriginCapabilityPath(dataDir, sessionId, channelId), JSON.stringify({
      sessionId, channelId, capability: rotatedCapability, larkAppId: 'cli_src', turnId: 'turn-2',
    }));
    replaceManagedOriginCapabilityFile(join(relay.outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
      sessionId, channelId, token: rotatedCapability, larkAppId: 'cli_src', turnId: 'turn-2',
    }));
  };
  const daemon = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '';
    // Only daemon IPC routes are evidence. Shared CI/dev hosts can have
    // unrelated local port scanners hit any listening loopback port.
    if (!url.startsWith('/api/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const viaHostAuth = !!req.headers['x-botmux-cli-auth'];
    const presented: DispatchFlowCall['presented'] = body.includes(capability)
      ? 'initial'
      : body.includes(rotatedCapability) ? 'rotated' : 'none';
    const call: DispatchFlowCall = {
      url, method: req.method ?? '', body,
      viaCapability: presented !== 'none',
      viaHostAuth,
      presented,
      status: 0,
    };
    daemonCalls.push(call);
    const json = (status: number, payload: unknown) => {
      call.status = status;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      if (input.rotateCapabilityAfter && !rotated && status < 300 && url.endsWith(input.rotateCapabilityAfter)) rotate();
    };
    if (input.rotateCapabilityAfter && !viaHostAuth && req.method === 'POST'
      && !body.includes(liveCapability)) {
      return json(403, { ok: false, error: 'origin_unproven' });
    }
    if (req.method === 'GET' && url === `/api/sessions/${sessionId}`) return json(200, { session: row });
    if (url.endsWith('/project-dispatch-policy')) return json(200, { ok: true });
    if (url === '/api/report-relay/register') return json(200, { ok: true, dispatchRoot: 'om_seed_1' });
    if (url === '/api/dispatch-user/deliver') return json(200, { ok: true, messageId: 'om_kickoff_1' });
    if (url.endsWith('/project')) return json(404, { ok: false, error: 'project_not_found' });
    if (url === '/api/grants/chat') return json(200, { ok: true });
    return json(200, { ok: true });
  });
  const daemonPort = await listen(daemon);
  mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
  for (const appId of ['cli_src', 'cli_target']) {
    writeFileSync(join(dataDir, 'dashboard-daemons', `${appId}.json`), JSON.stringify({
      larkAppId: appId, ipcPort: daemonPort, lastHeartbeat: Date.now() + 600_000, pid: process.pid,
    }));
  }

  const larkCalls: Array<{ method: string; url: string }> = [];
  let larkSeq = 0;
  const lark = createServer(async (req, res) => {
    await readBody(req);
    const url = req.url ?? '';
    larkCalls.push({ method: req.method ?? '', url });
    const json = (payload: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.includes('/auth/v3/')) {
      return json({ code: 0, msg: 'ok', tenant_access_token: 't-fake', app_access_token: 'a-fake', expire: 7200 });
    }
    if (url.includes('/is_in_chat')) return json({ code: 0, data: { is_in_chat: true } });
    if (url.includes('/members/bots')) {
      return json({ code: 0, data: { items: [
        { bot_id: 'ou_target_seen_by_src', bot_name: '目标Bot' },
        { bot_id: 'ou_src_self', bot_name: '源Bot' },
      ], has_more: false } });
    }
    if (url.includes('/reply')) return json({ code: 0, data: { message_id: `om_reply_${++larkSeq}` } });
    if (req.method === 'GET' && url.includes('/im/v1/messages/')) {
      return json({ code: 0, data: { items: [{
        message_id: 'om_any', chat_id: 'oc_src', thread_id: 'omt_fake', root_id: 'om_any',
        msg_type: 'text', body: { content: '{"text":""}' },
      }] } });
    }
    return json({ code: 0, data: {} });
  });
  const larkPort = await listen(lark);

  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    SESSION_DATA_DIR: dataDir,
    BOTS_CONFIG: bots,
    BOTMUX_SESSION_ID: sessionId,
    BOTMUX_LARK_APP_ID: 'cli_src',
    BOTMUX_CHAT_ID: 'oc_src',
    BOTMUX_ROOT_MESSAGE_ID: 'om_root',
    BOTMUX_DISPATCH_ACCEPT_TIMEOUT_MS: '0',
    FAKE_LARK_PORT: String(larkPort),
  };
  const stopWatcher = startOutboxWatcher(relay.outbox, { ...baseEnv }, sessionId, {
    cliPath: hostLauncher,
    authorize: claim => claim.capability === capability
      ? { ok: true, origin: { turnId: 'turn-1' } }
      : { ok: false, error: 'stale capability' },
  });

  const policyDir = realpathSync(join(dataDir, 'read-isolation'));
  const args = buildCredentialOnlySandboxArgs({
    hideDirectories: [realpathSync(authorityDir), relay.sessionsRoot],
    hideFiles: [realpathSync(dashboardSecret)],
    privateReadonlyDirectories: [
      { parent: policyDir, directory: realpathSync(managedOriginCapabilityDirectory(dataDir, sessionId, channelId)) },
      { parent: policyDir, directory: realpathSync(managedOriginAttestationDirectory(dataDir, sessionId, channelId)) },
    ],
    writableOutbox: relay.outbox,
    workingDir: root,
    cliBin: input.node,
    cliArgs: ['--import', stub, join(input.repoRoot, 'dist', 'cli.js'), 'dispatch',
      ...input.dispatchArgs.map(arg => arg.replace('<ROOT>', root))],
  } as Parameters<typeof buildCredentialOnlySandboxArgs>[0]);
  if (input.dropScopeMarker) {
    const at = args.findIndex((v, i) => v === '--setenv' && args[i + 1] === 'BOTMUX_SEND_RELAY_SCOPE');
    if (at < 0) throw new Error('scope marker not emitted by this build');
    args.splice(at, 3);
  }
  args.splice(args.indexOf('--'), 0, '--dev', '/dev');
  const launch = linuxIsolationLaunch(input.bwrap, args);
  const child = spawn(launch.bin, launch.args, {
    env: {
      ...baseEnv,
      BOTMUX_ORIGIN_CHANNEL_ID: channelId,
      BOTMUX_DAEMON_IPC_PORT: String(daemonPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 90_000);
    child.on('close', c => { clearTimeout(timer); resolve(c); });
  });
  stopWatcher();
  await new Promise<void>(resolve => daemon.close(() => resolve()));
  await new Promise<void>(resolve => lark.close(() => resolve()));
  let relayRequests = 0;
  try {
    relayRequests = readdirSync(relay.outbox).filter(name => /\.(req|res)\.json$/.test(name)).length;
  } catch { /* removed */ }
  rmSync(root, { recursive: true, force: true });

  const delivered = daemonCalls.some(call => call.url === '/api/dispatch-user/deliver');
  const deliveredAccepted = daemonCalls.some(call => call.url === '/api/dispatch-user/deliver' && call.status < 300);
  const registered = daemonCalls.some(call => call.url === '/api/report-relay/register');
  const larkReplies = larkCalls.filter(call => call.url.includes('/reply')).length;
  const paneDirect = daemonCalls.some(call => call.viaCapability && !call.viaHostAuth);
  // Only the host re-exec holds the dashboard secret (masked in the pane).
  const relayed = daemonCalls.some(call => call.viaHostAuth);
  const path = relayed ? 'relay' : paneDirect ? 'direct' : 'refused';
  return {
    code, stderr, stdout, relayRequests, daemonCalls, larkCalls,
    delivered, deliveredAccepted, registered, larkReplies, path,
  };
}
