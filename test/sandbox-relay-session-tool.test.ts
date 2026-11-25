/**
 * `sandboxWithholdBotSecret`: the sandbox cannot read its bot's send-cred, so
 * `botmux history` / `botmux quoted` reach Lark through the session outbox.
 * Covers the policy deny, the host watcher's session-tool handling, and the
 * sandbox-side request builder.
 *
 * Run: npx vitest run --project unit test/sandbox-relay-session-tool.test.ts
 *      bun test test/sandbox-relay-session-tool.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { withFileLockSync } from '../src/utils/file-lock.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

import { RELAY_SESSION_TOOLS_MARKER, prepareDirectSandbox, startOutboxWatcher, validateRelaySessionToolRequest } from '../src/adapters/backend/sandbox.js';
import { accessForPath, buildFsPolicy, compileToBwrap, compileToSeatbelt, type FsPolicyContext } from '../src/adapters/cli/fs-policy.js';
import { buildRelaySessionToolRequest, materializeRelayedAttachments } from '../src/cli/relay-session-tool.js';
import { readVerifiedFile } from '../src/services/remote-runner-session-tool.js';
import { sandboxWithholdsBotSecret } from '../src/adapters/cli/sandbox-mode.js';
import { readSendCredJsonWithRetry, sendCredUpdateLockTarget, updateSendCredFile, writeSendCredFile } from '../src/adapters/cli/read-isolation.js';
import { statSync } from 'node:fs';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

const CAP = 'a'.repeat(64);

const ctx = (o: Partial<FsPolicyContext> = {}): FsPolicyContext => ({
  platform: 'darwin',
  homeDir: '/Users/u',
  botmuxHome: '/Users/u/.botmux',
  sessionDataDir: '/Users/u/.botmux/data',
  sessionId: 's',
  workingDir: '/Users/u/proj',
  currentAppId: 'cli_self',
  botHome: '/Users/u/.botmux/bots/cli_self',
  redirectedCliData: true,
  ...o,
});

describe('fs-policy: withholdSendCredential', () => {
  it.each(['darwin', 'linux'] as const)('denies only send-cred.json inside the writable BOT_HOME on %s', (platform) => {
    const home = platform === 'darwin' ? '/Users/u' : '/home/u';
    const base = {
      platform, homeDir: home, botmuxHome: `${home}/.botmux`, sessionDataDir: `${home}/.botmux/data`,
      workingDir: `${home}/proj`, botHome: `${home}/.botmux/bots/cli_self`,
    };
    const withheld = buildFsPolicy(ctx({ ...base, withholdSendCredential: true }));
    expect(accessForPath(withheld.rules, `${home}/.botmux/bots/cli_self/send-cred.json`).access).toBe('deny');
    expect(accessForPath(withheld.rules, `${home}/.botmux/bots/cli_self/claude/settings.json`).access).toBe('readWrite');
    // Default unchanged: the secret stays readable (that is what today's
    // in-sandbox direct send / history / quoted rely on).
    const normal = buildFsPolicy(ctx(base));
    expect(accessForPath(normal.rules, `${home}/.botmux/bots/cli_self/send-cred.json`).access).toBe('readWrite');
  });

  it('closes the own lark-cli keystore carve-out (ciphertext + master key = the secret)', () => {
    const darwinStore = '/Users/u/Library/Application Support/lark-cli';
    const on = buildFsPolicy(ctx({ withholdSendCredential: true }));
    const off = buildFsPolicy(ctx());
    for (const f of ['master.key.file', 'appsecret_cli_self.enc']) {
      expect(accessForPath(off.rules, `${darwinStore}/${f}`).access).toBe('readOnly');
      expect(accessForPath(on.rules, `${darwinStore}/${f}`).access).toBe('deny');
    }
    const linux = { platform: 'linux' as const, homeDir: '/home/u', botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj', botHome: '/home/u/.botmux/bots/cli_self' };
    const linuxStore = '/home/u/.local/share/lark-cli';
    for (const f of ['master.key', 'appsecret_cli_self.enc']) {
      expect(accessForPath(buildFsPolicy(ctx(linux)).rules, `${linuxStore}/${f}`).access).toBe('readOnly');
      expect(accessForPath(buildFsPolicy(ctx({ ...linux, withholdSendCredential: true })).rules, `${linuxStore}/${f}`).access).toBe('deny');
    }
  });

  it.each([
    ['workingDir', (store: string) => ({ workingDir: store })],
    ['user readWrite store', (store: string) => ({ userPaths: { readWrite: [store] } })],
    ['user readWrite exact key', (store: string) => ({ userPaths: { readWrite: [`${store}/master.key.file`, `${store}/master.key`] } })],
    ['user readOnly store', (store: string) => ({ userPaths: { readOnly: [store] } })],
  ])('keeps the lark-cli keystore closed against %s on both platforms', (_label, grant) => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/u' : '/home/u';
      const store = platform === 'darwin' ? `${home}/Library/Application Support/lark-cli` : `${home}/.local/share/lark-cli`;
      const master = platform === 'darwin' ? 'master.key.file' : 'master.key';
      const policy = buildFsPolicy(ctx({
        platform, homeDir: home, botmuxHome: `${home}/.botmux`, sessionDataDir: `${home}/.botmux/data`,
        workingDir: `${home}/proj`, botHome: `${home}/.botmux/bots/cli_self`,
        ...grant(store), withholdSendCredential: true,
      }));
      for (const file of [master, 'appsecret_cli_self.enc']) {
        const effective = accessForPath(policy.rules, `${store}/${file}`);
        expect(effective.access, `${platform}/${_label}/${file}`).toBe('deny');
        expect(effective.rule?.source).toBe('mandatory');
      }
      expect(accessForPath(policy.rules, store).access).toBe('deny');
      expect(accessForPath(policy.rules, store).rule?.source).toBe('mandatory');
    }
  });

  it('also closes an exact-key grant against a custom Linux keystore', () => {
    const store = '/home/u/custom-lark-store';
    const policy = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      botHome: '/home/u/.botmux/bots/cli_self', larkCliLinuxStore: store,
      withholdSendCredential: true,
      userPaths: { readWrite: [`${store}/master.key`] },
    }));
    expect(accessForPath(policy.rules, `${store}/master.key`).access).toBe('deny');
    expect(accessForPath(policy.rules, `${store}/appsecret_cli_self.enc`).access).toBe('deny');
  });

  it.each(['darwin', 'linux'] as const)('seals the keystore in no-transport sessions on %s', (platform) => {
    const home = platform === 'darwin' ? '/Users/u' : '/home/u';
    const store = platform === 'darwin' ? `${home}/Library/Application Support/lark-cli` : `${home}/.local/share/lark-cli`;
    const master = platform === 'darwin' ? 'master.key.file' : 'master.key';
    const policy = buildFsPolicy(ctx({
      platform, homeDir: home, botmuxHome: `${home}/.botmux`, sessionDataDir: `${home}/.botmux/data`,
      workingDir: `${home}/proj`, botHome: `${home}/.botmux/bots/cli_self`,
      larkTransportEnabled: false, withholdSendCredential: true,
      mandatoryReadOnlyPaths: [`${store}/${master}`, `${store}/appsecret_cli_self.enc`],
    }));
    for (const file of [master, 'appsecret_cli_self.enc']) {
      expect(accessForPath(policy.rules, `${store}/${file}`).access).toBe('deny');
    }
    expect(policy.finalDenyPaths).toContain(store);
    if (platform === 'darwin') {
      const ancestor = buildFsPolicy(ctx({
        platform, homeDir: home, botmuxHome: `${home}/.botmux`, sessionDataDir: `${home}/.botmux/data`,
        workingDir: `${home}/proj`, botHome: `${home}/.botmux/bots/cli_self`,
        larkTransportEnabled: false, withholdSendCredential: true,
        mandatoryReadOnlyPaths: [home],
      }));
      const profile = compileToSeatbelt(ancestor);
      expect(profile.lastIndexOf(`(deny file-read* (subpath "${store}"))`))
        .toBeGreaterThan(profile.lastIndexOf(`(allow file-read* (subpath "${home}"))`));
    } else {
      const compiled = compileToBwrap(policy, {
        chdir: `${home}/proj`, emptyDir: '/empty', emptiesDir: '/empties', filePaths: new Set(),
      });
      expect(compiled.args).not.toContain(`${store}/${master}`);
      expect(compiled.args).not.toContain(`${store}/appsecret_cli_self.enc`);
    }
  });

  it('seals a custom Linux keystore in a no-transport session', () => {
    const store = '/home/u/custom-lark-store';
    const policy = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      botHome: '/home/u/.botmux/bots/cli_self', larkCliLinuxStore: store,
      larkTransportEnabled: false, withholdSendCredential: true,
      mandatoryReadOnlyPaths: [`${store}/master.key`],
    }));
    expect(accessForPath(policy.rules, `${store}/master.key`).access).toBe('deny');
    expect(policy.finalDenyPaths).toContain(store);
    const compiled = compileToBwrap(policy, {
      chdir: '/home/u/proj', emptyDir: '/empty', emptiesDir: '/empties', filePaths: new Set(),
    });
    expect(compiled.args).not.toContain(`${store}/master.key`);
  });

  it('does not let a final Seatbelt read-only exception re-open a withheld key', () => {
    const store = '/Users/u/Library/Application Support/lark-cli';
    const key = `${store}/master.key.file`;
    const policy = buildFsPolicy(ctx({
      withholdSendCredential: true,
      userPaths: { readWrite: [store] },
      serviceCredentialReadOnlyPaths: [key],
    }));
    expect(policy.finalReadOnlyPaths).not.toContain(key);
    const profile = compileToSeatbelt(policy);
    const allow = `(allow file-read* (subpath "${key}"))`;
    const deny = `(deny file-read* (subpath "${key}"))`;
    expect(profile.lastIndexOf(deny)).toBeGreaterThan(profile.lastIndexOf(allow));
  });

  it.each(['/Users/u/Library/Application Support', '/Users/u', '/'])(
    'does not let an ancestor final read-only path re-open withheld keys: %s',
    (ancestor) => {
      const policy = buildFsPolicy(ctx({
        withholdSendCredential: true,
        mandatoryReadOnlyPaths: [ancestor],
      }));
      // Ancestors may remain readable for the rest of the sandbox, but the
      // final withheld-store deny must be emitted after every such grant.
      expect(policy.finalReadOnlyPaths).toContain(ancestor);
      const profile = compileToSeatbelt(policy);
      const store = '/Users/u/Library/Application Support/lark-cli';
      expect(profile.lastIndexOf(`(deny file-read* (subpath "${store}"))`))
        .toBeGreaterThan(profile.lastIndexOf(`(allow file-read* (subpath "${ancestor}"))`));
      for (const file of ['master.key.file', 'appsecret_cli_self.enc']) {
        const key = `/Users/u/Library/Application Support/lark-cli/${file}`;
        expect(profile.lastIndexOf(`(deny file-read* (subpath "${key}"))`))
          .toBeGreaterThan(profile.lastIndexOf(`(allow file-read* (subpath "${key}"))`));
      }
    },
  );

  it('drops every deeper grant inside a withheld keystore, including sibling and future files', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/u' : '/home/u';
      const store = platform === 'darwin' ? `${home}/Library/Application Support/lark-cli` : `${home}/.local/share/lark-cli`;
      const siblings = ['appsecret_cli_other.enc', 'cli_self_ou_secret.enc', 'future-secret.enc'];
      const policy = buildFsPolicy(ctx({
        platform, homeDir: home, botmuxHome: `${home}/.botmux`, sessionDataDir: `${home}/.botmux/data`,
        workingDir: `${home}/proj`, botHome: `${home}/.botmux/bots/cli_self`, withholdSendCredential: true,
        userPaths: { readOnly: siblings.map(file => `${store}/${file}`) },
        mandatoryReadOnlyPaths: [`${store}/cli_self_ou_secret.enc`],
      }));
      for (const file of siblings) {
        expect(accessForPath(policy.rules, `${store}/${file}`).access, `${platform}/${file}`).toBe('deny');
      }
      expect(policy.rules.every(rule => rule.access === 'deny' || !rule.path.startsWith(`${store}/`))).toBe(true);
      if (platform === 'linux') {
        const compiled = compileToBwrap(policy, {
          chdir: `${home}/proj`, emptyDir: '/empty', emptiesDir: '/empties', filePaths: new Set(),
        });
        for (const file of siblings) expect(compiled.args).not.toContain(`${store}/${file}`);
      }
    }
  });

  it('hides other processes from the Seatbelt pane only when the secret is withheld', () => {
    const on = compileToSeatbelt(buildFsPolicy(ctx({ withholdSendCredential: true })));
    expect(on).toContain('(deny process-info* (target others))');
    expect(on).toContain('(deny sysctl-read (sysctl-name-prefix "kern.procargs"))');
    const off = compileToSeatbelt(buildFsPolicy(ctx()));
    expect(off).not.toContain('process-info*');
    expect(off).not.toContain('kern.procargs');
  });

  it('pins BOT_HOME and the outbox against rename/rmdir, after the write grants', () => {
    const outbox = '/Users/u/.botmux/data/sandboxes/s/outbox';
    const on = compileToSeatbelt(buildFsPolicy(ctx({ outbox, withholdSendCredential: true })));
    for (const dir of ['/Users/u/.botmux/bots/cli_self', outbox]) {
      const pin = `(deny file-write-unlink (literal "${dir}"))`;
      expect(on).toContain(pin);
      expect(on.indexOf(pin)).toBeGreaterThan(on.indexOf(`(subpath "${dir}")`));
    }
    expect(compileToSeatbelt(buildFsPolicy(ctx({ outbox })))).not.toContain('file-write-unlink (literal');
  });

  it('makes the own attachment bucket read-only when the secret is withheld (both platforms), read-write otherwise', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/u' : '/home/u';
      const base = { platform, homeDir: home, botmuxHome: `${home}/.botmux`, sessionDataDir: `${home}/.botmux/data`,
        workingDir: `${home}/proj`, botHome: `${home}/.botmux/bots/cli_self`, outbox: `${home}/.botmux/data/sandboxes/s/outbox` };
      const file = `${home}/.botmux/data/attachments/cli_self/om_x/a.png`;
      expect(accessForPath(buildFsPolicy(ctx({ ...base, withholdSendCredential: true })).rules, file).access).toBe('readOnly');
      expect(accessForPath(buildFsPolicy(ctx(base)).rules, file).access).toBe('readWrite');
    }
  });

  it('grants the macOS relay outbox read-write', () => {
    const outbox = '/Users/u/.botmux/data/sandboxes/s/outbox';
    const p = buildFsPolicy(ctx({ outbox, withholdSendCredential: true }));
    expect(accessForPath(p.rules, `${outbox}/x.req.json`).access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sandboxes/other/outbox/x.req.json').access).not.toBe('readWrite');
    // The host-private download root for relayed quoted sits next to the outbox
    // and must stay out of reach on both platforms.
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/u' : '/home/u';
      const pp = buildFsPolicy(ctx({ platform, homeDir: home, botmuxHome: `${home}/.botmux`, sessionDataDir: `${home}/.botmux/data`,
        workingDir: `${home}/proj`, botHome: `${home}/.botmux/bots/cli_self`,
        outbox: `${home}/.botmux/data/sandboxes/s/outbox`, withholdSendCredential: true }));
      const a = accessForPath(pp.rules, `${home}/.botmux/data/sandboxes/s/relay-attachments/cli_self/om_x/a.png`).access;
      expect(a, platform).not.toBe('readWrite');
      expect(a, platform).not.toBe('readOnly');
    }
  });
});

describe('sandboxWithholdsBotSecret (one decision for every freeze / snapshot path)', () => {
  it.each([
    [{ sandbox: 'oncall', sandboxWithholdBotSecret: true }, undefined, true],
    [{ sandbox: true, sandboxWithholdBotSecret: true }, undefined, true],
    [{ sandboxWithholdBotSecret: true }, '1', true],
    [{ sandbox: false, sandboxWithholdBotSecret: true }, 'oncall', true],
    [{ sandbox: 'scratch', sandboxWithholdBotSecret: true }, undefined, false],
    [{ sandbox: 'oncall', sandboxWithholdBotSecret: true }, 'scratch', false],
    [{ sandboxWithholdBotSecret: true }, undefined, false],
    [{ sandbox: 'oncall' }, '1', false],
    [{ sandbox: 'oncall', sandboxWithholdBotSecret: true }, 'bogus', false],
  ] as const)('%j with BOTMUX_SANDBOX=%s → %s', (cfg, env, expected) => {
    expect(sandboxWithholdsBotSecret(cfg as any, env)).toBe(expected);
  });
});

describe('writeSendCredFile', () => {
  it('rewrites in place (same inode, no temp sibling) and leaves unchanged content alone', () => {
    const home = tmp('botmux-send-cred-');
    const path = join(home, 'send-cred.json');
    writeSendCredFile(path, '{"v":1}');
    const first = statSync(path);
    expect(first.mode & 0o777).toBe(0o600);
    writeSendCredFile(path, '{"v":2,"longer":true}');
    const second = statSync(path);
    expect(readFileSync(path, 'utf8')).toBe('{"v":2,"longer":true}');
    expect(second.ino).toBe(first.ino);
    writeSendCredFile(path, '{"v":2,"longer":true}');
    expect(statSync(path).mtimeMs).toBe(second.mtimeMs);
    // shorter content must not leave a tail of the old bytes behind
    writeSendCredFile(path, '{"v":3}');
    expect(readFileSync(path, 'utf8')).toBe('{"v":3}');
    expect(readdirSync(home)).toEqual(['send-cred.json']);
  });
  it('never writes through a planted symlink', () => {
    const home = tmp('botmux-send-cred-');
    const victim = join(home, 'victim'); writeFileSync(victim, 'keep');
    symlinkSync(victim, join(home, 'send-cred.json'));
    expect(() => writeSendCredFile(join(home, 'send-cred.json'), '{}')).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });
  it('serializes writers across processes, not only within one event loop', async () => {
    const home = tmp('botmux-send-cred-lock-');
    const path = join(home, 'send-cred.json');
    const ready = join(home, 'child-ready');
    const oldJson = '{"v":"old"}';
    const newJson = '{"v":"new"}';
    writeFileSync(path, oldJson);
    let child: ReturnType<typeof spawnTsEvalWithRepoImports> | undefined;
    let duringLock = '';
    try {
      withFileLockSync(path, () => {
        child = spawnTsEvalWithRepoImports(`
          import { writeSendCredFile } from './src/adapters/cli/read-isolation.js';
          import { writeFileSync } from 'node:fs';
          writeFileSync(${JSON.stringify(ready)}, '1');
          writeSendCredFile(${JSON.stringify(path)}, ${JSON.stringify(newJson)});
        `);
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready)) {
          if (Date.now() > deadline) throw new Error('writer did not become ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        duringLock = readFileSync(path, 'utf8');
      });
      expect(duringLock).toBe(oldJson);
      const [code] = await once(child!, 'close');
      expect(code).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(newJson);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
  it('retries a torn JSON read until the writer completes the object', async () => {
    const home = tmp('botmux-send-cred-read-');
    const path = join(home, 'send-cred.json');
    const ready = join(home, 'truncate-ready');
    const expected = { larkAppSecret: 'new-secret', feedback: { enabled: true } };
    writeFileSync(path, '{"larkAppSecret":"old"}');
    const child = spawnTsEvalWithRepoImports(`
      import { openSync, ftruncateSync, writeFileSync, writeSync, fsyncSync, closeSync } from 'node:fs';
      const fd = openSync(${JSON.stringify(path)}, 'r+');
      ftruncateSync(fd, 0);
      writeFileSync(${JSON.stringify(ready)}, '1');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      writeSync(fd, ${JSON.stringify(JSON.stringify(expected))}, 0, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
    `);
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error('writer did not truncate');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      expect(readSendCredJsonWithRetry(path)).toEqual(expected);
      const [code] = await once(child, 'close');
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
  it('updates feedback inside the same credential without dropping other fields', () => {
    const home = tmp('botmux-send-cred-update-');
    const path = join(home, 'send-cred.json');
    writeSendCredFile(path, JSON.stringify({ larkAppSecret: 'secret', apiOnly: false, feedback: { enabled: false } }));
    updateSendCredFile(path, cred => { delete cred.feedback; return cred; });
    expect(readSendCredJsonWithRetry(path)).toEqual({ larkAppSecret: 'secret', apiOnly: false });
    expect(readdirSync(home)).toEqual(['send-cred.json']);
  });
  it('uses one lock for lexical aliases of the same credential and distinct locks for different files', () => {
    const root = tmp('botmux-send-cred-lock-alias-');
    const real = join(root, 'real');
    mkdirSync(join(real, 'bots', 'cli_self'), { recursive: true });
    const alias = join(root, 'alias');
    symlinkSync(real, alias);
    const dataDir = join(root, 'data');
    const first = join(real, 'bots', 'cli_self', 'send-cred.json');
    const same = join(alias, 'bots', 'cli_self', 'send-cred.json');
    const other = join(real, 'bots', 'cli_other', 'send-cred.json');
    expect(sendCredUpdateLockTarget(dataDir, first)).toBe(sendCredUpdateLockTarget(dataDir, same));
    expect(sendCredUpdateLockTarget(dataDir, first)).not.toBe(sendCredUpdateLockTarget(dataDir, other));
  });
  it.skipIf(process.platform !== 'linux')('keeps the host-private lock usable after direct-sandbox mask preparation', () => {
    const root = tmp('botmux-send-cred-prepare-');
    const dataDir = join(root, 'data');
    const botHome = join(root, 'bots', 'cli_self');
    const path = join(botHome, 'send-cred.json');
    const lockTarget = sendCredUpdateLockTarget(dataDir, path);
    mkdirSync(botHome, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeSendCredFile(path, '{"larkAppSecret":"old","feedback":{"enabled":false}}', lockTarget);
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      plan = prepareDirectSandbox({
        sessionId: 'cred-lock', dataDir,
        policy: { rules: [
          { path: botHome, access: 'readWrite', source: 'internal' },
          { path, access: 'deny', source: 'mandatory' },
          // Deliberately mask a would-be sibling lock: the production lock must
          // stay outside this mount plan or updates would fail with EISDIR.
          { path: `${path}.lock`, access: 'deny', source: 'mandatory' },
        ], net: true, writeRegexes: [] },
        chdir: root, home: root, cliBin: '/usr/bin/true', cliArgs: [],
      });
      if (!plan) return; // host cannot create the exact bwrap primitives
      updateSendCredFile(path, cred => ({ ...cred, feedback: { enabled: true } }), lockTarget);
      expect(readSendCredJsonWithRetry(path)).toEqual({ larkAppSecret: 'old', feedback: { enabled: true } });
      // Worker restart rewrites the full credential through the same lock target.
      writeSendCredFile(path, '{"larkAppSecret":"new","feedback":{"enabled":false}}', lockTarget);
      expect(readSendCredJsonWithRetry(path)).toEqual({ larkAppSecret: 'new', feedback: { enabled: false } });
      expect(lstatSync(`${path}.lock`).isDirectory()).toBe(true);
    } finally {
      plan?.cleanup();
      rmSandboxScratch(root);
    }
  });
});

describe('validateRelaySessionToolRequest', () => {
  it('accepts structured history / quoted requests only', () => {
    expect(validateRelaySessionToolRequest({ command: 'session-tool', tool: { tool: 'history', limit: 20, scope: 'thread' }, originCapability: CAP }))
      .toEqual({ ok: true, value: { request: { tool: 'history', limit: 20, scope: 'thread' }, originCapability: CAP } });
    expect(validateRelaySessionToolRequest({ command: 'session-tool', tool: { tool: 'quoted', messageId: 'om_abc', raw: true } }))
      .toEqual({ ok: true, value: { request: { tool: 'quoted', messageId: 'om_abc', raw: true } } });
  });
  it.each([
    ['other session tools', { tool: 'schedule.list' }],
    ['skill reads', { tool: 'skill.read', name: 'x', path: 'y' }],
    ['unknown fields', { tool: 'history', sessionId: 'other' }],
    ['bad message id', { tool: 'quoted', messageId: '../../etc' }],
    ['argv instead of a request', ['history', '--session-id', 'other']],
  ])('rejects %s', (_label, tool) => {
    expect(validateRelaySessionToolRequest({ command: 'session-tool', tool }).ok).toBe(false);
  });
  it('rejects a malformed capability', () => {
    expect(validateRelaySessionToolRequest({ command: 'session-tool', tool: { tool: 'history' }, originCapability: 'zz' }).ok).toBe(false);
  });
});

describe('outbox watcher: session-tool requests', () => {
  const setup = () => {
    const root = tmp('botmux-relay-session-tool-');
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    const fixture = join(root, 'echo.mjs');
    writeFileSync(fixture, `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), relay: process.env.BOTMUX_HOST_RELAY_AUTHORIZED, turn: process.env.BOTMUX_TURN_ID, chat: process.env.BOTMUX_CHAT_ID, attachmentsRoot: process.env.BOTMUX_ATTACHMENTS_ROOT }));`);
    return { outbox, fixture };
  };
  const readRes = async (outbox: string, id: string) => {
    const p = join(outbox, `${id}.res.json`);
    await vi.waitFor(() => expect(existsSync(p)).toBe(true), { timeout: 10_000 });
    return JSON.parse(readFileSync(p, 'utf8')) as { code: number; stdout: string; stderr: string };
  };
  const authorize = (claim: { capability?: string }) => claim.capability === CAP
    ? { ok: true as const, origin: { turnId: 'om_turn' } }
    : { ok: false as const, error: 'origin_mismatch' };

  it('runs history on the host for the forced session, with the live turn', async () => {
    const { outbox, fixture } = setup();
    writeFileSync(join(outbox, 'h1.req.json'), JSON.stringify({ command: 'session-tool', tool: { tool: 'history', limit: 5 }, originCapability: CAP }));
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'forced-sid', { cliPath: fixture, authorize, sessionToolChatId: 'oc_chat' });
    try {
      const res = await readRes(outbox, 'h1');
      expect(res.code, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({
        argv: ['history', '--limit', '5', '--session-id', 'forced-sid'],
        relay: '1', turn: 'om_turn', chat: 'oc_chat',
        // host-private sibling of the outbox, not the sandbox-writable bucket
        attachmentsRoot: join(outbox, '..', 'relay-attachments').replace('/outbox/..', ''),
      });
      expect(existsSync(join(outbox, '..', 'relay-attachments'))).toBe(true);
    } finally { stop(); }
  });

  it('advertises session tools only when it serves them', () => {
    const a = setup();
    const stopA = startOutboxWatcher(a.outbox, { ...process.env }, 'sid', { cliPath: a.fixture, authorize, sessionToolChatId: 'oc_chat' });
    const b = setup();
    const stopB = startOutboxWatcher(b.outbox, { ...process.env }, 'sid', { cliPath: b.fixture, authorize });
    try {
      expect(existsSync(join(a.outbox, RELAY_SESSION_TOOLS_MARKER))).toBe(true);
      expect(existsSync(join(b.outbox, RELAY_SESSION_TOOLS_MARKER))).toBe(false);
    } finally { stopA(); stopB(); }
  });

  it('drops the response instead of writing through an outbox replaced mid-flight', async () => {
    const root = tmp('botmux-relay-outbox-swap-');
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    const victim = join(root, 'victim');
    mkdirSync(victim);
    const signal = join(root, 'started');
    const fixture = join(root, 'slow.mjs');
    writeFileSync(fixture, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PIN_SIGNAL, '1'); setTimeout(() => process.stdout.write('{}'), 700);`);
    writeFileSync(join(outbox, 'swap.content'), 'hello');
    writeFileSync(join(outbox, 'swap.req.json'), JSON.stringify({ contentFile: 'swap.content', flags: ['--no-mention'] }));
    const stop = startOutboxWatcher(outbox, { ...process.env, PIN_SIGNAL: signal }, 'sid', { cliPath: fixture });
    try {
      await vi.waitFor(() => expect(existsSync(signal)).toBe(true), { timeout: 5_000 });
      renameSync(outbox, `${outbox}.moved`);
      symlinkSync(victim, outbox);
      await new Promise(r => setTimeout(r, 1_800));
      expect(readdirSync(victim)).toEqual([]);
      expect(readdirSync(`${outbox}.moved`).filter(n => n.endsWith('.res.json'))).toEqual([]);
    } finally { stop(); }
  });

  it('replaces a planted res.json symlink instead of writing through it', async () => {
    const { outbox, fixture } = setup();
    const victim = join(outbox, '..', 'host-file');
    writeFileSync(victim, 'HOST');
    symlinkSync(victim, join(outbox, 'evil.res.json'));
    writeFileSync(join(outbox, 'evil.req.json'), '{not json');
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'sid', { cliPath: fixture });
    try {
      await vi.waitFor(() => expect(lstatSync(join(outbox, 'evil.res.json')).isSymbolicLink()).toBe(false), { timeout: 5_000 });
      expect(readFileSync(victim, 'utf8')).toBe('HOST');
    } finally { stop(); }
  });

  it('runs quoted with the current-chat check', async () => {
    const { outbox, fixture } = setup();
    writeFileSync(join(outbox, 'q1.req.json'), JSON.stringify({ command: 'session-tool', tool: { tool: 'quoted', messageId: 'om_x' }, originCapability: CAP }));
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'forced-sid', { cliPath: fixture, authorize, sessionToolChatId: 'oc_chat' });
    try {
      const res = await readRes(outbox, 'q1');
      expect(JSON.parse(res.stdout).argv).toEqual(['quoted', 'om_x', '--remote-runner-session-tool', '--session-id', 'forced-sid']);
    } finally { stop(); }
  });

  it('refuses without a valid capability, and on watchers that do not serve session tools', async () => {
    const { outbox, fixture } = setup();
    writeFileSync(join(outbox, 'bad.req.json'), JSON.stringify({ command: 'session-tool', tool: { tool: 'history' }, originCapability: 'b'.repeat(64) }));
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'forced-sid', { cliPath: fixture, authorize, sessionToolChatId: 'oc_chat' });
    try {
      const res = await readRes(outbox, 'bad');
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('origin_mismatch');
      expect(res.stdout).toBe('');
    } finally { stop(); }

    const other = setup();
    writeFileSync(join(other.outbox, 'n1.req.json'), JSON.stringify({ command: 'session-tool', tool: { tool: 'history' }, originCapability: CAP }));
    const stop2 = startOutboxWatcher(other.outbox, { ...process.env }, 'forced-sid', { cliPath: other.fixture, authorize });
    try {
      const res = await readRes(other.outbox, 'n1');
      expect(res.code).toBe(2);
      expect(res.stdout).toBe('');
    } finally { stop2(); }
  });
});

describe('buildRelaySessionToolRequest', () => {
  it('maps the supported history / quoted options', () => {
    expect(buildRelaySessionToolRequest('history', ['--limit', '30', '--scope=ambient', '--with-card-json'], 'sid'))
      .toEqual({ ok: true, request: { tool: 'history', limit: 30, scope: 'ambient', withCardJson: true } });
    expect(buildRelaySessionToolRequest('history', ['--limit', '500'], 'sid'))
      .toEqual({ ok: true, request: { tool: 'history', limit: 100 } });
    expect(buildRelaySessionToolRequest('quoted', ['om_a', '--raw', '--session-id', 'sid'], 'sid'))
      .toEqual({ ok: true, request: { tool: 'quoted', messageId: 'om_a', raw: true } });
    expect(buildRelaySessionToolRequest('quoted', ['om_a', '--raw', '--no-download'], 'sid'))
      .toEqual({ ok: true, request: { tool: 'quoted', messageId: 'om_a', raw: true, download: false } });
    expect(buildRelaySessionToolRequest('history', ['--view=index', '--query=--session-id', '--type', 'text,interactive',
      '--since', '2026-11-24T00:00:00+08:00', '--until=2026-11-25T00:00:00+08:00'], 'sid'))
      .toEqual({ ok: true, request: { tool: 'history', view: 'index', query: '--session-id', types: ['text', 'interactive'],
        since: '2026-11-24T00:00:00+08:00', until: '2026-11-25T00:00:00+08:00' } });
  });
  it.each([
    ['history', ['--view', 'index', '--with-card-json']],
    ['history', ['--since', '2026-11-25', '--until', '2026-11-24']],
    ['history', ['--type', '../file']],
    ['history', ['--session-id', 'someone-else']],
    ['history', ['--limit', '0']],
    ['quoted', ['om_a', 'om_b']],
    ['quoted', ['om_a', '--no-download=false']],
    ['quoted', []],
  ] as const)('refuses %s %j', (tool, args) => {
    expect(buildRelaySessionToolRequest(tool, [...args], 'sid').ok).toBe(false);
  });
});

describe('readVerifiedFile (host packaging of quoted attachments)', () => {
  it('reads the validated inode and refuses a path swapped for a symlink or another file', () => {
    const dir = tmp('botmux-verified-read-');
    const good = join(dir, 'a.png');
    writeFileSync(good, 'GOOD');
    const info = lstatSync(good);
    expect(readVerifiedFile(good, info).toString()).toBe('GOOD');
    // Pre-build the replacement while the validated file still holds its
    // inode: two coexisting regular files must have distinct inodes. This has
    // to happen before good is removed — on Linux ext4/tmpfs a just-freed
    // inode is reallocated to the next create in an otherwise-empty directory,
    // so an rm + recreate can legitimately keep the same (dev, ino).
    const other = join(dir, 'b.png');
    writeFileSync(other, 'SECRET');
    expect(lstatSync(other).ino).not.toBe(info.ino);
    // A hard link keeps the validated inode alive at another path.
    const hardCopy = join(dir, 'hard.png');
    linkSync(good, hardCopy);
    // swapped for a symlink to the withheld credential
    const secret = join(dir, 'send-cred.json');
    writeFileSync(secret, 'SECRET');
    rmSync(good); symlinkSync(secret, good);
    expect(() => readVerifiedFile(good, info)).toThrow();
    // swapped for the pre-built regular file; rename carries its own inode.
    rmSync(good);
    renameSync(other, good);
    expect(() => readVerifiedFile(good, info)).toThrow();
    // A symlink must be refused even when its target satisfies the inode
    // identity (the hard link shares the validated inode): O_NOFOLLOW is the
    // only guard that rejects the link itself rather than its target's inode.
    rmSync(good);
    symlinkSync(hardCopy, good);
    expect(() => readVerifiedFile(good, info)).toThrow();
  });
});

describe('materializeRelayedAttachments', () => {
  it('writes the bytes and rewrites the placeholders', () => {
    const dir = join(tmp('botmux-relay-att-'), 'quoted-1');
    const stdout = JSON.stringify({ attachments: [
      { path: 'botmux-session-tool://attachment/0', name: 'a.png' },
      { path: 'botmux-session-tool://attachment/1', name: '../../x.txt' },
    ] });
    const out = materializeRelayedAttachments(stdout, [
      { placeholder: 'botmux-session-tool://attachment/0', name: 'a.png', type: 'image', dataBase64: Buffer.from('PNG').toString('base64') },
      { placeholder: 'botmux-session-tool://attachment/1', name: '../../x.txt', type: 'file', dataBase64: Buffer.from('TXT').toString('base64') },
    ], dir);
    const parsed = JSON.parse(out) as { attachments: Array<{ path: string }> };
    expect(parsed.attachments.map(a => a.path)).toEqual([join(dir, '0-a.png'), join(dir, '1-x.txt')]);
    expect(readFileSync(join(dir, '0-a.png'), 'utf8')).toBe('PNG');
    expect(readFileSync(join(dir, '1-x.txt'), 'utf8')).toBe('TXT');
  });
  it('rewrites only attachment paths, not message text equal to a placeholder', () => {
    const placeholder = 'botmux-session-tool://attachment/0';
    const stdout = JSON.stringify({ text: placeholder, nested: { literal: placeholder },
      attachments: [{ path: placeholder, name: 'a.txt', type: 'file' }] });
    const out = materializeRelayedAttachments(stdout, [
      { placeholder, name: 'a.txt', type: 'file', dataBase64: Buffer.from('A').toString('base64') },
    ], join(tmp('botmux-relay-att-text-'), 'quoted-1'));
    const parsed = JSON.parse(out) as { text: string; nested: { literal: string }; attachments: Array<{ path: string }> };
    expect(parsed.text).toBe(placeholder);
    expect(parsed.nested.literal).toBe(placeholder);
    expect(parsed.attachments[0]!.path).not.toBe(placeholder);
  });
  it('never writes through a pre-planted entry', () => {
    const root = tmp('botmux-relay-att-');
    const dir = join(root, 'quoted-1');
    mkdirSync(dir);
    const victim = join(root, 'victim');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(dir, '0-a.png'));
    expect(() => materializeRelayedAttachments(JSON.stringify({ attachments: [{ path: 'p' }] }), [
      { placeholder: 'p', name: 'a.png', type: 'image', dataBase64: Buffer.from('X').toString('base64') },
    ], dir)).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(lstatSync(join(dir, '0-a.png')).isSymbolicLink()).toBe(true);
  });
});
