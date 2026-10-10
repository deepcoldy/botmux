import { execFile } from 'node:child_process';
import { createReadStream, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { isNewerVersion } from '../core/update-check.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';
import { readCmdline } from '../core/session-discovery.js';
import { parseWrapperCliEntry } from '../utils/local-dev-update.js';

const exec = promisify(execFile);
const observedProcesses = new Map<number, CodexProcess>();

export interface CodexExecutable {
  path: string;
  version: string;
  fingerprint: string;
}

export interface CodexProcess extends CodexExecutable {
  pid: number;
  started: string;
}

/** This probe only runs --version; it must never open a thread or generate text. */
export async function probeCodexExecutable(path: string): Promise<CodexExecutable> {
  const real = realpathSync(path);
  const stat = statSync(real);
  const { stdout } = await exec(real, ['--version'], { timeout: 5_000, maxBuffer: 16_384 });
  const version = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m.exec(stdout)?.[1];
  if (!version) throw new Error('Executable did not identify itself as Codex');
  return { path: real, version, fingerprint: `${real}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
}

export interface ProcessRow { pid: number; ppid: number; command: string }

export function parseUpgradeProcessTable(text: string): ProcessRow[] {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() }] : [];
  });
}

export function upgradeProcessTree(rows: readonly ProcessRow[], roots: readonly number[]): ProcessRow[] {
  const included = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (included.has(row.ppid) && !included.has(row.pid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(row => included.has(row.pid));
}

/** Failure is unknown, never an empty (apparently idle) process tree. */
export async function readUpgradeProcessTable(): Promise<ProcessRow[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,comm='], {
    timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
  });
  const rows = parseUpgradeProcessTable(stdout);
  if (!rows.length) throw new Error('Unable to inspect Codex process tree');
  return rows;
}

export async function probeRunningCodex(row: ProcessRow): Promise<CodexProcess> {
  const started = readProcessStartIdentity(row.pid);
  if (!started) throw new Error('Codex process identity is unavailable');
  const observed = observedProcesses.get(row.pid);
  if (observed?.started === started) return observed;
  // Linux /proc exposes the *running inode*, even after an installer unlinks it.
  // Executing a newly resolved PATH binary would report the wrong generation.
  const path = process.platform === 'linux' ? `/proc/${row.pid}/exe` : row.command;
  let executable: CodexExecutable;
  if (process.platform === 'linux') {
    const { stdout } = await exec(path, ['--version'], { timeout: 5_000, maxBuffer: 16_384 });
    const version = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m.exec(stdout)?.[1];
    if (!version) throw new Error('Running process did not identify itself as Codex');
    const stat = statSync(path);
    executable = { path: readlinkSync(path), version, fingerprint: `${stat.dev}:${stat.ino}` };
  } else {
    executable = await probeCodexExecutable(path);
    // An in-place replacement cannot tell us the old process's version on macOS.
    // Leave it alone instead of calling the replacement's version "running".
    const born = Date.parse(started);
    if (!Number.isFinite(born) || statSync(executable.path).mtimeMs > born + 1_000) {
      throw new Error('Running Codex executable changed after process start');
    }
  }
  if (readProcessStartIdentity(row.pid) !== started) throw new Error('Codex process changed during inspection');
  const observedProcess = { ...executable, pid: row.pid, started };
  observedProcesses.set(row.pid, observedProcess);
  return observedProcess;
}

export function isCodexProcess(row: ProcessRow): boolean {
  return basename(row.command) === 'codex';
}

/** A live npm gateway may predate the current global launcher. Match its
 * installed platform package and the owning Botmux package, not just its name. */
function isInstalledBotmuxBinary(executable: string): boolean {
  if (basename(executable) !== 'botmux') return false;
  const platformDir = dirname(executable);
  const packageName = basename(platformDir);
  if (!/^botmux-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?)$/.test(packageName)
      || basename(dirname(platformDir)) !== 'node_modules') return false;
  const binaryPackage = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'));
  const ownerPackage = JSON.parse(readFileSync(join(dirname(dirname(platformDir)), 'package.json'), 'utf8'));
  return binaryPackage.name === packageName && typeof binaryPackage.version === 'string'
    && ownerPackage.name === 'botmux' && ownerPackage.version === binaryPackage.version
    && ownerPackage.optionalDependencies?.[packageName] === binaryPackage.version;
}

/** Only known, stateless leaf helpers may be replaced with the idle CLI.
 * A generic node process, user MCP, REPL or helper with children is unknown. */
export function isRestartableCodexHelper(
  row: ProcessRow, tree: readonly ProcessRow[], running: readonly CodexProcess[], gatewayCommand: string,
): boolean {
  if (!running.some(parent => parent.pid === row.ppid)
      || tree.some(child => child.ppid === row.pid)) return false;
  const started = readProcessStartIdentity(row.pid);
  if (!started) return false;
  const argv = readCmdline(row.pid);
  let known = false;
  try {
    const executable = realpathSync(process.platform === 'linux' ? `/proc/${row.pid}/exe` : row.command);
    if (argv.length === 1 && running.some(parent => parent.pid === row.ppid
        && executable === join(dirname(parent.path), 'codex-code-mode-host'))) {
      known = true;
    } else if (argv.length === 3 && argv[1] === 'mcp' && argv[2] === 'serve') {
      const gateway = realpathSync(gatewayCommand);
      known = executable === gateway;
      // Standalone installs use this exact two-line launcher. Inspect only a
      // small wrapper, never read a compiled binary's entire payload or run sh.
      if (!known && statSync(gateway).size <= 16_384) {
        const target = /^#!\/bin\/sh\nexec "(\/[^"\\$`\r\n]+)" "\$@"\n?$/.exec(readFileSync(gateway, 'utf8'))?.[1];
        known = !!target && executable === realpathSync(target);
      }
      if (!known) known = isInstalledBotmuxBinary(executable);
    } else if (argv.length === 4 && basename(executable) === 'node'
        && argv[2] === 'mcp' && argv[3] === 'serve') {
      const script = parseWrapperCliEntry(readFileSync(gatewayCommand, 'utf8'));
      known = !!script && realpathSync(argv[1]!) === realpathSync(script);
    }
  } catch {
    // No identity evidence means the helper is not eligible for replacement.
    return false;
  }
  return known && readProcessStartIdentity(row.pid) === started;
}

export function upgradeRequired(installed: CodexExecutable, running: readonly CodexProcess[]): boolean {
  return running.length > 0
    && !running.some(current => isNewerVersion(current.version, installed.version))
    && running.some(current => isNewerVersion(installed.version, current.version));
}

/** Native goals can resume themselves without Botmux submitting a prompt.
 * Until their quiescence can be proven over every supported TUI protocol,
 * leave these sessions running. Do not infer completion from screen silence. */
export async function hasCodexAutonomousGoal(path: string): Promise<boolean> {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      const payload = entry.payload;
      if (!payload) continue;
      if (entry.type === 'event_msg' && typeof payload.type === 'string' && /goal/i.test(payload.type)) return true;
      if (entry.type === 'response_item' && payload.type === 'function_call'
          && typeof payload.name === 'string' && /(?:create_goal|goal[./]set)$/.test(payload.name)) return true;
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function waitForCodexExit(processes: readonly CodexProcess[], timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const alive = processes.filter(item => {
      try { process.kill(item.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
      const started = readProcessStartIdentity(item.pid);
      if (!started) throw new Error('Unable to confirm retired Codex process identity');
      return started === item.started;
    });
    if (!alive.length) return;
    if (Date.now() >= deadline) throw new Error('Old Codex process is still alive; replacement was not started');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export type CodexUpgradeState = 'current' | 'waiting' | 'upgrading' | 'failed';

/** Serializes observations. The worker owns the input queues throughout a swap. */
export class CodexSessionUpgradeMonitor {
  private inFlight = false;
  private lastStatus = '';
  constructor(private readonly deps: {
    enabled: () => boolean;
    check: () => Promise<{ target: CodexExecutable; running: CodexProcess[] } | undefined>;
    blocked: () => string | undefined;
    upgrade: (target: CodexExecutable, running: CodexProcess[]) => Promise<void>;
    report: (state: CodexUpgradeState, reason: string) => void;
  }) {}

  private report(state: CodexUpgradeState, reason: string): void {
    const key = `${state}:${reason}`;
    if (this.lastStatus === key) return;
    this.lastStatus = key;
    this.deps.report(state, reason);
  }

  async tick(): Promise<void> {
    if (this.inFlight || !this.deps.enabled()) return;
    this.inFlight = true;
    try {
      const snapshot = await this.deps.check();
      if (!snapshot || !this.deps.enabled()) return;
      if (!upgradeRequired(snapshot.target, snapshot.running)) return;
      const reason = this.deps.blocked();
      if (reason) { this.report('waiting', reason); return; }
      this.report('upgrading', snapshot.target.version);
      await this.deps.upgrade(snapshot.target, snapshot.running);
      this.report('current', snapshot.target.version);
    } catch (error) {
      this.report('failed', error instanceof Error ? error.message : String(error));
    } finally {
      this.inFlight = false;
    }
  }
}
