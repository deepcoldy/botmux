/**
 * Whether a process runs inside a native IM gateway's dedicated core service —
 * the core itself, its workers, or a CLI child of one of its sessions.
 *
 * The core and its workers know it from their environment (core/runtime-mode.ts
 * isNativeGatewayCoreEnv). A CLI child cannot: the native gateway mark is
 * redacted at the CLI boundary (utils/child-env.ts REDACTED_CHILD_ENV_KEYS) and
 * no new variable can be forwarded into tmux / zellij panes without changing
 * every Feishu pane's launch line. What does reach every session on every
 * backend is BOTMUX_CORE_ONLY_DATA_DIR — the core-only service's dedicated store,
 * pinned by index-core-only.ts and forwarded into panes with SESSION_DATA_DIR
 * (BOTMUX_INJECTED_ENV_KEYS; strict envPolicy keeps it too). So the core marks
 * that store on boot ({@link syncNativeGatewayDataDirMark}) and a session reads
 * the mark through the variable ({@link inNativeGatewaySession}).
 *
 * The signal cannot be present in a Feishu session (no core-only store variable
 * there) nor in a bare core-only service's session (a bare core removes the mark
 * from its store on boot and never writes it) — except for a bare core started
 * from inside a native gateway core's session onto that session's own store
 * (`botmux serve --api-only` typed there inherits that core's state dir): it
 * leaves the mark alone, or every live session of the running native core would
 * stop being recognised. Booted onto any other dir, it clears a stale mark there
 * like a boot from a plain shell. Known residual (there is no liveness
 * tracking): a bare service that restarts with its own pinned environment on a
 * dir that is still marked keeps that mark.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/** File a native gateway core keeps in its dedicated store directory. */
export const NATIVE_GATEWAY_DATA_DIR_MARK = '.native-gateway-core';

/** realpath, also for a dir that does not exist yet: its nearest existing ancestor is resolved. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/**
 * Called by the core-only entry for its store: a native gateway core marks it; any
 * other core-only service clears a stale mark — unless `inherited`, the
 * environment the service was started with, says it was started from inside a
 * native gateway session on this very dir, whose mark is not its to remove.
 */
export function syncNativeGatewayDataDirMark(dataDir: string, nativeGateway: boolean, inherited?: NodeJS.ProcessEnv): void {
  const mark = join(dataDir, NATIVE_GATEWAY_DATA_DIR_MARK);
  try {
    if (nativeGateway) {
      mkdirSync(dataDir, { recursive: true });
      atomicWriteFileSync(mark, '{"schemaVersion":1}\n');
      return;
    }
    const sessionDir = inherited?.BOTMUX_CORE_ONLY_DATA_DIR?.trim();
    const sameSessionStore = !!sessionDir && inNativeGatewaySession(inherited!)
      && canonicalPath(sessionDir) === canonicalPath(dataDir);
    if (!sameSessionStore) rmSync(mark, { force: true });
  } catch { /* an unwritable store fails the daemon itself, loudly */ }
}

/** True in a native gateway core service's processes, its CLI sessions included. */
export function inNativeGatewaySession(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.BOTMUX_CORE_ONLY_DATA_DIR?.trim();
  return !!dir && existsSync(join(dir, NATIVE_GATEWAY_DATA_DIR_MARK));
}
