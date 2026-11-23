/**
 * Process cleanup shared by the tmux test fence and the Bun test runner.
 *
 * A tmux socket is not a durable process handle: a failed kill-server followed
 * by rmSync makes the server unreachable while leaving it alive. The fence shim
 * therefore records the server pid plus its start identity BEFORE the socket
 * can disappear. Reapers verify that identity before signalling, so a stale
 * record cannot kill an unrelated process after pid reuse.
 *
 * Sandbox labs additionally register their unique fake-CLI pathname. Linux's
 * /proc cmdline is then an ownership proof even after the lab directory has
 * been deleted; no broad process-name, tmux-socket or host-fleet scan is used.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const TMUX_SERVER_LOG_BASENAME = 'tmux-servers.tsv';
export const SANDBOX_SCRIPT_LOG_BASENAME = 'sandbox-scripts.log';
// A Bun child records each short fence root here so its outer runner can reap
// and remove roots that live outside the child's scratch directory.
export const TMUX_FENCE_ROOTS_BASENAME = 'tmux-fence-roots.log';

const PS_ENV = () => ({ ...process.env, LC_ALL: 'C' });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function psField(pid, field) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, value: null };
  const result = spawnSync('ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8', env: PS_ENV(), timeout: 1_000,
  });
  if (result.error || result.signal) return { ok: false, value: null };
  if (result.status !== 0) {
    // POSIX ps uses an empty status-1 result for "no such process". Any other
    // failure is inspection-unknown, never proof that the process died.
    const empty = !String(result.stdout ?? '').trim() && !String(result.stderr ?? '').trim();
    return { ok: result.status === 1 && empty, value: null };
  }
  const value = String(result.stdout ?? '').trim().replace(/\s+/g, ' ');
  return { ok: true, value: value || null };
}

function processIdentityState(pid) {
  const state = psField(pid, 'stat');
  if (!state.ok) return { kind: 'unknown', identity: null };
  if (!state.value || state.value.startsWith('Z')) return { kind: 'dead', identity: null };
  const started = psField(pid, 'lstart');
  const command = psField(pid, 'comm');
  if (!started.ok || !command.ok) return { kind: 'unknown', identity: null };
  if (!started.value || !command.value) return { kind: 'unknown', identity: null };
  return { kind: 'alive', identity: `${started.value}|${command.value}` };
}

/** Start time + executable identity, or null for dead/zombie/unknown processes. */
export function testProcessIdentity(pid) {
  return processIdentityState(pid).identity;
}

/** false also covers a DIFFERENT live identity: the original process is gone. */
function sameLiveProcess(pid, identity) {
  const state = processIdentityState(pid);
  if (state.kind === 'unknown') return undefined;
  if (state.kind === 'dead') return false;
  return identity !== null && state.identity === identity;
}

function queryTmuxServer(tmux, socket, env) {
  const result = spawnSync(tmux, ['-S', socket, 'display-message', '-p', '#{pid}'], {
    encoding: 'utf8', env, timeout: 3_000,
  });
  const pid = Number(String(result.stdout ?? '').trim());
  if (result.error || result.status !== 0 || !Number.isSafeInteger(pid) || pid <= 1) return null;
  const identity = testProcessIdentity(pid);
  return identity ? { pid, identity, socket } : null;
}

function appendUnique(path, line, previous = '') {
  mkdirSync(dirname(path), { recursive: true });
  const existing = previous || (existsSync(path) ? readFileSync(path, 'utf8') : '');
  if (existing.split('\n').includes(line)) return;
  appendFileSync(path, `${line}\n`);
}

/** Capture a private tmux server before its socket can be removed. */
export function registerTmuxServer(tmux, socket, options = {}) {
  const env = options.env ?? process.env;
  const ref = queryTmuxServer(tmux, socket, env);
  const serverLog = options.serverLog ?? env.BOTMUX_TMUX_SERVER_LOG;
  if (ref && serverLog) appendUnique(serverLog, `${ref.pid}\t${ref.identity}\t${ref.socket}`);
  return ref;
}

/** Register one lab-unique script path for last-chance sandbox process cleanup. */
export function registerSandboxScriptForCleanup(script, env = process.env) {
  const path = resolve(script);
  const log = env.BOTMUX_TEST_SANDBOX_SCRIPT_LOG;
  if (!log || !isAbsolute(path)) return;
  appendUnique(log, path);
}

function registryFiles(root, basename) {
  const files = [];
  const direct = join(root, basename);
  if (existsSync(direct)) files.push(direct);
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return files; }
  // Bun can surface undefined (rather than throwing) when the fence root is
  // removed concurrently during teardown. A vanished root holds no registry.
  if (!Array.isArray(entries)) return files;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('bmxt-')) continue;
    const nested = join(root, entry.name, basename);
    if (existsSync(nested)) files.push(nested);
  }
  return files;
}

function registeredServers(root) {
  const refs = new Map();
  for (const file of registryFiles(root, TMUX_SERVER_LOG_BASENAME)) {
    let lines = [];
    try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      const [rawPid, identity, socket] = line.split('\t');
      const pid = Number(rawPid);
      if (!Number.isSafeInteger(pid) || pid <= 1 || !identity || !socket?.startsWith('/')) continue;
      refs.set(`${pid}\t${identity}\t${socket}`, { pid, identity, socket });
    }
  }
  return [...refs.values()];
}

/** Socket -> pids of the clients that announced a server start on it. A
 *  record without a pid (older fence) has an empty set. */
function registeredServerIntents(root) {
  const intents = new Map();
  for (const file of registryFiles(root, TMUX_SERVER_LOG_BASENAME)) {
    let lines = [];
    try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      if (!line.startsWith('pending\t')) continue;
      const [, socket, rawPid] = line.split('\t');
      if (!socket?.startsWith('/')) continue;
      const clients = intents.get(socket) ?? new Set();
      const pid = Number(rawPid);
      if (Number.isSafeInteger(pid) && pid > 1) clients.add(pid);
      intents.set(socket, clients);
    }
  }
  return intents;
}

/** A live, non-zombie process. Unknown evidence counts as alive. */
function clientAlive(pid) {
  if (process.platform === 'linux') {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (error) {
      return error?.code !== 'ENOENT' && error?.code !== 'ESRCH';
    }
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  }
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Parse `lsof -n -U -F pcn` for non-Linux hosts (notably macOS). */
export function parseLsofTmuxServers(output, sockets, identityForPid = testProcessIdentity) {
  const refs = new Map();
  let ok = true;
  let pid;
  let command;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); command = undefined; continue; }
    if (line.startsWith('c')) { command = line.slice(1); continue; }
    if (!line.startsWith('n') || !Number.isSafeInteger(pid) || pid <= 1) continue;
    if (command !== 'tmux: server' && command !== 'tmux') continue;
    const socket = line.slice(1).replace(/ \(deleted\)$/, '');
    if (!sockets.has(socket)) continue;
    const identity = identityForPid(pid);
    if (!identity) { ok = false; continue; }
    refs.set(`${pid}\t${socket}`, { pid, identity, socket });
  }
  return { ok, refs: [...refs.values()] };
}

function discoverLsofTmuxServers(sockets) {
  const result = spawnSync('lsof', ['-n', '-U', '-F', 'pcn'], {
    encoding: 'utf8', timeout: 3_000,
  });
  if (result.error || result.status !== 0) return { ok: false, refs: [] };
  return parseLsofTmuxServers(String(result.stdout ?? ''), sockets);
}

/**
 * Resolve socket intents without depending on a concurrent registration hook.
 * Linux keeps the listening path in /proc/net/unix even after unlink, and the
 * server fd carries the matching inode. That pair proves ownership after the
 * directory is gone; a pid captured later is only used with its start identity.
 */
function discoverTmuxServers(sockets) {
  if (sockets.size === 0) return { ok: true, refs: [] };
  if (process.platform !== 'linux') return discoverLsofTmuxServers(sockets);
  let table;
  try { table = readFileSync('/proc/net/unix', 'utf8'); } catch { return { ok: false, refs: [] }; }
  const inodeToSocket = new Map();
  for (const line of table.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || !/^\d+$/.test(fields[6] ?? '')) continue;
    const path = fields.slice(7).join(' ').replace(/ \(deleted\)$/, '');
    if (sockets.has(path)) inodeToSocket.set(fields[6], path);
  }
  const refs = new Map();
  let ok = true;
  let entries = [];
  try { entries = readdirSync('/proc'); } catch { return { ok: false, refs: [] }; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let comm;
    try { comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { continue; }
    if (comm !== 'tmux: server') continue;
    let fds = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') ok = false;
      continue;
    }
    for (const fd of fds) {
      let target;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      const socket = match ? inodeToSocket.get(match[1]) : undefined;
      if (!socket) continue;
      const identity = testProcessIdentity(pid);
      if (!identity) { ok = false; continue; }
      refs.set(`${pid}\t${socket}`, { pid, identity, socket });
    }
  }
  return { ok, refs: [...refs.values()] };
}

function reapingCandidates(registered, intents) {
  const discovered = discoverTmuxServers(new Set(intents.keys()));
  const refs = new Map();
  for (const ref of [...registered, ...discovered.refs]) refs.set(`${ref.pid}\t${ref.identity}\t${ref.socket}`, ref);
  const pending = [...intents.keys()].filter(socket => ![...refs.values()].some(ref => ref.socket === socket));
  const unresolved = discovered.ok ? [] : pending
    .map(socket => ({ pid: 0, identity: 'inspection_unknown', socket }));
  return { refs: [...refs.values()], pending, unresolved };
}

function reapServer(ref) {
  const initial = sameLiveProcess(ref.pid, ref.identity);
  if (initial === false) return true;
  if (initial === undefined) return false;
  try { process.kill(ref.pid, 'SIGKILL'); } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const current = sameLiveProcess(ref.pid, ref.identity);
    if (current === false) return true;
    if (current === undefined) return false;
    sleep(25);
  }
  return sameLiveProcess(ref.pid, ref.identity) === false;
}

/**
 * Kill a private server and prove its original process is gone before the
 * caller removes the socket directory. A failed kill-server is only the first
 * attempt; the registered pid is the fallback and the postcondition.
 */
export function killPrivateTmuxServer(tmux, socket, options = {}) {
  const env = options.env ?? process.env;
  const ref = registerTmuxServer(tmux, socket, options);
  const result = spawnSync(tmux, ['-S', socket, 'kill-server'], {
    env, stdio: 'ignore', timeout: 3_000,
  });
  const registryRoot = options.registryRoot
    ?? (options.serverLog ? dirname(options.serverLog)
      : env.BOTMUX_TMUX_SERVER_LOG ? dirname(env.BOTMUX_TMUX_SERVER_LOG) : undefined);
  const registered = ref ? [ref] : registryRoot
    ? registeredServers(registryRoot).filter(candidate => candidate.socket === socket)
    : [];
  const candidates = reapingCandidates(registered, new Set([socket]));
  const tmuxFailed = [...candidates.unresolved, ...candidates.refs.filter(candidate => !reapServer(candidate))];
  return {
    ok: tmuxFailed.length === 0
      && (ref !== null || result.status === 0 || candidates.refs.length > 0),
    killServerStatus: result.status,
    killServerError: result.error,
    tmuxFailed,
  };
}

function registeredSandboxScripts(root) {
  const scripts = new Set();
  for (const file of registryFiles(root, SANDBOX_SCRIPT_LOG_BASENAME)) {
    let lines = [];
    try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) if (isAbsolute(line)) scripts.add(line);
  }
  return [...scripts];
}

function sandboxPids(scripts) {
  if (process.platform !== 'linux' || scripts.size === 0) return [];
  const matches = [];
  let entries = [];
  try { entries = readdirSync('/proc'); } catch { return matches; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid || pid <= 1) continue;
    let argv;
    try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    if (argv.some(argument => scripts.has(argument))) matches.push(pid);
  }
  return matches;
}

/**
 * Last-chance cleanup for a fence root or a Bun child's scratch root. Nested
 * bmxt-* directories cover a child killed before its own afterAll could run.
 */
/** Bounds for a server start announced by a client that may still be running. */
const LEGACY_INTENT_GRACE_MS = 2_000;
const INTENT_STARTUP_CAP_MS = 15_000;

export function reapRegisteredTestProcesses(root) {
  const registered = registeredServers(root);
  const intents = registeredServerIntents(root);
  // A client may have detached its server without binding the socket yet. A
  // fixed window lost that race on a loaded CI host: the server came up after
  // the wait and outlived the run. Wait as long as the announcing client is
  // alive (it exits once its server is up or has failed), bounded; a record
  // without a client pid keeps the old short grace. A socket whose server was
  // already found is settled, even though its reaped server no longer shows.
  // The runner invokes this BEFORE killTree too.
  const start = Date.now();
  const settled = new Set();
  let candidates;
  let tmuxFailed;
  for (;;) {
    candidates = reapingCandidates(registered, intents);
    for (const ref of candidates.refs) settled.add(ref.socket);
    tmuxFailed = [...candidates.unresolved, ...candidates.refs.filter(ref => !reapServer(ref))];
    const now = Date.now();
    const starting = candidates.pending.filter((socket) => {
      if (settled.has(socket)) return false;
      const clients = intents.get(socket);
      return clients.size > 0
        ? [...clients].some(clientAlive)
        : now - start < LEGACY_INTENT_GRACE_MS;
    });
    if (starting.length === 0) break;
    if (now - start >= INTENT_STARTUP_CAP_MS) {
      // Never report success over a server that may still appear.
      tmuxFailed.push(...starting.map(socket => ({ pid: 0, identity: 'startup_unsettled', socket })));
      break;
    }
    sleep(25);
  }
  const scripts = new Set(registeredSandboxScripts(root));
  const matched = sandboxPids(scripts);
  for (const pid of matched) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + 3_000;
  let remaining = matched;
  while (remaining.length > 0 && Date.now() < deadline) {
    sleep(25);
    const alive = new Set(sandboxPids(scripts));
    remaining = matched.filter(pid => alive.has(pid));
  }
  return { tmuxFailed, sandboxPids: matched, sandboxFailed: remaining };
}
