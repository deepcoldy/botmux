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
const larkData = () => join(root, 'larkdata');
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
  // per-person OAuth user tokens (dynamic appId/openId names)
  writeFileSync(join(data(), 'user-token-cli_x-ou_person1.json'), '{}');
  writeFileSync(join(data(), 'user-token-cli_x.json'), '{}'); // legacy per-app
  writeFileSync(join(data(), 'user-token.json'), '{}');         // legacy global
  writeFileSync(join(data(), 'notes.txt'), 'not a token');      // non-secret
  // per-person secret dirs
  mkdirSync(join(data(), 'vc-meeting-daemon-auth'), { recursive: true });
  writeFileSync(join(data(), 'vc-meeting-daemon-auth', '57'), 't');
  mkdirSync(join(data(), 'bytedcli-home', 'ou_p'), { recursive: true });
  writeFileSync(join(data(), 'bytedcli-home', 'ou_p', 'login.json'), '{}');
  // trigger-user identity (#1543 layout): <sid>.bin/ wrapper dir containing
  // .data/<tool>.env + turn; another person's session sits in a sibling .bin dir.
  mkdirSync(join(data(), 'cli-identity', 'sess-1.bin', '.data'), { recursive: true });
  writeFileSync(join(data(), 'cli-identity', 'sess-1.bin', 'lark-cli'), 'x');
  writeFileSync(join(data(), 'cli-identity', 'sess-1.bin', '.data', 'lark-cli.env'), 'x');
  writeFileSync(join(data(), 'cli-identity', 'sess-1.bin', '.data', 'bytedcli.env'), 'x');
  writeFileSync(join(data(), 'cli-identity', 'sess-1.bin', '.data', 'turn'), 'x');
  mkdirSync(join(data(), 'cli-identity', 'sess-OTHER.bin', '.data'), { recursive: true });
  writeFileSync(join(data(), 'cli-identity', 'sess-OTHER.bin', '.data', 'lark-cli.env'), 'x');
  // REAL Linux lark-cli keystore: point LARKSUITE_CLI_DATA_DIR under root so
  // the test never writes into the runner's real ~/.local/share.
  mkdirSync(join(larkData(), 'lark-cli'), { recursive: true });
  writeFileSync(join(larkData(), 'lark-cli', 'master.key'), 'm');
  // non-secret siblings that must NOT be blanket-enumerated
  mkdirSync(join(home(), 'bin'), { recursive: true });
  writeFileSync(join(home(), 'bin', 'botmux'), '#!/bin/sh');
  mkdirSync(join(data(), 'schedules'), { recursive: true });
}

describe('enumerateScratchSecretPaths', () => {
  it('enumerates all transport-credential classes but not ordinary dirs/files', () => {
    layout();
    process.env.LARKSUITE_CLI_DATA_DIR = larkData();
    const secret = enumerateScratchSecretPaths({
      botmuxHomes: [home()],
      dataDirs: [data()],
      botsConfigPath: join(home(), 'bots.json'),
      sessionId: 'sess-1',
    });
    const got = new Set(secret.denyPaths);
    const carve = new Set(secret.readOnlyCarvePaths);
    expect(got.has(join(home(), 'bots.json'))).toBe(true);
    expect(got.has(`${join(home(), 'bots.json')}.bak-2`)).toBe(true);
    expect(got.has(join(home(), '.dashboard-secret'))).toBe(true);
    expect(got.has(join(home(), 'bots', app, 'send-cred.json'))).toBe(true);
    expect(got.has(join(data(), 'webhook-master.key'))).toBe(true);
    expect(got.has(join(data(), 'webhook-secrets.json'))).toBe(true);
    // per-person user tokens matched by prefix, plus all legacy names
    expect(got.has(join(data(), 'user-token-cli_x-ou_person1.json'))).toBe(true);
    expect(got.has(join(data(), 'user-token-cli_x.json'))).toBe(true);
    expect(got.has(join(data(), 'user-token.json'))).toBe(true);
    expect(got.has(join(data(), 'notes.txt'))).toBe(false);
    // per-person secret dirs enclosed wholesale
    expect(got.has(join(data(), 'vc-meeting-daemon-auth'))).toBe(true);
    expect(got.has(join(data(), 'bytedcli-home'))).toBe(true);
    // cli-identity/ whole dir sealed, own session's <sid>.bin/ dir carved ro
    expect(got.has(join(data(), 'cli-identity'))).toBe(true);
    expect(carve.has(join(data(), 'cli-identity', 'sess-1.bin'))).toBe(true);
    // another session's .bin dir is NOT carved (stays under sealed parent)
    expect(carve.has(join(data(), 'cli-identity', 'sess-OTHER.bin'))).toBe(false);
    // real Linux lark-cli keystore ($LARKSUITE_CLI_DATA_DIR/lark-cli)
    expect(got.has(join(larkData(), 'lark-cli'))).toBe(true);
    // ordinary top-level dir/file are NOT secrets
    expect(got.has(join(home(), 'bin'))).toBe(false);
    expect(got.has(join(home(), 'bin', 'botmux'))).toBe(false);
    expect(got.has(join(data(), 'schedules'))).toBe(false);
    delete process.env.LARKSUITE_CLI_DATA_DIR;
  });

  it('adds external BOTS_CONFIG sidecar siblings outside the botmux home', () => {
    layout();
    const external = join(root, 'elsewhere', 'custom-bots.json');
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(external, '[]');
    writeFileSync(`${external}.tmp`, '[]');
    writeFileSync(join(root, 'elsewhere', 'unrelated.txt'), 'x');
    const got = enumerateScratchSecretPaths({ botmuxHomes: [home()], dataDirs: [data()], botsConfigPath: external }).denyPaths;
    expect(got).toContain(external);
    expect(got).toContain(`${external}.tmp`);
    expect(got).not.toContain(join(root, 'elsewhere', 'unrelated.txt'));
  });

  it('skips absent botmux paths but still masks a real host lark-cli keystore', () => {
    // No fake botmux home/data laid out. The enumerator returns at most the
    // HOST's own lark-cli keystores (a real secret it must never un-mask),
    // never anything from the absent fake homes.
    const got = enumerateScratchSecretPaths({ botmuxHomes: [home(), join(root, 'nope')], dataDirs: [data()] }).denyPaths;
    for (const p of got) {
      expect(p.startsWith(home())).toBe(false);
      expect(p.startsWith(join(root, 'nope'))).toBe(false);
      expect(p.includes('lark-cli')).toBe(true); // only host lark-cli stores
    }
  });

  it('encloses the per-bot secret without exposing the whole bots dir', () => {
    layout();
    const got = enumerateScratchSecretPaths({ botmuxHomes: [home()], dataDirs: [data()] }).denyPaths;
    // send-cred.json exact file, not the bots/ root (other non-secret state)
    expect(got).toContain(join(home(), 'bots', app, 'send-cred.json'));
    expect(got).not.toContain(join(home(), 'bots'));
    expect(got).not.toContain(join(home(), 'bots', app));
  });
});
