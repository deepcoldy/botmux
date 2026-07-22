import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildSeatbeltProfile,
  evaluateReadIsolationGate,
  evaluateCredentialOnlyIsolationGate,
  credentialIsolationRequired,
  deviceCredentialIsolationMarkerPath,
  isCredentialIsolationReservedBasename,
  buildCredentialIsolationRules,
  isolatedPaneOriginChannel,
  isolatedPaneReattachSafe,
  botHomePath,
  buildV2DenyPaths,
  buildV2DenyRegexes,
  buildV2CarveOuts,
  buildReadIsolationProtectedWriteRules,
  buildCliExecutableReadCarveOuts,
  buildWriteSandboxRules,
  buildLinuxReadIsolationMasks,
  sendCredFilePath,
  assertSafeAppId,
  normalizeIsolationPath,
  isolationPaneMarkerContent,
  isolationPanePolicyDigest,
  type V2IsolationContext,
  type WriteSandboxContext,
} from '../src/adapters/cli/read-isolation.js';
import {
  managedOriginAttestationDirectory,
  managedOriginCapabilityPath,
  managedOriginIsolationSentinelPath,
  managedOriginRootLocatorPath,
} from '../src/core/managed-origin-capability.js';

const G1 = '11'.repeat(32);
const G2 = '22'.repeat(32);
const POLICY1 = isolationPanePolicyDigest({
  readIsolation: true,
  writeSandbox: false,
  readDenyExtraPaths: ['/private/a'],
});

const ws = (o: Partial<WriteSandboxContext> = {}): WriteSandboxContext => ({
  homeDir: '/Users/bot',
  botmuxHome: '/Users/bot/.botmux',
  sessionDataDir: '/Users/bot/.botmux/data',
  workingDir: '/Users/bot/projects/app',
  currentAppId: 'cli_self',
  ...o,
});

const v2 = (o: Partial<V2IsolationContext> = {}): V2IsolationContext => ({
  homeDir: '/Users/bot',
  botmuxHome: '/Users/bot/.botmux',
  sessionDataDir: '/Users/bot/.botmux/data',
  currentAppId: 'cli_self',
  currentSessionId: 'session-self',
  currentOriginChannelId: G1,
  ...o,
});

describe('normalizeIsolationPath (path hardening)', () => {
  it('drops relative / traversal paths instead of silently keeping them', () => {
    expect(normalizeIsolationPath('relative/x')).toBeNull();
    expect(normalizeIsolationPath('/a/../b')).toBeNull();
    expect(normalizeIsolationPath('/ok/path')).toBe('/ok/path');
  });

  it('strips trailing slashes', () => {
    expect(normalizeIsolationPath('/a/b/')).toBe('/a/b');
  });
});

describe('mandatory device credential isolation gate', () => {
  it('uses a fixed home marker and recognizes every credential journal sidecar', () => {
    expect(deviceCredentialIsolationMarkerPath('/Users/bot/'))
      .toBe('/Users/bot/.botmux/.device-credential-isolation');
    for (const name of [
      '.device-credential-isolation',
      '.device-credential-isolation.1.tmp',
      'device-auth',
      'device.json',
      'device.json.1.tmp',
      'platform.json.backup',
      'device-enroll-pending.json',
      'device-enroll-pending.json.42.random.tmp',
    ]) expect(isCredentialIsolationReservedBasename(name)).toBe(true);
    expect(isCredentialIsolationReservedBasename('device.jsonx')).toBe(false);
    expect(isCredentialIsolationReservedBasename('ordinary.json')).toBe(false);
  });

  it('activates on marker OR device credential and bypasses only the remote backend', () => {
    expect(credentialIsolationRequired({ markerExists: false, deviceCredentialExists: false })).toBe(false);
    expect(credentialIsolationRequired({ markerExists: true, deviceCredentialExists: false })).toBe(true);
    expect(credentialIsolationRequired({ markerExists: false, deviceCredentialExists: true })).toBe(true);
    expect(evaluateCredentialOnlyIsolationGate({
      markerExists: true,
      deviceCredentialExists: false,
      remoteBackend: true,
      platform: 'win32',
      mechanismAvailable: false,
      fullIsolationCoversCredentials: false,
    })).toEqual({ required: true, mode: 'remote-bypass' });
  });

  it('is independent of adapter support/default sandbox config and chooses the minimal local wrapper', () => {
    // No adapterSupports/sandbox input exists by design: this is the regression
    // guard for unsupported adapters and the default sandbox=false path.
    expect(evaluateCredentialOnlyIsolationGate({
      markerExists: true,
      deviceCredentialExists: false,
      remoteBackend: false,
      platform: 'darwin',
      mechanismAvailable: true,
      fullIsolationCoversCredentials: false,
    })).toEqual({ required: true, mode: 'seatbelt' });
    expect(evaluateCredentialOnlyIsolationGate({
      markerExists: false,
      deviceCredentialExists: true,
      remoteBackend: false,
      platform: 'linux',
      mechanismAvailable: true,
      fullIsolationCoversCredentials: false,
    })).toEqual({ required: true, mode: 'bwrap' });
    expect(evaluateCredentialOnlyIsolationGate({
      markerExists: true,
      deviceCredentialExists: false,
      remoteBackend: false,
      platform: 'linux',
      mechanismAvailable: false,
      fullIsolationCoversCredentials: true,
    })).toEqual({ required: true, mode: 'covered' });
  });

  it('fails closed without a local execution mechanism or on unsupported platforms', () => {
    const linux = evaluateCredentialOnlyIsolationGate({
      markerExists: true,
      deviceCredentialExists: false,
      remoteBackend: false,
      platform: 'linux',
      mechanismAvailable: false,
      fullIsolationCoversCredentials: false,
    });
    expect(linux.mode).toBe('blocked');
    const windows = evaluateCredentialOnlyIsolationGate({
      markerExists: true,
      deviceCredentialExists: false,
      remoteBackend: false,
      platform: 'win32',
      mechanismAvailable: true,
      fullIsolationCoversCredentials: false,
    });
    expect(windows.mode).toBe('blocked');
  });

  it('builds exact + sidecar read/write rules for fixed and custom roots', () => {
    const rules = buildCredentialIsolationRules({
      homeDir: '/Users/bot',
      defaultBotmuxHome: '/private/default-botmux',
      botmuxHome: '/srv/botmux',
    });
    for (const root of ['/private/default-botmux', '/srv/botmux']) {
      expect(rules.denyPaths).toContain(`${root}/device-auth`);
      expect(rules.denyWritePaths).toContain(`${root}/device-auth`);
      for (const file of ['device.json', 'platform.json', 'device-enroll-pending.json']) {
        expect(rules.denyPaths).toContain(`${root}/${file}`);
        expect(rules.denyWritePaths).toContain(`${root}/${file}`);
        const sidecar = `${root}/${file}.12.random.tmp`;
        expect(rules.denyRegexes.some(pattern => new RegExp(pattern).test(sidecar))).toBe(true);
        expect(rules.denyWriteRegexes.some(pattern => new RegExp(pattern).test(sidecar))).toBe(true);
      }
    }
    expect(rules.denyPaths).toContain('/private/default-botmux/.device-credential-isolation');
    expect(rules.denyWriteLiterals).toEqual(['/private/default-botmux', '/srv/botmux']);
  });
});

describe('buildCliExecutableReadCarveOuts', () => {
  it('re-opens only the standalone Codex package tree when the canonical binary lives there', () => {
    expect(buildCliExecutableReadCarveOuts({
      homeDir: '/Users/bot',
      cliId: 'codex',
      resolvedBin: '/Users/bot/.codex/packages/standalone/releases/0.144.1/bin/codex',
    })).toEqual(['/Users/bot/.codex/packages/standalone']);
  });

  it('does not broaden reads for system/npm Codex installs or other CLIs', () => {
    expect(buildCliExecutableReadCarveOuts({
      homeDir: '/Users/bot', cliId: 'codex', resolvedBin: '/opt/homebrew/bin/codex',
    })).toEqual([]);
    expect(buildCliExecutableReadCarveOuts({
      homeDir: '/Users/bot', cliId: 'claude-code',
      resolvedBin: '/Users/bot/.codex/packages/standalone/releases/x/bin/claude',
    })).toEqual([]);
  });
});

describe('v2 HYBRID model (buildV2DenyPaths)', () => {
  it('botHomePath is per-appId under BOTMUX_HOME/bots', () => {
    expect(botHomePath('/Users/bot/.botmux', 'cli_self')).toBe('/Users/bot/.botmux/bots/cli_self');
  });

  it('WHOLE-denies the CLI data dirs (F1): ~/.claude, ~/.claude.json, ~/.codex', () => {
    const d = buildV2DenyPaths(v2());
    expect(d).toContain('/Users/bot/.claude');
    expect(d).toContain('/Users/bot/.claude.json');
    expect(d).toContain('/Users/bot/.codex');
  });

  it('denies the broadened system-credential set (review M1)', () => {
    const d = buildV2DenyPaths(v2());
    for (const p of ['/Users/bot/.ssh', '/Users/bot/.aws', '/Users/bot/Library/Keychains',
      '/Users/bot/.gnupg', '/Users/bot/.netrc', '/Users/bot/.config/gcloud',
      '/Users/bot/.config/1Password', '/Users/bot/.password-store']) expect(d).toContain(p);
  });

  it('SURGICAL on ~/.botmux: denies the cross-bot sensitive parts, NOT the whole tree', () => {
    const d = buildV2DenyPaths(v2());
    // denied: secrets + other bots + content
    expect(d).toContain('/Users/bot/.botmux/bots.json');
    expect(d).toContain('/Users/bot/.botmux/logs');
    expect(d).toContain('/Users/bot/.lark-cli-bots');            // WHOLESALE (covers every sibling)
    // WHOLESALE deny of bots/ — covers EVERY sibling BOT_HOME, including bots added
    // AFTER this bot spawned (no cold-restart to pick them up). No per-sibling entries.
    expect(d).toContain('/Users/bot/.botmux/bots');
    expect(d).toContain('/Users/bot/.botmux/data/sessions.json'); // legacy shared store
    expect(d).toContain('/Users/bot/.botmux/data/frozen-cards');
    expect(d).toContain('/Users/bot/.botmux/data/turn-sends');
    expect(d).toContain('/Users/bot/.botmux/data/queues');        // all bots' inbound message content
    expect(d).toContain('/Users/bot/.botmux/data/read-isolation'); // profiles enumerate sibling sessions
    expect(d).toContain('/Users/bot/.botmux/data/.botmux-cli-pids'); // live cross-session tuples
    expect(d).toContain('/Users/bot/.botmux/data/pi-initial-prompts'); // hidden first-turn context
    // schedules.json is a read-modify-write store — denying the read makes a
    // sandboxed `botmux schedule` load an empty map then overwrite the shared
    // file, wiping every bot's tasks. Deliberately NOT denied (accept the minor
    // leak of others' scheduled prompts) until schedule-store fail-closes. PR #387.
    expect(d).not.toContain('/Users/bot/.botmux/data/schedules.json');
    expect(d).toContain('/Users/bot/.botmux/feishu-session.json'); // Feishu web login session (can mint bots)
    expect(d).toContain('/Users/bot/.botmux/.dashboard-secret');   // loopback-HMAC signing key (mints write tokens)
    expect(d).toContain('/Users/bot/.botmux/.dashboard-token');    // dashboard admin bearer token
    // `.dashboard-port` is a bare port number (no credential value) — must stay readable
    expect(d).not.toContain('/Users/bot/.botmux/.dashboard-port');
    // NO per-sibling enumeration anywhere: sibling session stores are covered by the
    // filename-pattern regex (buildV2DenyRegexes), not per-appId path entries.
    expect(d.some((p) => p.includes('cli_other'))).toBe(false);
    // NOT denied — the whole tree, own data, and the tooling botmux CLI needs
    expect(d).not.toContain('/Users/bot/.botmux');                     // never whole-denied
    expect(d).not.toContain('/Users/bot/.botmux/data');                // data dir listable
    expect(d).not.toContain('/Users/bot/.botmux/bots/cli_self');       // own not a plain deny; re-allowed via carve-out
    expect(d).not.toContain('/Users/bot/.botmux/data/sessions-cli_self.json');
    expect(d).not.toContain('/Users/bot/.botmux/config.json');         // config readable
    expect(d).not.toContain('/Users/bot/.lark-cli-bots/cli_self');     // own lark readable
  });

  it('denies dashboard credentials at the fixed home and custom BOTMUX_HOME', () => {
    const custom = v2({
      botmuxHome: '/srv/botmux',
      sessionDataDir: '/srv/botmux/data',
    });
    const deny = buildV2DenyPaths(custom);
    for (const path of [
      '/Users/bot/.botmux/.dashboard-secret',
      '/Users/bot/.botmux/.dashboard-token',
      '/srv/botmux/.dashboard-secret',
      '/srv/botmux/.dashboard-token',
      '/srv/botmux/data/.botmux-cli-pids',
    ]) expect(deny).toContain(path);

    const regexes = buildV2DenyRegexes(custom).map(pattern => new RegExp(pattern));
    for (const path of [
      '/Users/bot/.botmux/.dashboard-secret.123.tmp',
      '/Users/bot/.botmux/.dashboard-token.repair.lock',
      '/Users/bot/.botmux/.dashboard-secret.repair-seed',
      '/srv/botmux/.dashboard-secret.456.tmp',
      '/srv/botmux/.dashboard-token.repair.lock',
      '/srv/botmux/.dashboard-secret.repair-seed',
    ]) expect(regexes.some(regex => regex.test(path))).toBe(true);
    expect(regexes.some(regex => regex.test('/Users/bot/.botmux/.dashboard-secretx'))).toBe(false);
  });

  it('denies device and machine credentials at fixed/custom roots, including atomic sidecars', () => {
    const ctx = v2({
      botmuxHome: '/srv/botmux',
      sessionDataDir: '/srv/botmux/data',
    });
    const credentialPaths = [
      '/Users/bot/.botmux/device-auth',
      '/Users/bot/.botmux/device.json',
      '/Users/bot/.botmux/platform.json',
      '/Users/bot/.botmux/device-enroll-pending.json',
      '/srv/botmux/device-auth',
      '/srv/botmux/device.json',
      '/srv/botmux/platform.json',
      '/srv/botmux/device-enroll-pending.json',
    ];
    const rootCredentialFiles = credentialPaths.filter(path => !path.endsWith('/device-auth'));
    const deny = buildV2DenyPaths(ctx);
    for (const path of credentialPaths) expect(deny).toContain(path);

    const readRegexes = buildV2DenyRegexes(ctx).map(pattern => new RegExp(pattern));
    for (const path of [
      ...rootCredentialFiles,
      '/Users/bot/.botmux/device.json.42.a1b2c3d4.tmp',
      '/Users/bot/.botmux/platform.json.42.a1b2c3d4.tmp',
      '/Users/bot/.botmux/device-enroll-pending.json.42.a1b2c3d4.tmp',
      '/srv/botmux/device.json.backup',
      '/srv/botmux/platform.json.42.a1b2c3d4.tmp',
      '/srv/botmux/device-enroll-pending.json.recovery',
    ]) expect(readRegexes.some(regex => regex.test(path))).toBe(true);
    expect(readRegexes.some(regex => regex.test('/srv/botmux/device.jsonx'))).toBe(false);

    const protectedWrites = buildReadIsolationProtectedWriteRules(ctx);
    for (const path of credentialPaths) expect(protectedWrites.denyWritePaths).toContain(path);
    const writeRegexes = protectedWrites.denyWriteRegexes.map(pattern => new RegExp(pattern));
    expect(writeRegexes.some(regex => regex.test(
      '/srv/botmux/device.json.42.a1b2c3d4.tmp',
    ))).toBe(true);

    // Host credentials never receive an own-bot carve-out.
    const carve = buildV2CarveOuts(ctx);
    for (const path of credentialPaths) expect(carve.allowPaths).not.toContain(path);
  });

  it('uses the canonical fixed dashboard root for exact and sidecar rules', () => {
    const ctx = v2({
      defaultBotmuxHome: '/private/state/default-botmux',
      botmuxHome: '/srv/botmux',
      sessionDataDir: '/srv/botmux/data',
    });
    expect(buildV2DenyPaths(ctx)).toContain(
      '/private/state/default-botmux/.dashboard-secret',
    );
    const regexes = buildV2DenyRegexes(ctx).map(pattern => new RegExp(pattern));
    expect(regexes.some(regex => regex.test(
      '/private/state/default-botmux/.dashboard-secret.repair-seed',
    ))).toBe(true);
    const protectedWrites = buildReadIsolationProtectedWriteRules(ctx);
    expect(protectedWrites.denyWriteLiterals).toContain('/private/state/default-botmux');
  });

  it('protects both lexical root entries and canonical authority targets', () => {
    const canonical = v2({
      homeDir: '/private/home/bot',
      defaultBotmuxHome: '/private/state/default-botmux',
      botmuxHome: '/private/state/custom-botmux',
      sessionDataDir: '/private/state/custom-botmux/data',
    });
    const rules = buildReadIsolationProtectedWriteRules(canonical, {
      dashboardRoots: ['/Users/bot/.botmux', '/srv/botmux'],
      sessionDataDirs: ['/srv/botmux/data'],
    });
    for (const root of [
      '/private/state/default-botmux',
      '/private/state/custom-botmux',
      '/private/state/custom-botmux/data',
      '/Users/bot/.botmux',
      '/srv/botmux',
      '/srv/botmux/data',
    ]) expect(rules.denyWriteLiterals).toContain(root);
    expect(rules.denyWritePaths).toContain('/Users/bot/.botmux/.dashboard-secret');
    expect(rules.denyWritePaths).toContain('/srv/botmux/data/read-isolation');
  });

  it('denies per-bot session stores by filename PATTERN, re-allows only the own one', () => {
    // The regex covers EVERY sessions-<appId>.json — including bots added later —
    // without any sibling-appId enumeration.
    const regexes = buildV2DenyRegexes(v2());
    expect(regexes[0]).toBe('^/Users/bot/\\.botmux/data/sessions-[^/]+\\.json$');
    const re = new RegExp(regexes[0]);
    expect(re.test('/Users/bot/.botmux/data/sessions-cli_other1.json')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/sessions-cli_self.json')).toBe(true); // own matches too…
    expect(re.test('/Users/bot/.botmux/data/sessions.json')).toBe(false);          // legacy handled by path deny
    expect(re.test('/Users/bot/.botmux/data/sub/sessions-x.json')).toBe(false);    // same dir only
    // …but the own file is re-opened by a carve-out allow (Seatbelt last-match).
    expect(buildV2CarveOuts(v2()).allowPaths).toContain('/Users/bot/.botmux/data/sessions-cli_self.json');
  });

  it('keeps plugin-private MCP descriptors and every session snapshot host-only', () => {
    const ctx = v2({
      botmuxHome: '/srv/botmux',
      sessionDataDir: '/srv/botmux/data',
    });
    const regexes = buildV2DenyRegexes(ctx).map(pattern => new RegExp(pattern));
    for (const path of [
      '/Users/bot/.botmux/plugins/demo/private/mcp.json',
      '/srv/botmux/plugins/demo/private/mcp.json',
      '/Users/bot/.botmux/plugins/demo/dist/mcp/index.json',
      '/srv/botmux/data/sessions/session-self/plugin-mcp-runtime.json',
      '/srv/botmux/data/sessions/session-other/plugin-mcp-runtime.json',
    ]) expect(regexes.some(regex => regex.test(path))).toBe(true);

    const ownSnapshot = '/srv/botmux/data/sessions/session-self/plugin-mcp-runtime.json';
    const siblingSnapshot = '/srv/botmux/data/sessions/session-other/plugin-mcp-runtime.json';
    const carve = buildV2CarveOuts(ctx);
    expect(carve.allowPaths).not.toContain(ownSnapshot);
    expect(carve.allowPaths).not.toContain(siblingSnapshot);
    const profile = buildSeatbeltProfile(
      buildV2DenyPaths(ctx),
      carve.allowPaths,
      carve.finalDenyPaths,
      carve.traverseDirs,
      buildV2DenyRegexes(ctx),
    );
    expect(profile).not.toContain(`(allow file-read* (subpath "${ownSnapshot}"))`);

    const protectedWrites = buildReadIsolationProtectedWriteRules(ctx);
    const writeRegexes = protectedWrites.denyWriteRegexes.map(pattern => new RegExp(pattern));
    expect(writeRegexes.some(regex => regex.test(ownSnapshot))).toBe(true);
    expect(writeRegexes.some(regex => regex.test('/Users/bot/.botmux/plugins/demo/private/mcp.json'))).toBe(true);
  });

  it('denies every bots.json SIDECAR (backup/temp) — .bak carries all siblings secrets', () => {
    // Regression: the exact bots.json is subpath-denied, but its setup/migration
    // backups (bots.json.bak, .bak.<suffix>, .tmp) carry the SAME plaintext
    // larkAppSecret for every bot under a different basename, which subpath does
    // NOT match. Without the sidecar regex an isolated bot could `cat bots.json.bak`
    // and recover all siblings' credentials.
    const re = new RegExp(buildV2DenyRegexes(v2())[1]);
    expect(re.test('/Users/bot/.botmux/bots.json.bak')).toBe(true);
    expect(re.test('/Users/bot/.botmux/bots.json.bak.isotest.1783089554')).toBe(true);
    expect(re.test('/Users/bot/.botmux/bots.json.tmp')).toBe(true);
    // The exact file is the subpath deny's job (not this regex), and unrelated
    // basenames must not be swept in.
    expect(re.test('/Users/bot/.botmux/bots.json')).toBe(false);
    expect(re.test('/Users/bot/.botmux/bots.jsonx')).toBe(false);
    // The exact bots.json is still covered by the path deny.
    expect(buildV2DenyPaths(v2())).toContain('/Users/bot/.botmux/bots.json');
  });

  it('own attachments bucket re-allowed under the wholesale attachments/ deny (Feishu uploads)', () => {
    // The agent must read files the user uploads in chat. attachments/ is keyed
    // per-appId (getAttachmentsDir) precisely because the Seatbelt profile is
    // static at spawn time — only a spawn-time-known key (the appId) can anchor
    // the carve-out. Siblings' buckets and the legacy flat attachments/<messageId>
    // layout stay under the wholesale deny.
    const d = buildV2DenyPaths(v2());
    expect(d).toContain('/Users/bot/.botmux/data/attachments');
    const carve = buildV2CarveOuts(v2());
    expect(carve.allowPaths).toContain('/Users/bot/.botmux/data/attachments/cli_self');
    // traverse shim so Read/realpath can stat through the denied parent without listing it
    expect(carve.traverseDirs).toContain('/Users/bot/.botmux/data/attachments');
  });

  it('denies LEGACY data-root send-cred files by pattern (pre-BOT_HOME leftovers)', () => {
    // Older builds wrote `<sd>/.send-cred-<appId>` at the data root; current builds
    // write inside BOT_HOME. The leftovers still hold live send credentials and the
    // data root is readable by design — so the legacy filename class must be denied.
    const re = new RegExp(buildV2DenyRegexes(v2()).find(r => r.includes('send-cred'))!);
    expect(re.test('/Users/bot/.botmux/data/.send-cred-cli_other1')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/.send-cred-cli_self')).toBe(true); // own legacy too — CLI reads BOT_HOME copy
    expect(re.test('/Users/bot/.botmux/data/send-cred.json')).toBe(false);
  });

  it('denies every identities-<appId>.json (interlocutor PII cache) — no own carve-out', () => {
    // open_id→display-name caches are daemon-side prompt-injection data; the CLI
    // never reads them, so unlike sessions-<appId>.json the OWN file gets no allow.
    const re = new RegExp(buildV2DenyRegexes(v2()).find(r => r.includes('identities'))!);
    expect(re.test('/Users/bot/.botmux/data/identities-cli_other1.json')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/identities-cli_self.json')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/sub/identities-x.json')).toBe(false); // same dir only
    const carve = buildV2CarveOuts(v2());
    expect(carve.allowPaths.some(p => p.includes('identities-'))).toBe(false);
  });

  it('send-cred lives inside BOT_HOME (unified per-bot private storage)', () => {
    // The botmux-send credential is stored in the bot's BOT_HOME, the SAME private
    // storage as its CLI data — one deny mechanism protects both (and any future
    // per-bot secret, e.g. a github token, dropped in there). sendCredFilePath takes
    // SESSION_DATA_DIR and derives BOTMUX_HOME (its parent) internally, matching the
    // worker's BOT_HOME = botHomePath(dirname(SESSION_DATA_DIR)).
    expect(sendCredFilePath('/Users/bot/.botmux/data', 'cli_self'))
      .toBe('/Users/bot/.botmux/bots/cli_self/send-cred.json');
    const d = buildV2DenyPaths(v2());
    // an OTHER bot's send-cred sits under its BOT_HOME → covered by the wholesale bots/ deny
    expect(sendCredFilePath('/Users/bot/.botmux/data', 'cli_other2'))
      .toBe('/Users/bot/.botmux/bots/cli_other2/send-cred.json');
    expect(d).toContain('/Users/bot/.botmux/bots');
    // own send-cred is under own BOT_HOME → readable via the carve-out
    expect(buildV2CarveOuts(v2()).allowPaths).toContain('/Users/bot/.botmux/bots/cli_self');
  });

  it('send-cred path follows a customized SESSION_DATA_DIR (review: codex)', () => {
    // BOTMUX_HOME is defined as dirname(SESSION_DATA_DIR); a custom data dir must
    // still resolve worker-write and deny to the SAME BOT_HOME — no hardcoded ~/.botmux.
    expect(sendCredFilePath('/var/botmux/data', 'cli_x'))
      .toBe('/var/botmux/bots/cli_x/send-cred.json');
    // the session-store regex must also follow the custom data dir
    expect(buildV2DenyRegexes(v2({ sessionDataDir: '/var/botmux/data' }))[0])
      .toBe('^/var/botmux/data/sessions-[^/]+\\.json$');
  });

  it('buildV2CarveOuts: own slices allowed + traverse shims + extraDenyPaths as FINAL deny', () => {
    const carve = buildV2CarveOuts(v2());
    // own slice of EACH wholesale/pattern-denied per-bot class re-allowed
    expect(carve.allowPaths).toEqual([
      '/Users/bot/.botmux/bots/cli_self',
      '/Users/bot/.lark-cli-bots/cli_self',
      '/Users/bot/.botmux/data/sessions-cli_self.json',
      '/Users/bot/.botmux/data/attachments/cli_self',
      managedOriginCapabilityPath('/Users/bot/.botmux/data', 'session-self', G1),
      managedOriginAttestationDirectory('/Users/bot/.botmux/data', 'session-self', G1),
      managedOriginRootLocatorPath('/Users/bot', 'session-self'),
    ]);
    // traverse shim on each wholesale-denied parent (stat/realpath, not listing)
    expect(carve.traverseDirs).toEqual([
      '/Users/bot/.botmux/bots',
      '/Users/bot/.lark-cli-bots',
      '/Users/bot/.botmux/data/attachments',
      '/Users/bot/.botmux/data/read-isolation',
    ]);
    expect(carve.finalDenyPaths).toEqual([]);
    // an admin deny UNDER the own BOT_HOME must WIN over the carve-out → goes to finalDeny
    const extra = '/Users/bot/.botmux/bots/cli_self/claude/.credentials.json';
    const c2 = buildV2CarveOuts(v2({ extraDenyPaths: [extra] }));
    expect(c2.finalDenyPaths).toContain(extra);
    expect(buildV2DenyPaths(v2({ extraDenyPaths: [extra] }))).not.toContain(extra); // not a plain deny
  });

  it('drops relative / traversal extraDenyPaths instead of silently keeping them', () => {
    const c = buildV2CarveOuts(v2({ extraDenyPaths: ['relative/x', '/a/../b', '/ok/path'] }));
    expect(c.finalDenyPaths).toEqual(['/ok/path']);
  });

  it('rejects unsafe app ids and hashes session ids before using them in paths', () => {
    expect(assertSafeAppId('cli_aab4eaea67395bc9')).toBe('cli_aab4eaea67395bc9');
    expect(() => assertSafeAppId('../evil')).toThrow();
    expect(() => assertSafeAppId('a/b')).toThrow();
    expect(() => assertSafeAppId('')).toThrow();
    // pure-dot ids are path-traversal segments: as a carve-out subpath, `bots/..`
    // canonicalizes to the PARENT (~/.botmux) and — emitted after the deny — would
    // re-open bots.json / bots/ / logs. Must be rejected (codex review).
    expect(() => assertSafeAppId('.')).toThrow();
    expect(() => assertSafeAppId('..')).toThrow();
    expect(() => assertSafeAppId('...')).toThrow();
    expect(() => buildV2CarveOuts(v2({ currentAppId: '..' }))).toThrow();
    expect(buildV2CarveOuts(v2({ currentSessionId: '../other' })).allowPaths).toContain(
      managedOriginCapabilityPath('/Users/bot/.botmux/data', '../other', G1),
    );
    // botHomePath must also reject an unsafe id (used for own + other BOT_HOMEs)
    expect(() => botHomePath('/Users/bot/.botmux', '../x')).toThrow();
  });
});

describe('buildSeatbeltProfile (verified format)', () => {
  it('emits allow-default + a file-read deny subpath per denied path', () => {
    const prof = buildSeatbeltProfile(buildV2DenyPaths(v2()));
    expect(prof).toContain('(version 1)');
    expect(prof).toContain('(allow default)');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots.json"))');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots"))');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/device-auth"))');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/device.json"))');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/platform.json"))');
  });

  it('emits carve-out allows AFTER the denies (last-match wins) so own slices re-open', () => {
    const carve = buildV2CarveOuts(v2());
    const prof = buildSeatbeltProfile(
      buildV2DenyPaths(v2()), carve.allowPaths, carve.finalDenyPaths, carve.traverseDirs,
      buildV2DenyRegexes(v2()));
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots"))');
    // traverse: realpath/stat through bots/ works, but LISTING (read-data) stays denied
    expect(prof).toContain('(allow file-read-metadata (literal "/Users/bot/.botmux/bots"))');
    expect(prof).toContain('(allow file-read* (subpath "/Users/bot/.botmux/bots/cli_self"))');
    // Seatbelt last-match-wins: own-allow MUST appear after the bots/ deny
    expect(prof.indexOf('(allow file-read* (subpath "/Users/bot/.botmux/bots/cli_self"))'))
      .toBeGreaterThan(prof.indexOf('(deny file-read* (subpath "/Users/bot/.botmux/bots"))'));
    // pattern deny present (backslashes RAW inside the #"…" literal), and the own
    // session-file allow comes after it
    expect(prof).toContain('(deny file-read* (regex #"^/Users/bot/\\.botmux/data/sessions-[^/]+\\.json$"))');
    expect(prof.indexOf('(allow file-read* (subpath "/Users/bot/.botmux/data/sessions-cli_self.json"))'))
      .toBeGreaterThan(prof.indexOf('(deny file-read* (regex'));
  });

  it('FINAL denies come after the allows so admin extraDenyPaths win over the own carve-out', () => {
    const extra = '/Users/bot/.botmux/bots/cli_self/claude/.credentials.json';
    const carve = buildV2CarveOuts(v2({ extraDenyPaths: [extra] }));
    const prof = buildSeatbeltProfile(
      buildV2DenyPaths(v2()), carve.allowPaths, carve.finalDenyPaths, carve.traverseDirs);
    expect(prof.indexOf(`(deny file-read* (subpath "${extra}"))`))
      .toBeGreaterThan(prof.indexOf('(allow file-read* (subpath "/Users/bot/.botmux/bots/cli_self"))'));
  });

  it('carves only the current session capability/proof dir and keeps it write-denied', () => {
    const ownCapability = managedOriginCapabilityPath(
      '/Users/bot/.botmux/data',
      'session-self',
      G1,
    );
    const siblingCapability = managedOriginCapabilityPath(
      '/Users/bot/.botmux/data',
      'session-sibling',
      G2,
    );
    const ownProofDir = managedOriginAttestationDirectory(
      '/Users/bot/.botmux/data',
      'session-self',
      G1,
    );
    const siblingProofDir = managedOriginAttestationDirectory(
      '/Users/bot/.botmux/data',
      'session-sibling',
      G2,
    );
    const carve = buildV2CarveOuts(v2());
    expect(carve.allowPaths).toContain(ownCapability);
    expect(carve.allowPaths).not.toContain(siblingCapability);
    expect(carve.allowPaths).toContain(ownProofDir);
    expect(carve.allowPaths).not.toContain(siblingProofDir);

    const parent = '/Users/bot/.botmux/data/read-isolation';
    const protectedWrites = buildReadIsolationProtectedWriteRules(v2());
    const prof = buildSeatbeltProfile(
      buildV2DenyPaths(v2()),
      carve.allowPaths,
      carve.finalDenyPaths,
      carve.traverseDirs,
      buildV2DenyRegexes(v2()),
      undefined,
      protectedWrites,
    );
    const readAllow = `(allow file-read* (subpath "${ownCapability}"))`;
    const writeDeny = `(deny file-write* (subpath "${parent}"))`;
    expect(prof).toContain(readAllow);
    expect(prof).toContain(writeDeny);
    expect(prof.indexOf(writeDeny)).toBeGreaterThan(prof.indexOf(readAllow));
    expect(prof).not.toContain(`(allow file-write* (subpath "${ownProofDir}"))`);
    expect(prof).toContain(`(deny file-read* (subpath "${managedOriginIsolationSentinelPath('/Users/bot')}"))`);
    expect(prof).toContain(
      '(deny file-write* (subpath "/Users/bot/.botmux/.dashboard-secret"))',
    );
    expect(prof).toContain(
      '(deny file-write* (regex #"^/Users/bot/\\.botmux/\\.dashboard-secret(?:\\.|$)"))',
    );
    expect(prof).toContain(
      '(deny file-write* (literal "/Users/bot/.botmux"))',
    );
    expect(prof).toContain(
      '(deny file-write* (literal "/Users/bot/.botmux/data"))',
    );
  });

  it('no allowPaths → deny-only profile', () => {
    const prof = buildSeatbeltProfile(['/Users/bot/.botmux/bots.json']);
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots.json"))');
    expect(prof).not.toContain('(allow file-read* (subpath');
  });
});

describe('evaluateReadIsolationGate (fail-closed, single decision point)', () => {
  const ok = {
    configured: true,
    adapterSupports: true,
    wrapperCliSet: false,
    platform: 'darwin',
    sessionDataDirSet: true,
  };

  it('disabled (no fail-closed) when not configured', () => {
    expect(evaluateReadIsolationGate({ ...ok, configured: false })).toEqual({ enabled: false });
  });

  it('enables when everything is satisfied', () => {
    expect(evaluateReadIsolationGate(ok)).toEqual({ enabled: true });
  });

  it('fail-closed when adapter does not support isolation', () => {
    const r = evaluateReadIsolationGate({ ...ok, adapterSupports: false });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toMatch(/support/i);
  });

  it('fail-closed when wrapperCli is set (strips the spawn args)', () => {
    const r = evaluateReadIsolationGate({ ...ok, wrapperCliSet: true });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toMatch(/wrapperCli/i);
  });

  it('ENABLED on Linux (bwrap masks) as well as macOS; unsupported elsewhere', () => {
    const linux = evaluateReadIsolationGate({ ...ok, platform: 'linux' });
    expect(linux.enabled).toBe(true);           // Linux read-iso now enforced via bwrap masks
    expect(linux.failClosedReason).toBeUndefined();
    const darwin = evaluateReadIsolationGate({ ...ok, platform: 'darwin' });
    expect(darwin.enabled).toBe(true);
    const win = evaluateReadIsolationGate({ ...ok, platform: 'win32' });
    expect(win.enabled).toBe(false);
    expect(win.failClosedReason).toMatch(/unsupported/i);
  });

  it('fail-closed when SESSION_DATA_DIR is missing', () => {
    const r = evaluateReadIsolationGate({ ...ok, sessionDataDirSet: false });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toMatch(/SESSION_DATA_DIR/);
  });
});

describe('macOS write-sandbox (buildWriteSandboxRules)', () => {
  it('allows the project + CLI scratch/cache, protects home & other bots', () => {
    const r = buildWriteSandboxRules(ws());
    // the project persists writes (the whole point)
    expect(r.allowWritePaths).toContain('/Users/bot/projects/app');
    // own BOT_HOME (where read-iso redirects CLI data when co-enabled)
    expect(r.allowWritePaths).toContain('/Users/bot/.botmux/bots/cli_self');
    // CLI data + ephemeral scratch the CLI/tools need
    expect(r.allowWritePaths).toContain('/Users/bot/.claude');
    expect(r.allowWritePaths).toContain('/Users/bot/.codex');
    expect(r.allowWritePaths).toContain('/Users/bot/.claude.lock');
    expect(r.allowWritePaths).toContain('/Users/bot/.claude.json.lock');
    expect(r.allowWritePaths).toContain('/Users/bot/.local/state/claude');
    expect(r.allowWriteRegexes).toContain('^/Users/bot/\\.claude\\.json\\.tmp\\.[^/]+$');
    expect(r.allowWritePaths).toContain('/private/var/folders');
    expect(r.allowWritePaths).toContain('/dev');
    // NOT writable: home dotfiles at large are protected by the profile's deny-all
    // baseline (they simply never appear in the allow-list)
    expect(r.allowWritePaths).not.toContain('/Users/bot');
    expect(r.allowWritePaths).not.toContain('/Users/bot/.ssh');
  });

  it('re-denies crown jewels so a broad project/home cannot reach them', () => {
    const r = buildWriteSandboxRules(ws());
    expect(r.denyWritePaths).toContain('/Users/bot/.ssh');
    expect(r.denyWritePaths).toContain('/Users/bot/.aws');
    expect(r.denyWritePaths).toContain('/Users/bot/.botmux/bots.json'); // can't tamper other bots' creds
    expect(r.denyWritePaths).toContain('/Users/bot/.botmux/.dashboard-secret');
    expect(r.denyWritePaths).toContain('/Users/bot/.botmux/device-auth');
    expect(r.denyWritePaths).toContain('/Users/bot/.botmux/device.json');
    expect(r.denyWritePaths).toContain('/Users/bot/.botmux/platform.json');
    expect(r.denyWritePaths).toContain('/Users/bot/.botmux/device-enroll-pending.json');
    const denyRegexes = r.denyWriteRegexes.map(pattern => new RegExp(pattern));
    expect(denyRegexes.some(regex => regex.test(
      '/Users/bot/.botmux/device.json.42.a1b2c3d4.tmp',
    ))).toBe(true);

    const custom = buildWriteSandboxRules(ws({
      botmuxHome: '/private/state/custom-botmux',
      defaultBotmuxHome: '/private/state/default-botmux',
      sessionDataDir: '/private/state/custom-botmux/data',
    }));
    for (const path of [
      '/private/state/default-botmux/device-auth',
      '/private/state/default-botmux/device.json',
      '/private/state/default-botmux/platform.json',
      '/private/state/default-botmux/device-enroll-pending.json',
      '/private/state/custom-botmux/device-auth',
      '/private/state/custom-botmux/device.json',
      '/private/state/custom-botmux/platform.json',
      '/private/state/custom-botmux/device-enroll-pending.json',
    ]) expect(custom.denyWritePaths).toContain(path);
  });

  it('folds extraWritePaths (custom TMPDIR / worktrees) and drops unsafe ones', () => {
    const r = buildWriteSandboxRules(ws({ extraWritePaths: ['/custom/tmp', 'relative/x', '/a/../b'] }));
    expect(r.allowWritePaths).toContain('/custom/tmp');
    expect(r.allowWritePaths).not.toContain('relative/x');   // normalizeIsolationPath drops it
    expect(r.allowWritePaths.some(p => p.includes('..'))).toBe(false);
  });

  it('buildSeatbeltProfile emits deny-all-writes + allow-list + final crown-jewel denies, in order', () => {
    const prof = buildSeatbeltProfile([], [], [], [], [], {
      allowWritePaths: ['/Users/bot/projects/app'],
      allowWriteRegexes: ['^/Users/bot/\\.claude\\.json\\.tmp\\.[^/]+$'],
      denyWritePaths: ['/Users/bot/.ssh'],
      denyWriteRegexes: ['^/Users/bot/\\.botmux/device\\.json(?:\\.|$)'],
    });
    expect(prof).toContain('(deny file-write* (subpath "/"))');
    expect(prof).toContain('(allow file-write* (subpath "/Users/bot/projects/app"))');
    expect(prof).toContain('(allow file-write* (regex #"^/Users/bot/\\.claude\\.json\\.tmp\\.[^/]+$"))');
    expect(prof).toContain('(deny file-write* (subpath "/Users/bot/.ssh"))');
    expect(prof).toContain('(deny file-write* (regex #"^/Users/bot/\\.botmux/device\\.json(?:\\.|$)"))');
    // ORDER matters (Seatbelt last-match wins): deny-all < allow project < final deny ssh
    const iDenyAll = prof.indexOf('(deny file-write* (subpath "/"))');
    const iAllow = prof.indexOf('(allow file-write* (subpath "/Users/bot/projects/app"))');
    const iDenySsh = prof.indexOf('(deny file-write* (subpath "/Users/bot/.ssh"))');
    expect(iDenyAll).toBeLessThan(iAllow);
    expect(iAllow).toBeLessThan(iDenySsh);
    // reads untouched — no file-read denies when only write-sandbox is passed
    expect(prof).not.toContain('(deny file-read*');
  });

  it('omitting the write param leaves a read-only profile with NO write rules', () => {
    const prof = buildSeatbeltProfile(['/Users/bot/.ssh']);
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.ssh"))');
    expect(prof).not.toContain('file-write*');
  });
});

describe('Linux read isolation (buildLinuxReadIsolationMasks)', () => {
  it('masks the shared cross-bot sensitive set + per-sibling paths; own BOT_HOME stays real+writable', () => {
    const r = buildLinuxReadIsolationMasks({ ctx: v2(), siblingAppIds: ['cli_other1', 'cli_other2'] });
    // shared sensitive (non-per-bot)
    for (const p of ['/Users/bot/.claude', '/Users/bot/.codex', '/Users/bot/.ssh',
      '/Users/bot/.botmux/bots.json', '/Users/bot/.botmux/feishu-session.json',
      '/Users/bot/.botmux/.dashboard-secret', '/Users/bot/.botmux/data/frozen-cards',
      '/Users/bot/.botmux/data/queues',
      '/Users/bot/.botmux/data/pi-initial-prompts']) expect(r.hidePaths).toContain(p);
    // per-sibling (enumerated — no regex on bwrap)
    for (const p of ['/Users/bot/.botmux/bots/cli_other1', '/Users/bot/.lark-cli-bots/cli_other2',
      '/Users/bot/.botmux/data/sessions-cli_other1.json', '/Users/bot/.botmux/data/identities-cli_other2.json',
      '/Users/bot/.botmux/data/.send-cred-cli_other1']) expect(r.hidePaths).toContain(p);
    // attachments/ masked WHOLESALE (covers legacy flat layout too); own bucket re-exposed RO
    expect(r.hidePaths).toContain('/Users/bot/.botmux/data/attachments');
    expect(r.ownReadOnlyPaths).toEqual(['/Users/bot/.botmux/data/attachments/cli_self']);
    // OWN slice is NOT masked (readable via the overlay lower)
    expect(r.hidePaths).not.toContain('/Users/bot/.botmux/bots/cli_self');
    expect(r.hidePaths).not.toContain('/Users/bot/.botmux/data/sessions-cli_self.json');
    expect(r.hidePaths).not.toContain('/Users/bot/.lark-cli-bots/cli_self');
    // own identities/send-cred ARE masked (daemon-side only, no own carve-out — parity w/ macOS)
    expect(r.hidePaths).toContain('/Users/bot/.botmux/data/identities-cli_self.json');
    expect(r.hidePaths).toContain('/Users/bot/.botmux/data/.send-cred-cli_self');
    // own BOT_HOME kept real+writable (persists redirected CLI data)
    expect(r.ownReadWritePaths).toEqual(['/Users/bot/.botmux/bots/cli_self']);
    // NOT masked: schedules.json + whiteboards (same owner decision as macOS)
    expect(r.hidePaths).not.toContain('/Users/bot/.botmux/data/schedules.json');
    expect(r.hidePaths).not.toContain('/Users/bot/.botmux/data/whiteboards');
  });

  it('PARITY: every non-per-bot path macOS denies is also masked on Linux', () => {
    // Guard against the two platforms drifting: any shared-sensitive path added to
    // buildV2DenyPaths must also appear in the Linux mask set. The per-bot WHOLESALE
    // dirs (bots/, .lark-cli-bots/) are the only ones handled differently (enumerated
    // per-sibling), so exclude just those two from the comparison.
    const macDeny = buildV2DenyPaths(v2());
    const linux = buildLinuxReadIsolationMasks({ ctx: v2(), siblingAppIds: [] }).hidePaths;
    const wholesalePerBot = new Set([
      '/Users/bot/.botmux/bots',
      '/Users/bot/.lark-cli-bots',
      managedOriginIsolationSentinelPath('/Users/bot'),
    ]);
    const shouldMatch = macDeny.filter(p => !wholesalePerBot.has(p));
    for (const p of shouldMatch) expect(linux).toContain(p);
  });

  it('masks fixed-home and custom-root dashboard credentials on Linux', () => {
    const ctx = v2({
      botmuxHome: '/srv/botmux',
      sessionDataDir: '/srv/botmux/data',
    });
    const masks = buildLinuxReadIsolationMasks({ ctx, siblingAppIds: [] }).hidePaths;
    for (const path of [
      '/Users/bot/.botmux/.dashboard-secret',
      '/Users/bot/.botmux/.dashboard-token',
      '/srv/botmux/.dashboard-secret',
      '/srv/botmux/.dashboard-token',
      '/Users/bot/.botmux/device-auth',
      '/Users/bot/.botmux/device.json',
      '/Users/bot/.botmux/platform.json',
      '/Users/bot/.botmux/device-enroll-pending.json',
      '/Users/bot/.botmux/.device-credential-isolation',
      '/srv/botmux/device-auth',
      '/srv/botmux/device.json',
      '/srv/botmux/platform.json',
      '/srv/botmux/device-enroll-pending.json',
      '/srv/botmux/data/.botmux-cli-pids',
    ]) expect(masks).toContain(path);
  });

  it('folds bots.json sidecars + skips unsafe sibling ids', () => {
    const r = buildLinuxReadIsolationMasks({
      ctx: v2(),
      siblingAppIds: ['cli_ok', '../evil', 'bad/id'],
      botsJsonSidecars: ['/Users/bot/.botmux/bots.json.bak', '/Users/bot/.botmux/bots.json.tmp'],
    });
    expect(r.hidePaths).toContain('/Users/bot/.botmux/bots.json.bak');
    expect(r.hidePaths).toContain('/Users/bot/.botmux/bots/cli_ok');
    // unsafe sibling ids are dropped, never concatenated into a mask path
    expect(r.hidePaths.some(p => p.includes('evil') || p.includes('bad'))).toBe(false);
  });
});

describe('isolatedPaneReattachSafe', () => {
  it('trusts only panes stamped with the current isolation policy version and required capabilities', () => {
    expect(isolatedPaneReattachSafe(
      isolationPaneMarkerContent('boot-abc', ['credential', 'read', 'write']),
    )).toBe(true);
    const credentialOnly = isolationPaneMarkerContent('boot-abc', ['credential']);
    expect(isolatedPaneReattachSafe(credentialOnly, ['credential'])).toBe(true);
    expect(isolatedPaneReattachSafe(credentialOnly, ['credential', 'read'])).toBe(false);
    const full = isolationPaneMarkerContent('boot-abc', ['write', 'credential', 'read', 'write']);
    expect(JSON.parse(full).capabilities).toEqual(['credential', 'read', 'write']);
    expect(isolatedPaneReattachSafe(full, ['write', 'credential'])).toBe(true);
    // Legacy unversioned or older-policy panes keep their old Seatbelt rules in
    // memory and must be killed + cold-spawned after a security upgrade.
    expect(isolatedPaneReattachSafe('boot-abc')).toBe(false);
    expect(isolatedPaneReattachSafe(JSON.stringify({ version: 1, bootId: 'old' }))).toBe(false);
    expect(isolatedPaneReattachSafe(JSON.stringify({ version: 2, bootId: 'old-mcp-policy' }))).toBe(false);
    expect(isolatedPaneReattachSafe(JSON.stringify({ version: 5, bootId: 'pre-device-policy' }))).toBe(false);
    expect(isolatedPaneReattachSafe(JSON.stringify({ version: 7, bootId: 'missing-capabilities' }))).toBe(false);
    expect(isolatedPaneReattachSafe(JSON.stringify({
      version: 7, bootId: 'unknown-capability', capabilities: ['credential', 'network'],
    }))).toBe(false);
    // No / blank marker → pane was NOT spawned isolated → unsafe (kill + cold-spawn).
    expect(isolatedPaneReattachSafe(null)).toBe(false);
    expect(isolatedPaneReattachSafe(undefined)).toBe(false);
    expect(isolatedPaneReattachSafe('')).toBe(false);
    expect(isolatedPaneReattachSafe('   ')).toBe(false);
  });

  it('binds Darwin warm reattach to the pane channel and exact read/write policy', () => {
    const marker = isolationPaneMarkerContent(
      'boot-new',
      ['credential', 'read'],
      {
        originChannelId: G1,
        readIsolation: true,
        writeSandbox: false,
        policyDigest: POLICY1,
      },
    );
    expect(isolatedPaneOriginChannel(marker)).toBe(G1);
    expect(isolatedPaneReattachSafe(marker, {
      requiredCapabilities: ['credential', 'read'],
      readIsolation: true, writeSandbox: false, requireOriginChannel: true,
      policyDigest: POLICY1,
    })).toBe(true);
    expect(isolatedPaneReattachSafe(marker, {
      requiredCapabilities: ['credential', 'read'],
      readIsolation: false, writeSandbox: false, requireOriginChannel: true,
      policyDigest: POLICY1,
    })).toBe(false);
    const broadTmpDigest = isolationPanePolicyDigest({
      readIsolation: true,
      writeSandbox: true,
      writeAllowExtraPaths: ['/custom/broad-tmp'],
    });
    const narrowTmpDigest = isolationPanePolicyDigest({
      readIsolation: true,
      writeSandbox: true,
      writeAllowExtraPaths: ['/private/var/folders/narrow'],
    });
    const broadTmpMarker = isolationPaneMarkerContent('boot-old', ['credential', 'read', 'write'], {
      originChannelId: G1,
      readIsolation: true,
      writeSandbox: true,
      policyDigest: broadTmpDigest,
    });
    expect(isolatedPaneReattachSafe(broadTmpMarker, {
      requiredCapabilities: ['credential', 'read', 'write'],
      readIsolation: true,
      writeSandbox: true,
      requireOriginChannel: true,
      policyDigest: narrowTmpDigest,
    })).toBe(false);
    expect(isolatedPaneReattachSafe(marker, {
      requiredCapabilities: ['credential', 'read', 'write'],
      readIsolation: true, writeSandbox: true, requireOriginChannel: true,
      policyDigest: POLICY1,
    })).toBe(false);
    expect(isolatedPaneReattachSafe(marker, {
      requiredCapabilities: ['credential', 'read'],
      readIsolation: true,
      writeSandbox: false,
      requireOriginChannel: true,
      policyDigest: isolationPanePolicyDigest({
        readIsolation: true,
        writeSandbox: false,
        readDenyExtraPaths: ['/private/b'],
      }),
    })).toBe(false);
    expect(isolatedPaneReattachSafe(JSON.stringify({
      version: 4,
      bootId: 'legacy-v4',
      readIsolation: true,
      writeSandbox: false,
      originChannelId: G1,
    }), {
      requiredCapabilities: ['credential', 'read'],
      readIsolation: true,
      writeSandbox: false,
      requireOriginChannel: true,
      policyDigest: POLICY1,
    })).toBe(false);
    expect(isolatedPaneReattachSafe(isolationPaneMarkerContent(
      'linux-v7', ['credential', 'read'],
    ), {
      requiredCapabilities: ['credential', 'read'],
      requireOriginChannel: false,
    })).toBe(true);
    expect(isolatedPaneReattachSafe(isolationPaneMarkerContent(
      'linux-v7', ['credential', 'read'],
    ), {
      requiredCapabilities: ['credential', 'read'],
      requireOriginChannel: true,
    })).toBe(false);
  });
});

describe('worker capability carve-out ordering', () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('replaces a planted capability symlink before canonicalizing allow paths', () => {
    const publishAt = source.indexOf('publishSandboxRelayCapability({ failClosed: true })');
    const canonicalizeAt = source.indexOf(
      '...carve.allowPaths.map(path =>',
    );
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(canonicalizeAt).toBeGreaterThan(publishAt);
    expect(source).toContain('replaceManagedOriginCapabilityFile(profilePath, buildSeatbeltProfile(');
    expect(source).toContain('marker = readManagedOriginAuthorityFile(');
  });

  it('never lets old-generation teardown unlink the stable mac capability path', () => {
    const unlinkStart = source.indexOf('function unlinkManagedOriginCapabilityFiles()');
    const unlinkEnd = source.indexOf('/** Read a host-owned isolation marker', unlinkStart);
    const unlink = source.slice(unlinkStart, unlinkEnd);
    expect(unlink).toContain('sandboxRelayOutbox');
    expect(unlink).not.toContain('readIsolationOriginCapabilityFile ??');
    expect(source).toContain('ensureManagedOriginIsolationSentinel(osUserHomeDir)');
    expect(source).toContain('osUserHomeDir: canonical(');
  });

  it('denies every same-UID Gateway socket before allowing only the current session socket', () => {
    const regexAt = source.indexOf('const gatewaySocketRegex = sessionMcpGatewayPathRegex(gatewaySocketRoot)');
    const denyAt = source.indexOf('denyRegexes.push(gatewaySocketRegex)');
    const allowAt = source.indexOf(
      'if (sessionMcpGatewayHost) allowPaths.push(canonical(sessionMcpGatewayHost.socketDir))',
    );
    const writeDenyAt = source.indexOf(
      'denyWriteRegexes: [...(protectedWrites?.denyWriteRegexes ?? []), gatewaySocketRegex]',
    );
    const profileAt = source.indexOf('replaceManagedOriginCapabilityFile(profilePath, buildSeatbeltProfile(');
    expect(regexAt).toBeGreaterThanOrEqual(0);
    expect(denyAt).toBeGreaterThan(regexAt);
    expect(allowAt).toBeGreaterThan(denyAt);
    expect(writeDenyAt).toBeGreaterThan(allowAt);
    expect(profileAt).toBeGreaterThan(writeDenyAt);
  });

  it('carves back only the prepared Pi session prompt directory after masking the shared root', () => {
    expect(source).toContain('...piInitialPromptReadonlyRoots.map(canonical),');
    expect(source).toContain('...piInitialPromptReadonlyRoots,');
    expect(source).not.toContain(
      'cfg.skillReadonlyRoots = [...(cfg.skillReadonlyRoots ?? []), ...prepared.readonlyRoots]',
    );
  });

  it('enforces the mandatory credential gate before adopt and wraps wrapperCli from the outside', () => {
    const gateAt = source.indexOf('if (mandatoryCredentialIsolation && cfg.adoptMode)');
    const adoptAt = source.indexOf("if (cfg.adoptMode && cfg.adoptSource === 'herdr'");
    const wrapperAt = source.indexOf('if (cfg.wrapperCli && cfg.wrapperCli.trim())');
    const credentialWrapperAt = source.indexOf('if (!willReattachPersistent && credentialOnlySeatbelt)');
    const spawnAt = source.indexOf('backend.spawn(spawnBin, spawnArgs, {');
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(adoptAt);
    expect(credentialWrapperAt).toBeGreaterThan(wrapperAt);
    expect(credentialWrapperAt).toBeLessThan(spawnAt);
    expect(source).toContain('if (!willReattachPersistent && credentialOnlyBwrap)');
    expect(source).toContain('isCredentialIsolationReservedBasename(name)');
    expect(source).toContain('requiredCapabilities: appliedIsolationCapabilities');
  });
});

describe('CLI protected capability wiring', () => {
  const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const vcSource = readFileSync(new URL('../src/cli/vc-agent.ts', import.meta.url), 'utf8');

  it('requires host-file attestation when the fixed sentinel is kernel-denied', () => {
    expect(cliSource).toContain(
      'let liveMarkerCtx = findLiveAncestorSessionContext(sendDataDir);',
    );
    expect(cliSource).toContain(
      'managedOriginIsolationSentinelAccess(osUserHomeDir)',
    );
    expect(cliSource).toContain(
      'if (!relayDir && isolatedSendRequired && !isolatedCapabilityCtx)',
    );
    expect(cliSource).toContain(
      'const liveOrigin = resolveSessionContext(resolveDataDir(), sessionId);',
    );
    expect(vcSource).toContain(
      'const liveOrigin = resolveSessionContext(config.session.dataDir, receiverSessionId);',
    );
  });
});
