import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { enumerateScratchSecretPaths } from '../src/adapters/backend/scratch-credentials.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scratch-cred-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const home = () => join(root, 'home');
const data = () => join(home(), 'data');
const app = 'app1';

function layout() {
  mkdirSync(join(home(), 'bots', app), { recursive: true });
  mkdirSync(data(), { recursive: true });
  writeFileSync(join(home(), 'bots.json'), '[]');
  writeFileSync(`${join(home(), 'bots.json')}.bak-2`, '[]');
  writeFileSync(join(home(), '.dashboard-secret'), 's');
  writeFileSync(join(home(), 'bots', app, 'send-cred.json'), '{}');
  writeFileSync(join(data(), 'webhook-master.key'), 'k');
  writeFileSync(join(data(), 'webhook-secrets.json'), '{}');
  // non-secret siblings that must NOT be blanket-enumerated
  mkdirSync(join(home(), 'bin'), { recursive: true });
  writeFileSync(join(home(), 'bin', 'botmux'), '#!/bin/sh');
  mkdirSync(join(data(), 'schedules'), { recursive: true });
}

describe('enumerateScratchSecretPaths', () => {
  it('enumerates all transport-credential classes but not ordinary dirs/files', () => {
    layout();
    const got = new Set(enumerateScratchSecretPaths({
      botmuxHomes: [home()],
      dataDirs: [data()],
      botsConfigPath: join(home(), 'bots.json'),
    }));
    expect(got.has(join(home(), 'bots.json'))).toBe(true);
    expect(got.has(`${join(home(), 'bots.json')}.bak-2`)).toBe(true);
    expect(got.has(join(home(), '.dashboard-secret'))).toBe(true);
    expect(got.has(join(home(), 'bots', app, 'send-cred.json'))).toBe(true);
    expect(got.has(join(data(), 'webhook-master.key'))).toBe(true);
    expect(got.has(join(data(), 'webhook-secrets.json'))).toBe(true);
    // ordinary top-level dir/file are NOT secrets
    expect(got.has(join(home(), 'bin'))).toBe(false);
    expect(got.has(join(home(), 'bin', 'botmux'))).toBe(false);
    expect(got.has(join(data(), 'schedules'))).toBe(false);
  });

  it('adds external BOTS_CONFIG sidecar siblings outside the botmux home', () => {
    layout();
    const external = join(root, 'elsewhere', 'custom-bots.json');
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(external, '[]');
    writeFileSync(`${external}.tmp`, '[]');
    writeFileSync(join(root, 'elsewhere', 'unrelated.txt'), 'x');
    const got = enumerateScratchSecretPaths({ botmuxHomes: [home()], dataDirs: [data()], botsConfigPath: external });
    expect(got).toContain(external);
    expect(got).toContain(`${external}.tmp`);
    expect(got).not.toContain(join(root, 'elsewhere', 'unrelated.txt'));
  });

  it('skips absent paths and tolerates missing homes', () => {
    // nothing laid out
    const got = enumerateScratchSecretPaths({ botmuxHomes: [home(), join(root, 'nope')], dataDirs: [data()] });
    expect(got).toEqual([]);
  });

  it('encloses the per-bot secret without exposing the whole bots dir', () => {
    layout();
    const got = enumerateScratchSecretPaths({ botmuxHomes: [home()], dataDirs: [data()] });
    // send-cred.json exact file, not the bots/ root (other non-secret state)
    expect(got).toContain(join(home(), 'bots', app, 'send-cred.json'));
    expect(got).not.toContain(join(home(), 'bots'));
    expect(got).not.toContain(join(home(), 'bots', app));
  });
});
