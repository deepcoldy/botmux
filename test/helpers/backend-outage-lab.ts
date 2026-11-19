/**
 * Real workers on a PRIVATE tmux server for the backend-outage tests.
 *
 * Each lab session is a real `src/worker.ts` process running a small fake
 * CLI driven through the Hermes adapter (`❯` prompt, pasted input, completion
 * at the next `❯`). The tmux server lives under the caller's own TMUX_TMPDIR
 * with its own socket name — never the fleet's `-L botmux` — so killing it
 * only ever kills this test's server.
 */
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnNodeTsScript } from './ts-runner.js';

export function realTmuxPath(): string | undefined {
  try { return execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

/**
 * The fake CLI. Lines containing `DIE` exit 3 (a non-zero exit keeps the pane
 * as a corpse); `LONG` starts a turn that finishes after 8s; anything else is
 * answered at once. Every start and input line is appended to `typed.log` in
 * its working directory, with the CLI's pid.
 *
 * Neutral file name on purpose: some hosts refuse to exec anything named like
 * the real Hermes agent, and this is only a stand-in.
 */
export function writeFakeCli(path: string): void {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('hermes 0.18.0'); process.exit(0); }
const log = (line) => fs.appendFileSync('typed.log', JSON.stringify({ pid: process.pid, line }) + '\\n');
log('<start>');
process.stdout.write('fake cli\\n\\u276f ');
let buf = '';
let busy;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.search(/[\\r\\n]/); i >= 0; i = buf.search(/[\\r\\n]/)) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
function handle(line) {
  log(line);
  if (line.includes('DIE')) process.exit(3);
  if (line.includes('LONG')) {
    process.stdout.write('\\nworking on ' + line + '\\n');
    busy = setInterval(() => process.stdout.write('.'), 250);
    setTimeout(() => { clearInterval(busy); process.stdout.write('\\nREPLY: ' + line + '\\n\\u276f '); }, 8000);
    return;
  }
  process.stdout.write('\\nREPLY: ' + line + '\\n\\u276f ');
}
setInterval(() => {}, 1 << 30);
`, { mode: 0o700 });
}

export interface OutageLabWorld {
  /** Short root (tmux socket paths are length-limited). Must exist. */
  root: string;
  /** Private, EXISTING tmux tmp dir (tmux silently falls back to /tmp otherwise). */
  tmuxTmpDir: string;
  /** Private socket name for the managed server. */
  socket: string;
}

export interface OutageLabSession {
  sessionId: string;
  rootMessageId: string;
  workDir: string;
  init: Record<string, unknown>;
  worker: ChildProcess;
  ipc: Array<{ type: string; [key: string]: unknown }>;
  logs(): string;
  typed(): Array<{ pid: number; line: string }>;
  /** tmux session name of the pane. */
  paneTarget: string;
}

/** Create the world's directories and bots.json; returns the bots path. */
export function prepareOutageLabWorld(world: OutageLabWorld): string {
  mkdirSync(world.tmuxTmpDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(world.root, 'data'), { recursive: true });
  mkdirSync(join(world.root, '.botmux'), { recursive: true });
  const bots = join(world.root, '.botmux', 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_lab', larkAppSecret: '', apiOnly: true, cliId: 'hermes' }]));
  return bots;
}

/** Start one real worker. The caller decides what talks to it (the test as
 *  the daemon, or the real daemon handlers via __testOnly_setupWorkerHandlers
 *  — attach them BEFORE calling `sendInit`). */
export function startOutageLabSession(world: OutageLabWorld, index: number): OutageLabSession & { sendInit(): void } {
  const sessionId = randomUUID();
  const rootMessageId = `om_root_${index}`;
  const workDir = join(world.root, `w${index}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'package.json'), '{"type":"commonjs"}\n');
  const cli = join(workDir, 'fake-cli');
  writeFakeCli(cli);
  const bots = join(world.root, '.botmux', 'bots.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: world.root, SHELL: '/bin/sh', TMUX_TMPDIR: world.tmuxTmpDir,
    SESSION_DATA_DIR: join(world.root, 'data'), BOTS_CONFIG: bots, BOTMUX_NO_CLAIM: '1',
  };
  // Keep the fence marker: with it the session-scope code never derives the
  // host's user bus, so no real systemd unit is touched.
  for (const key of Object.keys(env)) {
    if (key.startsWith('BOTMUX_') && key !== 'BOTMUX_NO_CLAIM' && key !== 'BOTMUX_FENCED_RUN') delete env[key];
  }
  env.BOTMUX_TMUX_SOCKET = world.socket;
  delete env.TMUX;
  delete env.TMUX_PANE;
  const worker = spawnNodeTsScript('src/worker.ts', [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = '';
  worker.stdout?.on('data', d => { logs += String(d); });
  worker.stderr?.on('data', d => { logs += String(d); });
  const ipc: OutageLabSession['ipc'] = [];
  worker.on('message', (m: any) => { ipc.push(m); });
  const init = {
    type: 'init', sessionId, chatId: 'oc_lab', rootMessageId, workingDir: workDir,
    cliId: 'hermes', cliPathOverride: cli, backendType: 'tmux', prompt: '',
    apiOnly: true, larkAppId: 'app_lab', larkAppSecret: '', ownerOpenId: 'ou_owner', daemonBootId: 'boot-lab',
    loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
  };
  return {
    sessionId, rootMessageId, workDir, init, worker, ipc,
    paneTarget: `bmx-${sessionId.slice(0, 8)}`,
    logs: () => logs,
    typed: () => {
      const path = join(workDir, 'typed.log');
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    sendInit: () => { worker.send(init); },
  };
}

/** tmux against the world's private server. */
export function labTmux(world: OutageLabWorld, realTmux: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: world.tmuxTmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return spawnSync(realTmux, ['-L', world.socket, ...args], { encoding: 'utf8', timeout: 5_000, env });
}

/** Kill the world's own private server (never a host socket). */
export function killLabServer(world: OutageLabWorld, realTmux: string): void {
  labTmux(world, realTmux, 'kill-server');
}

/** pid of the world's tmux server, when one answers. */
export function labServerPid(world: OutageLabWorld, realTmux: string): number | undefined {
  const r = labTmux(world, realTmux, 'display-message', '-p', '#{pid}');
  const pid = Number(String(r.stdout ?? '').trim());
  return r.status === 0 && pid > 0 ? pid : undefined;
}
