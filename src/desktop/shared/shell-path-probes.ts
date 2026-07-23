import { basename } from 'node:path';

export interface ShellPathProbe {
  /** Absolute path of the shell binary to spawn. */
  shell: string;
  /** `-ic` sources .zshrc/.bashrc; `-lc` sources .zprofile/.bash_profile. */
  flags: '-ic' | '-lc';
}

/**
 * Shell probe ladder for PATH / binary discovery when botmux was launched from
 * the macOS GUI (Finder/Dock) instead of a terminal.
 *
 * GUI-launched apps inherit launchd's minimal PATH, so the desktop app asks the
 * user's shell for the real one. A single `zsh -lc` is not enough:
 *  - `-lc` (login, non-interactive) sources .zprofile but NOT .zshrc — nvm/fnm
 *    and many CLI installers edit only the rc file;
 *  - users whose login shell is bash never had .bash_profile/.bashrc read at all.
 *
 * The ladder probes the user's own `$SHELL` (when it is zsh or bash) before the
 * macOS default /bin/zsh, and probes `-ic` before `-lc`: a real terminal runs a
 * login+interactive shell where rc-file prepends (nvm's node dir) end up in
 * front of profile entries, so the interactive snapshot is the closer match for
 * PATH ordering. Bounded at ≤4 spawns so a slow rc cannot stall app startup.
 */
export function shellPathProbes(env: NodeJS.ProcessEnv = process.env): ShellPathProbe[] {
  const probes: ShellPathProbe[] = [];
  const seen = new Set<string>();
  const add = (shell: string, flags: ShellPathProbe['flags']) => {
    const key = `${shell} ${flags}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push({ shell, flags });
  };

  const userShell = env.SHELL?.trim();
  const shells = userShell && ['zsh', 'bash'].includes(basename(userShell))
    ? [userShell, '/bin/zsh']
    : ['/bin/zsh'];
  for (const shell of shells) {
    add(shell, '-ic');
    add(shell, '-lc');
  }
  return probes;
}
