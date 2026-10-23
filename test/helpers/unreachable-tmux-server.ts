import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';

/**
 * A live tmux server that nothing can reach by path: start `session` on it
 * (the default server of this file's fenced TMUX_TMPDIR, or `-L socketName`),
 * then unlink its socket file. The server and the shell keep running and the
 * kernel still binds the unlinked path — what tmpfiles cleaning /tmp under a
 * running server leaves behind. Only `stop()` (by pid) can end it.
 */
export function startUnreachableTmuxServer(session: string, socketName?: string): { stop: () => Promise<void> } {
  const args = socketName ? ['-L', socketName] : [];
  const started = spawnSync('tmux', [...args, 'new-session', '-d', '-s', session, 'sleep', '120']);
  if (started.status !== 0) throw new Error(`tmux new-session failed: ${String(started.stderr).trim()}`);
  const shown = spawnSync('tmux', [...args, 'display-message', '-p', '-t', `=${session}:`, '#{pid} #{socket_path}'], { encoding: 'utf8' });
  const [pidText, ...pathParts] = shown.stdout.trim().split(' ');
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`could not read tmux server pid: ${shown.stdout}`);
  unlinkSync(pathParts.join(' '));
  return {
    stop: async () => {
      try { process.kill(pid, 'SIGTERM'); } catch { return; }
      // Wait until the kernel releases the path binding, so a later test in
      // this file sees a server that never ran again.
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { return; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    },
  };
}
