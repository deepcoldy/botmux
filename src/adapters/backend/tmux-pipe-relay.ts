/**
 * The shell command `pipe-pane` runs to copy a pane's output into the
 * backend's FIFO.
 *
 * The copier must write every short read at once: a quiet CLI's ready prompt
 * or final marker is often the last thing it prints, and the worker holds the
 * next input until it has seen those bytes. Measured with a socketpair stdin
 * and a FIFO stdout, as tmux sets it up, no coreutils tool does this across
 * uutils releases:
 *   - `cat`: GNU and uutils 0.2-0.7 write immediately; uutils 0.8.0 holds
 *     everything until EOF, with or without `-u`. BusyBox holds short writes
 *     until EOF as well when stdin is a socket (measured v1.35.0) — the
 *     pipe-pane child's stdin is one.
 *   - `dd bs=N`: GNU and uutils 0.6-0.8 write immediately; uutils 0.2-0.5
 *     hold every short read after the first.
 * A uutils or BusyBox `cat` is replaced by a copy loop in botmux's own
 * runtime, which no coreutils release can change; every other `cat` keeps
 * running exactly as before. Only those hosts pay for the larger process
 * (about 15-45 MB resident, against 1 MB for `cat`).
 */
import { isStandaloneBinary } from '../../core/self-spawn.js';

/** How to run a JavaScript snippet with the runtime executing this process. */
interface PipeRelayRuntime {
  execPath: string;
  /** Exported before exec: makes the executable act as a plain runtime. */
  env: Readonly<Record<string, string>>;
  /** Placed before `-e`. */
  flags: readonly string[];
}

/** Bun would otherwise load `.env*` and bunfig.toml (whose `preload` runs
 *  code). The relay runs outside any sandbox, so the pane's working directory
 *  must not configure it; the command also starts it in `/`. */
const BUN_ISOLATION_FLAGS = ['--no-env-file', '--config=/dev/null'] as const;

/** Forward each chunk as it arrives. Ends on EOF (tmux closed the pipe); once
 *  the FIFO reader is gone the unhandled EPIPE ends it, as SIGPIPE ends `cat`. */
const RELAY_SCRIPT = 'process.stdin.pipe(process.stdout)';

function currentPipeRelayRuntime(): PipeRelayRuntime {
  const execPath = process.execPath;
  // A compiled botmux binary contains Bun; BUN_BE_BUN skips the botmux CLI.
  if (isStandaloneBinary()) return { execPath, env: { BUN_BE_BUN: '1' }, flags: BUN_ISOLATION_FLAGS };
  if (process.versions.bun) return { execPath, env: {}, flags: BUN_ISOLATION_FLAGS };
  if (process.versions.electron) return { execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, flags: [] };
  return { execPath, env: {}, flags: [] };
}

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The `pipe-pane` shell-command argument, ready for tmux. */
export function pipePaneShellCommand(fifoPath: string): string {
  const runtime = currentPipeRelayRuntime();
  const relay = [
    'cd /',
    'unset NODE_OPTIONS BUN_OPTIONS',
    ...Object.entries(runtime.env).map(([key, value]) => `export ${key}=${shq(value)}`),
    `exec ${[runtime.execPath, ...runtime.flags, '-e', RELAY_SCRIPT].map(shq).join(' ')}`,
  ].join(' && ');
  // Ask the `cat` this shell resolves: it is the one that would run. stdin is
  // redirected so a cat that ignored --version could not consume pane output.
  // busybox answers --version with a banner on STDERR and exit 1, so stderr is
  // folded in — otherwise Alpine/musl hosts fall through to a `cat` that holds
  // short writes exactly like uutils 0.8.0 (measured on BusyBox v1.35.0). Its
  // banner text is locale-independent.
  const command = `exec >${shq(fifoPath)} 2>/dev/null; case "$(cat --version </dev/null 2>&1)" in *uutils*|*BusyBox*) ${relay};; *) exec cat;; esac`;
  // tmux expands the argument as a format and strftime string before running it.
  return command.replace(/[#%]/g, '$&$&');
}
