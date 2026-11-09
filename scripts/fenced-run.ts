#!/usr/bin/env bun
/**
 * Run an ad-hoc probe / mutation harness / one-off script behind the same
 * fences the test runners use:
 *
 *   bun scripts/fenced-run.ts [--keep-user-bus] -- <command> [args...]
 *   e.g. bun scripts/fenced-run.ts -- bun /tmp/my-probe.ts
 *        bun scripts/fenced-run.ts -- npx vitest run --config /tmp/my.config.ts
 *
 * WHY: vitest.config.ts and bunfig.toml fence HOME and tmux for `vitest` /
 * `bun test`, but a probe started with `bun /tmp/probe.ts`, or a hand-written
 * vitest config without the repo's setupFiles, has NO fence. On 2026-11-06 two
 * such probes reached live state: one called enableAutostart() without a
 * redirected HOME and rewrote the real ~/.config/systemd/user/botmux*.service
 * (ExecStart=/opt/botmux, the crash watchdog then failed every 30s for 5h), and
 * a mutation harness used a custom vitest config that dropped every fence.
 *
 * What the child gets (the command is spawned fresh, so even Bun — whose
 * os.homedir() is frozen at process start — sees the fenced home):
 *   - HOME / USERPROFILE → a new temp home, plus the same CLI-home / XDG
 *     rewrites as the unit fence (test/helpers/fence-home-env.ts);
 *   - SESSION_DATA_DIR / BOTMUX_MOJO_WORKSPACE_ROOT → under the temp home, and
 *     inherited session-turn markers + the live daemon's IPC port + the turn
 *     cli-identity binding are scrubbed (scrubSessionTurnMarkerEnv);
 *   - TMUX_TMPDIR → a private existing directory, TMUX/TMUX_PANE dropped, and
 *     the tmux shim first on PATH that refuses any host socket (including the
 *     fleet's `-L botmux`); any refusal fails this run with exit 3;
 *   - unless --keep-user-bus: no XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS,
 *     so `systemctl --user` / `busctl --user` cannot touch the real user
 *     manager (enable/stop units, stop a live session scope). botmux's own
 *     scope code sees BOTMUX_FENCED_RUN=1 (kept through strict envPolicy too)
 *     and uses only the bus variables it is given, never deriving
 *     /run/user/<uid>/bus (userSystemdBusEnv), so it takes the no-bus path too.
 *     With --keep-user-bus the child gets the invoker's bus variables, or the
 *     bus botmux would derive when the invoker exported none.
 *
 * Not covered: absolute paths the command hard-codes (e.g. /root/...), and
 * tmux invoked by absolute path. Pass paths through HOME in your probe.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenceHomeRootedEnv } from '../test/helpers/fence-home-env.js';
import {
  applyTmuxFenceEnv,
  createTmuxFence,
  readTmuxFenceDenials,
  teardownTmuxFence,
  tmuxFenceDenialError,
} from '../test/helpers/tmux-fence.js';
import { scrubSessionTurnMarkerEnv } from '../src/utils/child-env.js';
import { userSystemdBusEnv } from '../src/core/session-scope.js';

export const FENCE_DENIED_EXIT = 3;

export function parseFencedRunArgs(argv: readonly string[]): { keepUserBus: boolean; command: string[] } | { error: string } {
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? [] : argv.slice(0, sep);
  const command = sep === -1 ? [...argv] : argv.slice(sep + 1);
  const unknown = flags.filter(flag => flag !== '--keep-user-bus');
  if (unknown.length > 0) return { error: `unknown option(s): ${unknown.join(' ')}` };
  if (command.length === 0) return { error: 'usage: bun scripts/fenced-run.ts [--keep-user-bus] -- <command> [args...]' };
  return { keepUserBus: flags.includes('--keep-user-bus'), command };
}

/** Build the child environment. Pure apart from creating the fence dirs. */
export function fencedRunEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  fence: ReturnType<typeof createTmuxFence>,
  opts: { keepUserBus: boolean; isBusSocket?: (path: string) => boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;
  fenceHomeRootedEnv(home, env);
  applyTmuxFenceEnv(fence, env);
  // config.session.dataDir honours SESSION_DATA_DIR BEFORE the HOME-derived
  // fallback, so a redirected HOME alone does not keep a probe out of the live
  // fleet's data dir. BOTMUX_MOJO_WORKSPACE_ROOT is the same shape for mojo.
  // Both mirror what test/unit-setup.ts / test/bun-test-fence.ts do.
  env.SESSION_DATA_DIR = join(home, '.botmux', 'data');
  env.BOTMUX_MOJO_WORKSPACE_ROOT = join(home, 'mojo-workspaces');
  // Drop per-session identity/capability injected by the daemon that spawned
  // this shell: turn/chat markers, the live daemon's IPC port, the turn cli
  // identity binding. Without this a probe can talk to the real daemon / act
  // as this session even with a fenced HOME.
  scrubSessionTurnMarkerEnv(env);
  if (!opts.keepUserBus) {
    delete env.XDG_RUNTIME_DIR;
    delete env.DBUS_SESSION_BUS_ADDRESS;
  } else if (!env.XDG_RUNTIME_DIR && !env.DBUS_SESSION_BUS_ADDRESS) {
    // Behind BOTMUX_FENCED_RUN botmux uses these variables as given and derives nothing.
    Object.assign(env, userSystemdBusEnv({ env: base, isSocket: opts.isBusSocket }));
  }
  env.BOTMUX_FENCED_RUN = '1';
  return env;
}

function main(): number {
  const parsed = parseFencedRunArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`fenced-run: ${parsed.error}`);
    return 2;
  }
  const home = mkdtempSync(join(tmpdir(), 'bmx-fenced-home-'));
  // Host socket dirs are detected from the INVOKING env, before it is fenced.
  const fence = createTmuxFence(process.env);
  let status = 1;
  try {
    const env = fencedRunEnv(process.env, home, fence, parsed);
    const [cmd, ...args] = parsed.command;
    const child = spawnSync(cmd!, args, { stdio: 'inherit', env });
    if (child.error) {
      console.error(`fenced-run: failed to start ${cmd}: ${child.error.message}`);
      status = 127;
    } else {
      status = child.status ?? 1;
    }
    const denials = readTmuxFenceDenials(fence);
    if (denials.length > 0) {
      console.error(`fenced-run: ${tmuxFenceDenialError(denials).message}`);
      status = FENCE_DENIED_EXIT;
    }
  } finally {
    teardownTmuxFence(fence);
    rmSync(home, { recursive: true, force: true });
  }
  return status;
}

if (import.meta.main) process.exit(main());
