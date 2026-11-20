import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const race = vi.hoisted(() => ({
  armed: false,
  tmp: '',
  dir: '',
  moved: '',
  hostDir: '',
  savePath: '',
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync(oldPath: string, newPath: string) {
      // Deterministically schedule the attacker in the guard -> rename window.
      if (race.armed && oldPath === race.tmp && newPath === race.savePath) {
        race.armed = false;
        actual.renameSync(race.dir, race.moved);
        actual.symlinkSync(race.hostDir, race.dir, 'dir');
      }
      return actual.renameSync(oldPath, newPath);
    },
  };
});

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: mocks.request }),
  getAllBots: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-only', brand: 'feishu' } }),
  formatLarkError: String,
  LarkTransportDisabledError: class extends Error {},
}));

import * as fs from 'node:fs';
import { downloadMessageResource } from '../src/im/lark/client.js';

let root = '';
beforeEach(() => {
  vi.resetAllMocks();
  race.armed = false;
  root = fs.mkdtempSync(join(tmpdir(), 'botmux-download-fd-race-'));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('ordinary download pins its staging file to the validated directory', () => {
  it('cannot publish an external staging file when the directory changes around the final guard', async () => {
    const attachments = join(root, 'attachments');
    const dir = join(attachments, 'cli_test', 'om_x');
    const hostDir = join(root, 'host-dir');
    const savePath = join(dir, 'cli.js');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(hostDir);
    fs.writeFileSync(join(hostDir, 'cli.js'), 'HOST');

    Object.assign(race, { dir, moved: `${dir}.moved`, hostDir, savePath });
    mocks.request.mockResolvedValueOnce({
      // Old implementation: this path-based helper creates the staging file in
      // hostDir, restores the original directory, then wins guard -> rename.
      async writeFile(tmp: string) {
        race.tmp = tmp;
        fs.renameSync(dir, `${dir}.moved`);
        fs.symlinkSync(hostDir, dir, 'dir');
        fs.writeFileSync(tmp, 'EVIL', { flag: 'wx' });
        expect(fs.readFileSync(join(hostDir, basename(tmp)), 'utf8')).toBe('EVIL');
        fs.unlinkSync(dir);
        fs.renameSync(`${dir}.moved`, dir);
        race.armed = true;
      },
      // Fixed implementation: the fd is already open before this method runs.
      // Exercise the same directory swap without creating an external file.
      getReadableStream: () => {
        const temporaryName = fs.readdirSync(dir).find(name => name.startsWith('.botmux-dl-') && name.endsWith('.part'));
        expect(temporaryName).toBeDefined();
        race.tmp = join(dir, temporaryName!);
        fs.renameSync(dir, `${dir}.moved`);
        fs.symlinkSync(hostDir, dir, 'dir');
        expect(fs.readdirSync(hostDir)).toEqual(['cli.js']);
        fs.unlinkSync(dir);
        fs.renameSync(`${dir}.moved`, dir);
        race.armed = true;
        return Readable.from([Buffer.from('EVIL')]);
      },
    });

    await expect(downloadMessageResource(
      'cli_test', 'om_x', 'file_k', 'file', savePath, undefined,
      { withinRoot: attachments },
    )).rejects.toThrow();
    expect(fs.readFileSync(join(hostDir, 'cli.js'), 'utf8')).toBe('HOST');
    expect(fs.readdirSync(hostDir)).toEqual(['cli.js']);
  });
});
