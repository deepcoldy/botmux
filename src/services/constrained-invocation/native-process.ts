import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** A POSIX owner guard for native CLIs that keep running after stdin EOF.
 * The shell is the process-group leader, so cancellation and owner death have
 * exactly the same target. No user text is interpolated into shell source.
 * Unlike a Node script path, this also works in a compiled Botmux binary. */
const OWNER_GUARD = `
owner=$1
born=$2
ps_bin=$3
shift 3
exec 3<&0
(
  exec 3<&-
  trap 'exit 0' TERM INT
  while [ "$(LC_ALL=C "$ps_bin" -o lstart= -p "$owner" 2>/dev/null)" = "$born" ]; do
    sleep 0.5
  done
  trap '' TERM INT
  kill -TERM -$$ 2>/dev/null
  sleep 1
  kill -KILL -$$ 2>/dev/null
) </dev/null >/dev/null 2>&1 &
guard=$!
"$@" <&3 3<&- &
native=$!
exec 3<&-
wait "$native"
status=$?
kill -TERM "$guard" 2>/dev/null
wait "$guard" 2>/dev/null
exit "$status"
`;

export function spawnOwnedModelProcess(executable: string, args: readonly string[], runtime: { cwd: string; env: NodeJS.ProcessEnv }) {
  const ps = ['/bin/ps', '/usr/bin/ps'].find(path => existsSync(path));
  if (!ps || !['darwin', 'linux'].includes(process.platform)) throw new Error('native_owner_guard_unsupported');
  const born = execFileSync(ps, ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
  }).replace(/\n$/, '');
  if (!born.trim()) throw new Error('native_owner_identity_unknown');
  return spawn('/bin/sh', ['-c', OWNER_GUARD, 'botmux-model-only', String(process.pid), born, ps, executable, ...args], {
    cwd: runtime.cwd, env: runtime.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
}
