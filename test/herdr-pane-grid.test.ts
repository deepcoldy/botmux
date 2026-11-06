/**
 * Unit tests for the Herdr pane PTY grid probe.
 *
 * Herdr's CLI reports no terminal width, so adopt reads the pane PTY window
 * size: `pane process-info` → `ps -o tty=` → `stty <device> size`.
 *
 * Run:  bunx vitest run test/herdr-pane-grid.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  herdrPaneGrid,
  herdrPaneTerminalDevice,
  parseSttySize,
  readTerminalDeviceGrid,
  terminalDeviceFromPsTty,
} from '../src/utils/herdr-pane-grid.js';

const mockedExecFileSync = vi.mocked(execFileSync);

function processInfo(info: Record<string, unknown>) {
  return { result: { process_info: info } };
}

beforeEach(() => {
  mockedExecFileSync.mockReset();
});

describe('parseSttySize', () => {
  it('reads "<rows> <cols>"', () => {
    expect(parseSttySize('58 213\n')).toEqual({ cols: 213, rows: 58 });
  });

  it('rejects a never-sized PTY and malformed output', () => {
    expect(parseSttySize('0 0\n')).toBeNull();
    expect(parseSttySize('')).toBeNull();
    expect(parseSttySize('stty: /dev/pts/9: No such file')).toBeNull();
    expect(parseSttySize('58\n')).toBeNull();
  });
});

describe('terminalDeviceFromPsTty', () => {
  it('maps Linux and macOS names under /dev', () => {
    expect(terminalDeviceFromPsTty('pts/263\n')).toBe('/dev/pts/263');
    expect(terminalDeviceFromPsTty(' ttys003')).toBe('/dev/ttys003');
  });

  it('rejects processes without a terminal and path escapes', () => {
    expect(terminalDeviceFromPsTty('?')).toBeNull();
    expect(terminalDeviceFromPsTty('??')).toBeNull();
    expect(terminalDeviceFromPsTty('')).toBeNull();
    expect(terminalDeviceFromPsTty('pts/../sda')).toBeNull();
    expect(terminalDeviceFromPsTty('/etc/passwd')).toBeNull();
  });
});

describe('readTerminalDeviceGrid', () => {
  it('uses GNU stty -F on Linux and BSD stty -f elsewhere', () => {
    mockedExecFileSync.mockReturnValue('40 120\n' as any);

    expect(readTerminalDeviceGrid('/dev/pts/3', 'linux')).toEqual({ cols: 120, rows: 40 });
    expect(mockedExecFileSync).toHaveBeenLastCalledWith('stty', ['-F', '/dev/pts/3', 'size'], expect.anything());

    expect(readTerminalDeviceGrid('/dev/ttys003', 'darwin')).toEqual({ cols: 120, rows: 40 });
    expect(mockedExecFileSync).toHaveBeenLastCalledWith('stty', ['-f', '/dev/ttys003', 'size'], expect.anything());
  });

  it('returns null when stty fails', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readTerminalDeviceGrid('/dev/pts/3', 'linux')).toBeNull();
  });
});

describe('herdrPaneTerminalDevice / herdrPaneGrid', () => {
  it('resolves the pane PTY through the shell pid', () => {
    mockedExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'ps') return args.at(-1) === '4242' ? 'pts/263\n' : '?\n';
      if (cmd === 'stty') return args[1] === '/dev/pts/263' ? '58 213\n' : '';
      throw new Error(`unexpected ${cmd}`);
    }) as any);
    const raw = processInfo({ shell_pid: 4242, foreground_processes: [{ pid: 5151 }] });

    expect(herdrPaneTerminalDevice(raw)).toBe('/dev/pts/263');
    expect(herdrPaneGrid(raw)).toEqual({ cols: 213, rows: 58 });
  });

  it('falls back to a foreground process when the shell pid has no terminal', () => {
    mockedExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'ps') return args.at(-1) === '5151' ? 'pts/7\n' : '?\n';
      throw new Error(`unexpected ${cmd}`);
    }) as any);

    expect(herdrPaneTerminalDevice(processInfo({ shell_pid: 4242, foreground_processes: [{ pid: 5151 }] })))
      .toBe('/dev/pts/7');
  });

  it('never probes invalid pids or missing process info', () => {
    expect(herdrPaneTerminalDevice(undefined)).toBeNull();
    expect(herdrPaneTerminalDevice(processInfo({ shell_pid: 1, foreground_processes: [{ pid: 'x' }] }))).toBeNull();
    expect(herdrPaneGrid({ result: {} })).toBeNull();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
