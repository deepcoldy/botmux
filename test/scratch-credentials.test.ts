import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { enumerateScratchSecretPaths } from '../src/adapters/backend/scratch-credentials.js';
import { BACKGROUND_JOBS_HOME_ROOT } from '../src/services/bytedcli-home.js';

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

  it('masks the per-person secret dirs even before they exist, so later tokens inside stay hidden', () => {
    mkdirSync(data(), { recursive: true });
    const got = new Set(enumerateScratchSecretPaths({ botmuxHomes: [home()], dataDirs: [data()], sessionId: 'sess-1' }).denyPaths);
    for (const dir of ['vc-meeting-daemon-auth', 'bytedcli-home', 'oauth-pending', 'cli-identity']) {
      expect(got.has(join(data(), dir)), dir).toBe(true);
    }
  });

  it('never turns a same-named FILE into a directory mask', () => {
    mkdirSync(data(), { recursive: true });
    writeFileSync(join(data(), 'oauth-pending'), 'x');
    expect(enumerateScratchSecretPaths({ botmuxHomes: [], dataDirs: [data()] }).denyPaths).not.toContain(join(data(), 'oauth-pending'));
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

  it('skips absent botmux files but still masks a real host lark-cli keystore and the fixed background-jobs root', () => {
    // No fake botmux home/data laid out. Besides the fixed per-person dirs of
    // the (absent) data dir and the FIXED HOST background-jobs root (sealed
    // unconditionally, independent of SESSION_DATA_DIR), the enumerator returns
    // at most the HOST's own lark-cli keystores (a real secret it must never
    // un-mask), no file from the absent fake homes.
    const fixedDirs = ['vc-meeting-daemon-auth', 'bytedcli-home', 'oauth-pending', 'cli-identity'].map(d => join(data(), d));
    fixedDirs.push(BACKGROUND_JOBS_HOME_ROOT);
    const got = enumerateScratchSecretPaths({ botmuxHomes: [home(), join(root, 'nope')], dataDirs: [data()] }).denyPaths;
    // The detached-job host root is sealed even though it lives outside the
    // fake botmux home and no job directory exists yet.
    expect(got).toContain(BACKGROUND_JOBS_HOME_ROOT);
    for (const p of got.filter(p => !fixedDirs.includes(p))) {
      expect(p.startsWith(home())).toBe(false);
      expect(p.startsWith(join(root, 'nope'))).toBe(false);
      expect(p.includes('lark-cli')).toBe(true); // only host lark-cli stores
    }
  });

  it('seals the fixed background-jobs root regardless of SESSION_DATA_DIR (core-only / custom state dir)', () => {
    // The job HOME derives from the homedir authority root, not SESSION_DATA_DIR
    // (PR #2519 P2-4 / issue #2572): a scratch session must never read it even
    // when the data dir points at the core-only default or a custom --state-dir.
    const customData = join(root, 'core-only', 'cli_x', 'data');
    const got = enumerateScratchSecretPaths({ botmuxHomes: [], dataDirs: [customData] }).denyPaths;
    expect(got).toContain(BACKGROUND_JOBS_HOME_ROOT);
  });

  it('masks the per-person secret dirs even when the data dir itself does not exist yet', () => {
    // A custom SESSION_DATA_DIR leaves ~/.botmux/data uncreated until the first
    // login, which may happen while a scratch session runs.
    const got = new Set(enumerateScratchSecretPaths({ botmuxHomes: [], dataDirs: [data()], sessionId: 'sess-1' }).denyPaths);
    for (const dir of ['vc-meeting-daemon-auth', 'bytedcli-home', 'oauth-pending', 'cli-identity']) {
      expect(got.has(join(data(), dir)), dir).toBe(true);
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

describe('scratch × `botmux skill show`', () => {
  it('the credential mask leaves the session skill manifest and skill snapshot readable through the COW root', () => {
    layout();
    process.env.LARKSUITE_CLI_DATA_DIR = larkData();
    const manifest = join(data(), 'skill-manifests', 'sess-1.json');
    const body = join(home(), 'skills', 'store', 'deploy', 'SKILL.md');
    const snapshotBody = join(data(), 'runtime-skills', 'sess-1', 'snapshot', 'deploy', 'SKILL.md');
    mkdirSync(join(data(), 'runtime-skills', 'sess-1', 'snapshot', 'deploy'), { recursive: true });
    writeFileSync(snapshotBody, '# Deploy');
    mkdirSync(join(data(), 'skill-manifests'), { recursive: true });
    writeFileSync(manifest, '{}');
    mkdirSync(join(home(), 'skills', 'store', 'deploy'), { recursive: true });
    writeFileSync(body, '# Deploy');
    writeFileSync(join(home(), 'skills', 'registry.json'), '{}');
    try {
      const secret = enumerateScratchSecretPaths({
        botmuxHomes: [home()],
        dataDirs: [data()],
        homeDir: join(root, 'oshome'),
        sessionId: 'sess-1',
      });
      // Scratch mounts the REAL tree; only enumerated secrets are masked. The
      // skill reader's inputs must not be among them (they hold no credential).
      for (const path of [manifest, body, snapshotBody]) {
        expect(secret.denyPaths.some(p => path === p || path.startsWith(`${p}/`)), path).toBe(false);
      }
      // …while the transport credentials next to them stay masked.
      expect(secret.denyPaths).toContain(join(home(), 'bots.json'));
      expect(secret.denyPaths).toContain(join(data(), 'cli-identity'));
    } finally {
      delete process.env.LARKSUITE_CLI_DATA_DIR;
    }
  });
});
