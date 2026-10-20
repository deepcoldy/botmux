import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';

export interface HerdrPaneGrid {
  cols: number;
  rows: number;
}

const PROBE_EXEC_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 2000,
};

/**
 * Herdr's CLI exposes no terminal width: `pane layout` reports the layout rect
 * (borders included, and not yet applied to the PTY while no Herdr client is
 * attached), and `pane get` only reports `scroll.viewport_rows`. The grid the
 * CLI actually renders into is the pane PTY's window size, so read that from
 * the device shared by every process in the pane.
 */
export function herdrPaneTerminalDevice(rawProcessInfo: unknown): string | null {
  const info = (rawProcessInfo as any)?.result?.process_info;
  const foreground = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
  const pids = [info?.shell_pid, ...foreground.map((proc: any) => proc?.pid)];
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const device = controllingTerminalDevice(pid);
    if (device) return device;
  }
  return null;
}

/** Read the PTY window size of one Herdr pane from its `pane process-info` JSON. */
export function herdrPaneGrid(rawProcessInfo: unknown): HerdrPaneGrid | null {
  const device = herdrPaneTerminalDevice(rawProcessInfo);
  return device ? readTerminalDeviceGrid(device) : null;
}

/** `ps -o tty=` names the terminal relative to /dev (`pts/3` on Linux,
 *  `ttys003` on macOS) and prints `?`/`??` for a process without one. */
export function terminalDeviceFromPsTty(name: string): string | null {
  const tty = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(tty) || tty.split('/').includes('..')) return null;
  return `/dev/${tty}`;
}

/** `stty size` prints `<rows> <cols>`; a PTY whose size was never set reports 0 0. */
export function parseSttySize(output: string): HerdrPaneGrid | null {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output);
  if (!match) return null;
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  return rows > 0 && cols > 0 ? { cols, rows } : null;
}

export function controllingTerminalDevice(pid: number): string | null {
  try {
    return terminalDeviceFromPsTty(execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], PROBE_EXEC_OPTIONS));
  } catch {
    return null;
  }
}

/** Query-only: `stty <device> size` never changes the terminal's settings. */
export function readTerminalDeviceGrid(
  device: string,
  platform: NodeJS.Platform = process.platform,
): HerdrPaneGrid | null {
  try {
    // GNU/BusyBox stty take the device as -F; BSD/macOS stty as -f.
    const deviceFlag = platform === 'linux' ? '-F' : '-f';
    return parseSttySize(execFileSync('stty', [deviceFlag, device, 'size'], PROBE_EXEC_OPTIONS));
  } catch {
    return null;
  }
}
