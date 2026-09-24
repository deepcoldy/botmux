import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killFixturePid, readPidFile, waitForPidFile } from './helpers/pid-file.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pid-file-test-')); file = join(dir, 'child.pid'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PID fixture readiness', () => {
  it('waits through file creation and partial writes before returning a PID', async () => {
    const pending = waitForPidFile(file);
    writeFileSync(file, '');
    expect(readPidFile(file)).toBeUndefined();
    writeFileSync(file, '234');
    expect(readPidFile(file)).toBeUndefined();
    const timer = setTimeout(() => writeFileSync(file, '23456\n'), 40);
    try { expect(await pending).toBe(23456); }
    finally { clearTimeout(timer); }
  });
  it.each(['', '0\n', '-1\n', '1\n', '234', '2.5\n', 'NaN\n', '9007199254740992\n', '123\n456\n'])('rejects unsafe or incomplete PID %j', async value => {
    writeFileSync(file, value);
    expect(readPidFile(file)).toBeUndefined();
    await expect(waitForPidFile(file, 0)).rejects.toThrow('Timed out');
  });
  it('handles a file that has not yet been created', async () => {
    expect(readPidFile(file)).toBeUndefined();
    await expect(waitForPidFile(file, 0)).rejects.toThrow('Timed out');
  });

  it.each([0, 1, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'never signals an unsafe fixture PID %s',
    pid => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        expect(killFixturePid(pid)).toBe(false);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    },
  );
});
