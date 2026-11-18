/**
 * A small model of what a tmux server ANSWERS, for unit tests that mock
 * `node:child_process`. Commands are answered from the pane's state by
 * expanding the format string the code under test sent (so the answer does
 * not depend on how many commands, which format or which API — sync
 * `execFileSync` or async `execFile` — the code uses), with the semantics
 * measured on real tmux 2.8 / 3.3a / 3.6a:
 *
 *  - a live pane: `#{pane_id}`=%1, `#{pane_dead}`=0;
 *  - a corpse kept by remain-on-exit: still has `#{pane_id}`, `#{pane_dead}`=1
 *    and `#{pane_dead_status}` = its code ('' while unpublished / signal);
 *  - a vanished pane: tmux 3.x display-message exits 0 with every pane field
 *    empty (only server fields such as `#{pid}` expand); writes to it fail
 *    "can't find pane";
 *  - `failAll`: every command fails the same way (server-level conditions —
 *    connection refused, no server running, deadline, spawn failure);
 *  - a batch (`a ; b ; c`) runs in order and stops at the first failure;
 *    `if-shell -F -t T <format> <then> <else>` evaluates the format against
 *    the pane and runs one branch (tmux-quoted words);
 *  - paste-buffer into a corpse crashes the server, as measured on tmux 2.8
 *    and 3.3a (`serverCrashed`; every later command reads "no server running").
 *
 * `execFileSync` failures throw in the shape execFileSync throws; `execFile`
 * failures reach the callback in the shape execFile reports (a deadline kill
 * sets `killed`, an exit puts the status in a numeric `code`), both measured on
 * Node 24 and Bun 1.4.4. Async answers arrive on a microtask, like a real
 * child's exit arrives on a later turn of the loop.
 */
import type { execFile, execFileSync } from 'node:child_process';
import type { Mock } from 'vitest';

export type TmuxFailure =
  | { kind: 'exit'; status: number; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'spawn'; code: string };

export const CONNECTION_REFUSED: TmuxFailure = {
  kind: 'exit', status: 1, stderr: 'error connecting to /tmp/tmux-0/botmux (Connection refused)',
};
export const LOST_SERVER: TmuxFailure = { kind: 'exit', status: 1, stderr: 'lost server' };
export const NO_SERVER: TmuxFailure = { kind: 'exit', status: 1, stderr: 'no server running on /tmp/tmux-0/botmux' };
export const DEADLINE: TmuxFailure = { kind: 'timeout' };
export const EMFILE: TmuxFailure = { kind: 'spawn', code: 'EMFILE' };

export type PaneState = 'alive' | 'gone' | { dead: string };

export interface TmuxWorld {
  pane: PaneState;
  /** When set, every command (except `-V`) fails this way. */
  failAll?: TmuxFailure;
  /** Per-command override: a failure, a literal stdout, or undefined (default). */
  override?: (args: string[], via: 'sync' | 'async') => TmuxFailure | string | undefined;
  inCopyMode?: boolean;
  serverPid: string;
  /** Async calls are parked here instead of answered while `holdAsync` is set. */
  holdAsync?: boolean;
  held: Array<() => void>;
  /** Set once a paste-buffer hit a corpse (tmux <= 3.3a kills its server). */
  serverCrashed: boolean;
  /** Text-free record of each paste-buffer that reached a live pane. */
  pastes: string[][];
  syncCalls: string[][];
  asyncCalls: string[][];
}

const PANE_ID = '%1';
const PANE_PID = '4242';

function paneFields(world: TmuxWorld): Record<string, string> {
  const server = { pid: world.serverPid, session_id: '$0' };
  if (world.pane === 'gone') return server;
  const dead = typeof world.pane === 'object';
  return {
    ...server,
    pane_id: PANE_ID,
    pane_pid: PANE_PID,
    pane_dead: dead ? '1' : '0',
    pane_dead_status: dead ? (world.pane as { dead: string }).dead : '',
    pane_in_mode: world.inCopyMode ? '1' : '0',
    alternate_on: '0',
  };
}

function expand(format: string, fields: Record<string, string>): string {
  return format.replace(/#\{([a-z_]+)\}/g, (_, key: string) => fields[key] ?? '');
}

/** Words of a tmux-quoted command string (an if-shell branch). */
function tmuxWords(command: string): string[] {
  return [...command.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)]
    .map(m => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]));
}

/** The world's answer to one tmux argv (socket args included or not). */
export function answerTmux(world: TmuxWorld, rawArgs: readonly string[], via: 'sync' | 'async'): string | TmuxFailure {
  const args = rawArgs[0] === '-L' || rawArgs[0] === '-S' ? rawArgs.slice(2) : [...rawArgs];
  if (args[0] === '-V') return 'tmux 3.3a';
  const overridden = world.override?.(args, via);
  if (overridden !== undefined) return overridden;
  if (world.serverCrashed) return { kind: 'exit', status: 1, stderr: 'no server running on /tmp/tmux-0/botmux' };
  if (world.failAll) return world.failAll;
  let printed = '';
  for (let start = 0; start <= args.length;) {
    let end = args.indexOf(';', start);
    if (end < 0) end = args.length;
    const answer = answerOne(world, args.slice(start, end));
    if (typeof answer !== 'string') return answer;
    printed += answer;
    start = end + 1;
  }
  return printed;
}

function answerOne(world: TmuxWorld, args: string[]): string | TmuxFailure {
  const fields = paneFields(world);
  if (args[0] === 'if-shell' && args[1] === '-F') {
    const rest = args[2] === '-t' ? args.slice(4) : args.slice(2);
    const truthy = !['', '0'].includes(expand(rest[0], fields));
    return answerOne(world, tmuxWords(truthy ? rest[1] : rest[2] ?? ''));
  }
  if (args[0] === 'paste-buffer') {
    if (world.pane === 'gone') return { kind: 'exit', status: 1, stderr: `can't find pane: ${args[args.indexOf('-t') + 1]}` };
    if (typeof world.pane === 'object') {
      world.serverCrashed = true;
      return { kind: 'exit', status: 1, stderr: 'server exited unexpectedly' };
    }
    world.pastes.push(args);
    return '';
  }
  if (args.includes('display-message')) return `${expand(String(args.at(-1)), fields)}\n`;
  if (args[0] === 'list-sessions') {
    const f = args.indexOf('-F');
    return f >= 0 ? `${expand(args[f + 1], fields)}\n` : 'bmx: 1 windows\n';
  }
  if (args[0] === 'send-keys' && world.pane === 'gone') {
    const target = args[args.indexOf('-t') + 1] ?? '';
    return { kind: 'exit', status: 1, stderr: `can't find pane: ${target}` };
  }
  return '';
}

function syncError(failure: TmuxFailure): Error {
  if (failure.kind === 'timeout') {
    return Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: '' });
  }
  if (failure.kind === 'spawn') {
    return Object.assign(new Error(`spawnSync tmux ${failure.code}`), { code: failure.code, status: null, signal: null });
  }
  return Object.assign(new Error(`Command failed: tmux\n${failure.stderr}`), {
    status: failure.status, signal: null, stderr: Buffer.from(failure.stderr),
  });
}

function asyncError(failure: TmuxFailure): { error: Error; stderr: string } {
  if (failure.kind === 'timeout') {
    return { error: Object.assign(new Error('Command failed: tmux'), { code: null, killed: true, signal: 'SIGKILL' }), stderr: '' };
  }
  if (failure.kind === 'spawn') {
    return { error: Object.assign(new Error(`spawn tmux ${failure.code}`), { code: failure.code }), stderr: '' };
  }
  return {
    error: Object.assign(new Error(`Command failed: tmux\n${failure.stderr}`), { code: failure.status, killed: false, signal: null }),
    stderr: failure.stderr,
  };
}

export function createTmuxWorld(init: Partial<Pick<TmuxWorld, 'pane' | 'serverPid' | 'inCopyMode'>> = {}): TmuxWorld {
  return { pane: 'alive', serverPid: '111', held: [], syncCalls: [], asyncCalls: [], serverCrashed: false, pastes: [], ...init };
}

/** Answer every mocked execFileSync / execFile call from `world`. */
export function installTmuxWorld(
  world: TmuxWorld,
  mocks: { execFileSync: Mock<typeof execFileSync>; execFile: Mock<typeof execFile> },
): void {
  mocks.execFileSync.mockImplementation(((_bin: string, args: string[]) => {
    world.syncCalls.push([...args]);
    const answer = answerTmux(world, args, 'sync');
    if (typeof answer !== 'string') throw syncError(answer);
    return answer as any;
  }) as typeof execFileSync);
  mocks.execFile.mockImplementation(((_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    world.asyncCalls.push([...args]);
    const deliver = () => {
      const answer = answerTmux(world, args, 'async');
      if (typeof answer === 'string') cb(null, answer, '');
      else {
        const { error, stderr } = asyncError(answer);
        cb(error, '', stderr);
      }
    };
    if (world.holdAsync) world.held.push(deliver);
    else queueMicrotask(deliver);
    return {} as any;
  }) as unknown as typeof execFile);
}

/** The display-message calls whose format reads pane liveness (the lifecycle /
 *  guard probe — old shape `#{pane_id}`, new shape `#{pane_id}:…`). */
export function isLivenessRead(args: readonly string[]): boolean {
  return args.includes('display-message') && String(args.at(-1)).startsWith('#{pane_id}');
}
