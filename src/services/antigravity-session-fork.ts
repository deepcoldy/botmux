import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { delay } from '../utils/timing.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STREAM = new RegExp(`\\bStreaming conversation (${UUID})\\s*$`, 'i');
const FORK = new RegExp(`\\bForked conversation (${UUID}) -> (${UUID})\\s*$`, 'i');

export interface AntigravitySessionLogOptions {
  /** Dynamic host-side path resolver (e.g. fail-closed scratch view). Returning
   *  `null` indicates the isolated view is unavailable and forces fail-closed reads. */
  resolveReadPath?: () => string | null;
  /** Skip constructor `mkdirSync` when `path` is a sandbox-internal path. */
  ensureDir?: boolean;
}

/** Each managed agy gets its own native log. A global cli.log mixes sibling
 * processes, and agy keeps BOTH parent and child DBs open after /fork. */
export class AntigravitySessionLog {
  private cliPath: string;
  private readonly resolveReadPath?: () => string | null;
  private offset = 0;
  private inode: string | undefined;
  private tail = '';
  private state: { currentId?: string; fork?: { parentId: string; childId: string } } = {};

  constructor(
    sessionId: string,
    root = join(homedir(), '.gemini', 'antigravity-cli'),
    opts?: AntigravitySessionLogOptions,
  ) {
    this.cliPath = join(root, 'botmux', `${encodeURIComponent(sessionId)}.log`);
    this.resolveReadPath = opts?.resolveReadPath;
    if (opts?.ensureDir !== false && !this.resolveReadPath) {
      mkdirSync(dirname(this.cliPath), { recursive: true });
    }
  }

  get path(): string {
    return this.cliPath;
  }

  setCliPath(nextPath: string): void {
    this.cliPath = nextPath;
  }

  private currentReadPath(): string | null {
    return this.resolveReadPath ? this.resolveReadPath() : this.cliPath;
  }

  /** Ensure parent directory of the resolved host-readable log exists inside the active view. */
  ensureReadableParentDir(): boolean {
    const target = this.currentReadPath();
    if (!target) return false;
    mkdirSync(dirname(target), { recursive: true });
    return true;
  }

  /** True once `agy --log-file` has created and written to this native log. */
  hasLogFile(): boolean {
    const target = this.currentReadPath();
    if (!target) return false;
    try {
      return statSync(target).size > 0;
    } catch {
      return false;
    }
  }

  read(): Readonly<typeof this.state> {
    const target = this.currentReadPath();
    if (!target) {
      this.inode = undefined;
      this.offset = 0;
      this.tail = '';
      this.state = {};
      return this.state;
    }
    try {
      const stat = statSync(target);
      const inode = `${stat.dev}:${stat.ino}`;
      if (inode !== this.inode || stat.size < this.offset) {
        this.inode = inode;
        this.offset = Math.max(0, stat.size - 256 * 1024);
        this.tail = '';
        this.state = {};
      }
      if (stat.size === this.offset) return this.state;
      const fd = openSync(target, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size - this.offset, 256 * 1024));
        const count = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += count;
        const lines = (this.tail + buf.subarray(0, count).toString('utf8')).split('\n');
        this.tail = lines.pop() ?? '';
        for (const line of lines) {
          const stream = STREAM.exec(line);
          if (stream) this.state.currentId = stream[1]!;
          const fork = FORK.exec(line);
          if (fork) this.state.fork = { parentId: fork[1]!, childId: fork[2]! };
        }
      } finally { closeSync(fd); }
    } catch { /* Startup may not have created the native log yet. */ }
    return this.state;
  }
}

/** Run agy's native /fork inside the CHILD's own terminal and sandbox, before
 * any user input or startup command can reach the resumed parent. The exact
 * native source→child receipt plus its active stream proves the new identity;
 * an idle screen or a newly opened unrelated DB alone cannot prove a fork. */
export async function forkAntigravitySession(opts: {
  sourceId: string;
  log: AntigravitySessionLog;
  sendCommand: () => Promise<void>;
  isCurrent: () => boolean;
  isReady: () => boolean;
  timeoutMs?: number;
  now?: () => number;
}): Promise<string> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 30_000);
  let sent = false;
  while (now() < deadline) {
    if (!opts.isCurrent()) throw new Error('Antigravity fork generation was replaced');
    const state = opts.log.read();
    const fork = state.fork;
    // Also recovers a warm reattach interrupted between native fork and IPC
    // persistence: never fork an already-forked live pane a second time.
    if (fork?.parentId === opts.sourceId && fork.childId !== opts.sourceId
      && state.currentId === fork.childId && opts.isReady()) return fork.childId;
    if (!sent && state.currentId === opts.sourceId && opts.isReady()) {
      sent = true;
      await opts.sendCommand();
    }
    await delay(100);
  }
  throw new Error('Antigravity did not confirm an independent fork; parent input remains blocked');
}
