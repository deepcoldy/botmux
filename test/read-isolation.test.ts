import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from './helpers/bun-leg-selectors.js';
import {
  evaluateReadIsolationGate,
  evaluateCredentialOnlyIsolationGate,
  credentialIsolationRequired,
  deviceCredentialIsolationMarkerPath,
  isCredentialIsolationReservedBasename,
  buildCredentialIsolationRules,
  isolatedPaneOriginChannel,
  isolatedPaneReattachSafe,
  evaluatePersistentPaneMigration,
  executePersistentPaneMigration,
  persistentTeardownKillKind,
  policyOffTombstoneContent,
  policyOffTombstoneValid,
  provenancePendingContent,
  provenancePendingNonce,
  isolationPaneMarkerContent,
  ISOLATION_PANE_MARKER_VERSION,
  isolationPanePolicyDigest,
  botHomePath,
  buildCliExecutableReadCarveOuts,
  sendCredFilePath,
  assertSafeAppId,
  normalizeIsolationPath,
  shouldRedirectCliData,
} from '../src/adapters/cli/read-isolation.js';

describe('CLI data redirect gate', () => {
  const base = { supportsReadIsolation: true, sessionDataDir: '/srv/botmux/data' };

  it('redirects sandboxed supported CLIs into BOT_HOME', () => {
    expect(shouldRedirectCliData({ ...base, sandboxRequested: true })).toBe(true);
  });

  it('keeps sandbox=false on the CLI native global home/login state', () => {
    expect(shouldRedirectCliData({ ...base, sandboxRequested: false })).toBe(false);
  });

  it('redirects an explicitly isolated Codex home even when sandbox=false', () => {
    expect(shouldRedirectCliData({ ...base, sandboxRequested: false, forcePerBotHome: true })).toBe(true);
  });

  it('does not promise per-bot auth through unsupported adapters or wrappers', () => {
    expect(shouldRedirectCliData({ ...base, sandboxRequested: true, supportsReadIsolation: false })).toBe(false);
    expect(shouldRedirectCliData({ ...base, sandboxRequested: true, wrapperCli: 'gateway codex' })).toBe(false);
    expect(shouldRedirectCliData({ ...base, sandboxRequested: false, forcePerBotHome: true, wrapperCli: 'gateway codex' })).toBe(false);
  });
});

const G1 = '11'.repeat(32);
const POLICY1 = isolationPanePolicyDigest({
  readIsolation: true,
  writeSandbox: false,
  readDenyExtraPaths: ['/private/a'],
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


describe('per-bot private storage primitives', () => {
  it('botHomePath is per-appId under BOTMUX_HOME/bots', () => {
    expect(botHomePath('/Users/bot/.botmux', 'cli_self')).toBe('/Users/bot/.botmux/bots/cli_self');
    expect(botHomePath('/Users/bot/.botmux/', 'cli_self')).toBe('/Users/bot/.botmux/bots/cli_self');
  });

  it('send-cred lives inside BOT_HOME and follows a customized SESSION_DATA_DIR', () => {
    expect(sendCredFilePath('/Users/bot/.botmux/data', 'cli_self'))
      .toBe('/Users/bot/.botmux/bots/cli_self/send-cred.json');
    expect(sendCredFilePath('/srv/custom-data', 'cli_self'))
      .toBe('/srv/bots/cli_self/send-cred.json');
  });

  it('assertSafeAppId rejects path-traversal / separators, accepts real Feishu ids', () => {
    expect(assertSafeAppId('cli_a1b2c3')).toBe('cli_a1b2c3');
    for (const bad of ['a/b', '..', '.', '...', 'x/../y', '']) {
      expect(() => assertSafeAppId(bad)).toThrow();
    }
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

describe('mandatory device credential isolation', () => {
  it('activates once either the enrollment marker or a device credential exists', () => {
    expect(credentialIsolationRequired({ markerExists: false, deviceCredentialExists: false })).toBe(false);
    expect(credentialIsolationRequired({ markerExists: true, deviceCredentialExists: false })).toBe(true);
    expect(credentialIsolationRequired({ markerExists: false, deviceCredentialExists: true })).toBe(true);
    expect(deviceCredentialIsolationMarkerPath('/home/agent/'))
      .toBe('/home/agent/.botmux/.device-credential-isolation');
  });

  it('fails closed when required confinement is unavailable', () => {
    expect(evaluateCredentialOnlyIsolationGate({
      markerExists: true,
      deviceCredentialExists: false,
      remoteBackend: false,
      platform: 'linux',
      mechanismAvailable: false,
      fullIsolationCoversCredentials: false,
    })).toMatchObject({ required: true, mode: 'blocked' });
    expect(evaluateCredentialOnlyIsolationGate({
      markerExists: true,
      deviceCredentialExists: false,
      remoteBackend: false,
      platform: 'linux',
      mechanismAvailable: true,
      fullIsolationCoversCredentials: true,
    })).toEqual({ required: true, mode: 'covered' });
  });

  it('denies dedicated, legacy, marker, backup, and atomic sidecar paths', () => {
    const rules = buildCredentialIsolationRules({
      homeDir: '/home/agent',
      botmuxHome: '/srv/botmux-runtime',
    });
    expect(rules.roots).toEqual(['/home/agent/.botmux', '/srv/botmux-runtime']);
    expect(rules.denyPaths).toContain('/home/agent/.botmux/device-auth');
    expect(rules.denyPaths).toContain('/srv/botmux-runtime/platform.json');
    expect(rules.denyPaths).toContain('/home/agent/.botmux/.device-credential-isolation');
    for (const name of [
      'device-auth',
      'device.json',
      'device.json.tmp',
      'platform.json.bak',
      '.device-credential-isolation',
      '.device-credential-isolation.tmp',
    ]) {
      expect(isCredentialIsolationReservedBasename(name), name).toBe(true);
    }
  });

  it('credential-only isolation leaves the session skill manifest, skill snapshot and store readable (`botmux skill show` works)', () => {
    // Credential-only (sandbox off + device-credential marker) is allow-default:
    // only the device authority namespace + reserved/dashboard top-level files
    // are hidden. Guard against a future widening that would silently mask the
    // skill reader's inputs. (No cross-session read isolation is promised in
    // this mode — that is the full fs-policy sandbox's job.)
    for (const botmuxHome of ['/home/agent/.botmux', '/srv/botmux-runtime']) {
      const rules = buildCredentialIsolationRules({ homeDir: '/home/agent', botmuxHome });
      for (const path of [
        `${botmuxHome}/data/skill-manifests/s.json`,
        `${botmuxHome}/data/runtime-skills/s/snapshot/deploy/SKILL.md`,
        '/home/agent/.botmux/skills/store/deploy/SKILL.md',
      ]) {
        expect(rules.denyPaths.some(deny => path === deny || path.startsWith(`${deny}/`)), path).toBe(false);
        expect(rules.denyRegexes.some(rx => new RegExp(rx).test(path)), path).toBe(false);
      }
    }
    for (const name of ['data', 'skills']) {
      expect(isCredentialIsolationReservedBasename(name), name).toBe(false);
    }
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
    expect(isolatedPaneReattachSafe(JSON.stringify({
      version: ISOLATION_PANE_MARKER_VERSION, bootId: 'missing-capabilities',
    }))).toBe(false);
    expect(isolatedPaneReattachSafe(JSON.stringify({
      version: ISOLATION_PANE_MARKER_VERSION, bootId: 'unknown-capability', capabilities: ['credential', 'network'],
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
      'credential-only-v7', ['credential'],
    ), {
      requiredCapabilities: ['credential'],
      exactCapabilities: true,
      requireOriginChannel: false,
    })).toBe(true);
    expect(isolatedPaneReattachSafe(isolationPaneMarkerContent(
      'old-broader-policy-v7', ['credential', 'read', 'write'],
    ), {
      requiredCapabilities: ['credential'],
      exactCapabilities: true,
      requireOriginChannel: false,
    })).toBe(false);
    expect(isolatedPaneReattachSafe(isolationPaneMarkerContent(
      'linux-v7', ['credential', 'read'],
    ), {
      requiredCapabilities: ['credential', 'read'],
      requireOriginChannel: true,
    })).toBe(false);
  });

  it('binds Linux warm reattach to the managed-origin digest so install-root or native-hook protocol changes cold-spawn', () => {
    const linuxDigestA = isolationPanePolicyDigest({
      readIsolation: false,
      writeSandbox: false,
      botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data',
      readOnlyExtraPaths: ['/checkout/a'],
      readWriteExtraPaths: ['/native-hook-protocol/v1'],
      cliId: 'traex',
      resolvedBin: '/usr/bin/traex',
    });
    const linuxDigestB = isolationPanePolicyDigest({
      readIsolation: false,
      writeSandbox: false,
      botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data',
      readOnlyExtraPaths: ['/checkout/b'],
      readWriteExtraPaths: ['/native-hook-protocol/v1'],
      cliId: 'traex',
      resolvedBin: '/usr/bin/traex',
    });
    const linuxDigestProtocolBump = isolationPanePolicyDigest({
      readIsolation: false,
      writeSandbox: false,
      botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data',
      readOnlyExtraPaths: ['/checkout/a'],
      readWriteExtraPaths: ['/native-hook-protocol/v2'],
      cliId: 'traex',
      resolvedBin: '/usr/bin/traex',
    });
    const marker = isolationPaneMarkerContent('linux-fresh', ['credential', 'read', 'write'], {
      originChannelId: G1,
      readIsolation: false,
      writeSandbox: false,
      policyDigest: linuxDigestA,
    });
    expect(isolatedPaneReattachSafe(marker, {
      requiredCapabilities: ['credential', 'read', 'write'],
      exactCapabilities: true,
      readIsolation: false,
      writeSandbox: false,
      requireOriginChannel: true,
      policyDigest: linuxDigestA,
    })).toBe(true);
    expect(isolatedPaneReattachSafe(marker, {
      requiredCapabilities: ['credential', 'read', 'write'],
      exactCapabilities: true,
      readIsolation: false,
      writeSandbox: false,
      requireOriginChannel: true,
      policyDigest: linuxDigestB,
    })).toBe(false);
    expect(isolatedPaneReattachSafe(marker, {
      requiredCapabilities: ['credential', 'read', 'write'],
      exactCapabilities: true,
      readIsolation: false,
      writeSandbox: false,
      requireOriginChannel: true,
      policyDigest: linuxDigestProtocolBump,
    })).toBe(false);
  });
});

// ─── cold-start migration: START-TIME env contract (bots.json EPERM fix) ──────

describe('evaluatePersistentPaneMigration — policy-on/off pane provenance state machine', () => {
  // Pure decision behind the worker's stale-pane guard (worker.ts). Covers the
  // 2026-08 no-transport 放宽 upgrade path AND the crash/teardown-failure branches.
  // `isolationMarkerReattachSafe` is the caller's precomputed
  // isolatedPaneReattachSafe() result (only meaningful under policy ON);
  // `policyOffTombstoneValid` is the caller's secure-read + schema check.
  const CAPS_ON = ['credential', 'read', 'write'] as const;
  const CRED_ONLY = ['credential'] as const;
  const CAPS_OFF = [] as const;
  const base = {
    isolationCapableBackend: true,
    noTransport: true,
    isolationMarkerPresent: false,
    policyOffTombstonePresent: false,
    policyOffTombstoneValid: false,
    paneProbe: 'exists' as const,
    pendingProvenancePresent: false,
    isolationMarkerReattachSafe: false,
  };

  // ── policy ON — runs on EVERY persistent backend (issue #2: credential-only on
  //    zellij/herdr/zmx must still be capability-checked, NOT skipped as non-tmux) ──
  it('policy ON + live pane stamped under current policy → reattach', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON,
      isolationMarkerPresent: true, isolationMarkerReattachSafe: true,
    })).toEqual({ action: 'reattach' });
  });

  it('policy ON + live pane whose marker does NOT match → kill + cold-spawn (clear after kill)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON,
      isolationMarkerPresent: true, isolationMarkerReattachSafe: false,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('policy ON credential-only on a NON-tmux backend + mismatched marker → kill (issue #2: not skipped)', () => {
    // enrolled host, credential-only wrapper on zellij/herdr/zmx (isolationCapableBackend
    // false because file sandbox is tmux-only). The capability check must STILL run.
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CRED_ONLY, isolationCapableBackend: false,
      isolationMarkerPresent: true, isolationMarkerReattachSafe: false,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('policy ON credential-only on a NON-tmux backend + matching marker → reattach', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CRED_ONLY, isolationCapableBackend: false,
      isolationMarkerPresent: true, isolationMarkerReattachSafe: true,
    })).toEqual({ action: 'reattach' });
  });

  it('policy ON + no live pane + stale tombstone lingering → clear stale (else a later policy-off misreads it)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON, paneProbe: 'missing',
      policyOffTombstonePresent: true,
    })).toEqual({ action: 'clear-stale-then-cold-spawn' });
  });

  it('policy ON + no live pane + no provenance → skip (fresh spawn stamps)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON, paneProbe: 'missing',
    })).toEqual({ action: 'skip' });
  });

  // ── policy OFF, no-transport tmux migration arm ──
  it('policy OFF + live pane with VALID tombstone, no isolation marker → reattach', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF,
      policyOffTombstonePresent: true, policyOffTombstoneValid: true, isolationMarkerPresent: false,
    })).toEqual({ action: 'reattach' });
  });

  it('policy OFF + live pane with tombstone PRESENT but INVALID → kill (lstat-present is not proof; issue #3)', () => {
    // Empty / dir / symlink / garbage tombstone lstat-exists but fails secure-read;
    // must NOT authorize a warm reattach of a possibly-confined pane.
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF,
      policyOffTombstonePresent: true, policyOffTombstoneValid: false,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('policy OFF + live pane with legacy ISOLATION marker → kill + cold-spawn (the core regression)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF,
      isolationMarkerPresent: true,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('policy OFF + live pane with NEITHER file → kill (absence never proves "never isolated"; issue #3)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF,
      isolationMarkerPresent: false, policyOffTombstonePresent: false,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('policy OFF + live pane with valid tombstone AND isolation marker (marker dominates) → kill', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF,
      isolationMarkerPresent: true, policyOffTombstonePresent: true, policyOffTombstoneValid: true,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('policy OFF + pane MISSING but stale marker lingers → clear stale then cold-spawn (no next-restart false kill)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF,
      paneProbe: 'missing', isolationMarkerPresent: true,
    })).toEqual({ action: 'clear-stale-then-cold-spawn' });
  });

  it('policy OFF + pane MISSING but stale tombstone lingers → clear stale then cold-spawn', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF,
      paneProbe: 'missing', policyOffTombstonePresent: true,
    })).toEqual({ action: 'clear-stale-then-cold-spawn' });
  });

  it('policy OFF + pane MISSING + no files → skip (nothing stale to clear)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, paneProbe: 'missing',
    })).toEqual({ action: 'skip' });
  });

  it('policy OFF + TRANSPORT-ENABLED chat + LIVE pane → skip even with a marker (never force-isolated, no false kill)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, noTransport: false,
      isolationMarkerPresent: true,
    })).toEqual({ action: 'skip' });
  });

  it('policy OFF + non-migration-scope + DEAD pane with stale marker → still clears (file must not linger)', () => {
    // Even outside the migration scope, a dead pane's stale provenance is cleared
    // so it cannot mislead a future decision.
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, noTransport: false,
      paneProbe: 'missing', isolationMarkerPresent: true,
    })).toEqual({ action: 'clear-stale-then-cold-spawn' });
  });

  // ── TRI-STATE liveness: `unknown` must NEVER be collapsed into "dead". The
  //    original bug modeled paneLive:boolean, so a flaky `unknown` probe took the
  //    dead-pane path and CLEARED the provenance of a possibly-live confined pane
  //    (or cold-spawned around it). `unknown` now fail-closes wherever anything is
  //    at stake, and only `skip`s a wholly unconcerned session. ──
  it('policy ON + UNKNOWN probe → refuse (never clear a still-confined pane on a flaky probe)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON, paneProbe: 'unknown',
      isolationMarkerPresent: true,
    })).toEqual({ action: 'refuse-inconclusive-probe' });
  });

  it('policy ON + UNKNOWN probe + no provenance → still refuse (policy-on is always concerned)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON, paneProbe: 'unknown',
    })).toEqual({ action: 'refuse-inconclusive-probe' });
  });

  it('policy OFF + no-transport tmux + UNKNOWN probe + legacy marker → refuse (the core tri-state fix)', () => {
    // The initial-`unknown` scenario: a flaky tmux probe on an upgraded
    // no-transport session with a leftover isolation marker. Must NOT clear-stale
    // (the pane may still be alive AND confined).
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, paneProbe: 'unknown',
      isolationMarkerPresent: true,
    })).toEqual({ action: 'refuse-inconclusive-probe' });
  });

  it('policy OFF + no-transport tmux + UNKNOWN probe + NO provenance → refuse (in migration scope = concerned)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, paneProbe: 'unknown',
    })).toEqual({ action: 'refuse-inconclusive-probe' });
  });

  it('policy OFF + UNKNOWN probe + stale provenance out of migration scope → refuse (provenance = concerned)', () => {
    // Transport-enabled chat / non-tmux backend, but a stale marker is on disk: an
    // `unknown` probe must not clear it (the file might belong to a live pane).
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, noTransport: false,
      isolationCapableBackend: false, paneProbe: 'unknown', isolationMarkerPresent: true,
    })).toEqual({ action: 'refuse-inconclusive-probe' });
  });

  it('policy OFF + UNKNOWN probe + NOTHING at stake (out of scope, no provenance) → skip (no false start-failure)', () => {
    // Ordinary transport chat, non-file-sandbox backend, no provenance: probe
    // flakiness must NOT block startup — there is nothing to clear or protect.
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, noTransport: false,
      isolationCapableBackend: false, paneProbe: 'unknown',
    })).toEqual({ action: 'skip' });
  });

  // ── PENDING dominates everything (generational-race fix). A pending provenance
  //    file = the system explicitly knows a generation's fresh-attribution never
  //    completed. It is judged FIRST, on ALL backends and BOTH policy directions,
  //    independent of the tmux migration scope. This is what stops a leftover
  //    pending on an enrolled non-tmux (zellij) pane from warm-reattaching an
  //    undetermined generation once its credential policy flips OFF. ──
  it('PENDING + exists → kill (dominates, even policy-OFF out of tmux migration scope)', () => {
    // Enrolled zellij pane, credential policy now OFF, out of tmux scope — the old
    // `!inMigrationScope → skip` path would warm-reattach. Pending overrides it.
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, noTransport: false,
      isolationCapableBackend: false, paneProbe: 'exists',
      isolationMarkerPresent: true, pendingProvenancePresent: true,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('PENDING + exists + policy-ON → kill (pending dominates the policy-ON reattach path too)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON, paneProbe: 'exists',
      isolationMarkerPresent: true, pendingProvenancePresent: true,
      // even if a stale committed check would have said "safe", pending wins:
      isolationMarkerReattachSafe: true,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('PENDING + unknown → refuse (never erase evidence of a possibly-live pending pane)', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, paneProbe: 'unknown',
      policyOffTombstonePresent: true, pendingProvenancePresent: true,
    })).toEqual({ action: 'refuse-inconclusive-probe' });
  });

  it('PENDING + missing → clear-stale (verified) then cold-spawn', () => {
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, paneProbe: 'missing',
      isolationMarkerPresent: true, pendingProvenancePresent: true,
    })).toEqual({ action: 'clear-stale-then-cold-spawn' });
  });

  it('regression #6: zellij policy-ON fresh left PENDING, restart still policy-ON → kill/cold (never reattach)', () => {
    // Option B: isolation-capable zellij never commits, so its proof stays pending.
    // On restart the still-live pane + pending → kill, regardless of policy-ON.
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_ON, isolationCapableBackend: false,
      paneProbe: 'exists', isolationMarkerPresent: true, pendingProvenancePresent: true,
      isolationMarkerReattachSafe: false,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });

  it('regression #7: same PENDING pane, restart now policy-OFF + OUT of tmux migration scope → still kill (never the old skip)', () => {
    // This is the exact hole the pending-dominance fix closes: policy-OFF + live +
    // !inMigrationScope used to `skip` (warm-reattach). Pending forces kill.
    expect(evaluatePersistentPaneMigration({
      ...base, appliedIsolationCapabilities: CAPS_OFF, noTransport: false,
      isolationCapableBackend: false, paneProbe: 'exists',
      isolationMarkerPresent: true, pendingProvenancePresent: true,
    })).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
  });
});

describe('persistentTeardownKillKind — exact-target teardown policy (herdr shared-host safety)', () => {
  // The generational-race teardown must NOT name-only kill: an isolated/MCP herdr
  // agent lives on the SHARED host session `botmux`, so killing by session name
  // would tear down every bot's agent. This pure policy is what the worker's inline
  // teardown dispatches on.
  it('herdr WITH a recorded target → target-scoped kill (never the shared host name)', () => {
    expect(persistentTeardownKillKind({ backendType: 'herdr', hasBackendTarget: true })).toBe('target');
  });
  it('zmx → identity-verified frozen-PID path regardless of target', () => {
    expect(persistentTeardownKillKind({ backendType: 'zmx', hasBackendTarget: true })).toBe('zmx');
    expect(persistentTeardownKillKind({ backendType: 'zmx', hasBackendTarget: false })).toBe('zmx');
  });
  it('tmux/zellij WITH a target → target-scoped; WITHOUT a target → name-only (legacy own-session)', () => {
    expect(persistentTeardownKillKind({ backendType: 'tmux', hasBackendTarget: true })).toBe('target');
    expect(persistentTeardownKillKind({ backendType: 'tmux', hasBackendTarget: false })).toBe('name');
    expect(persistentTeardownKillKind({ backendType: 'zellij', hasBackendTarget: false })).toBe('name');
  });
  it('a herdr WITHOUT a recorded target falls back to name — but the worker always captures the target for a live agent', () => {
    // Documents the only path to 'name' for herdr: no target recorded at all. The
    // worker captures selectedBackend.persistentBackendTarget, which for a herdr
    // agent is always populated, so the dangerous host-name kill is unreachable there.
    expect(persistentTeardownKillKind({ backendType: 'herdr', hasBackendTarget: false })).toBe('name');
  });
});

describe('executePersistentPaneMigration — ordered, fail-closed IO seam', () => {
  // Behavioral (not source-lock): inject mock effects, observe call ORDER and the
  // "not called" guarantees on each failure path.
  const makeEffects = () => {
    const calls: string[] = [];
    const eff = {
      killStalePane: () => { calls.push('kill'); },
      confirmPaneGone: () => { calls.push('confirm'); },
      clearProvenanceVerified: () => { calls.push('clear'); },
      reselectBackend: () => { calls.push('reselect'); },
      refuseInconclusiveProbe: (): never => { calls.push('refuse'); throw new Error('inconclusive probe'); },
    };
    return { calls, eff };
  };

  it('reattach / skip → no side effects at all', () => {
    for (const action of ['reattach', 'skip'] as const) {
      const { calls, eff } = makeEffects();
      executePersistentPaneMigration({ action }, eff);
      expect(calls).toEqual([]);
    }
  });

  it('kill-then-cold-spawn (clearAfterKill) → kill → confirm → clear → reselect, in order', () => {
    const { calls, eff } = makeEffects();
    executePersistentPaneMigration({ action: 'kill-then-cold-spawn', clearAfterKill: true }, eff);
    expect(calls).toEqual(['kill', 'confirm', 'clear', 'reselect']);
  });

  it('kill FAILS → stops before confirm/clear/reselect (evidence preserved for retry)', () => {
    const { calls, eff } = makeEffects();
    eff.killStalePane = () => { calls.push('kill'); throw new Error('kill failed'); };
    expect(() => executePersistentPaneMigration(
      { action: 'kill-then-cold-spawn', clearAfterKill: true }, eff,
    )).toThrow('kill failed');
    expect(calls).toEqual(['kill']); // NOT clear, NOT reselect
  });

  it('post-kill confirm REJECTS → stops before clear/reselect (marker preserved)', () => {
    const { calls, eff } = makeEffects();
    eff.confirmPaneGone = () => { calls.push('confirm'); throw new Error('still alive'); };
    expect(() => executePersistentPaneMigration(
      { action: 'kill-then-cold-spawn', clearAfterKill: true }, eff,
    )).toThrow('still alive');
    expect(calls).toEqual(['kill', 'confirm']); // NOT clear, NOT reselect
  });

  it('provenance clear FAILS → stops before reselect (never publish a new generation)', () => {
    const { calls, eff } = makeEffects();
    eff.clearProvenanceVerified = () => { calls.push('clear'); throw new Error('unlink failed'); };
    expect(() => executePersistentPaneMigration(
      { action: 'kill-then-cold-spawn', clearAfterKill: true }, eff,
    )).toThrow('unlink failed');
    expect(calls).toEqual(['kill', 'confirm', 'clear']); // NOT reselect
  });

  it('clear-stale-then-cold-spawn → clear only (no kill of a dead pane, no reselect)', () => {
    const { calls, eff } = makeEffects();
    executePersistentPaneMigration({ action: 'clear-stale-then-cold-spawn' }, eff);
    expect(calls).toEqual(['clear']);
  });

  it('clear-stale clear FAILS → throws, aborts the spawn', () => {
    const { calls, eff } = makeEffects();
    eff.clearProvenanceVerified = () => { calls.push('clear'); throw new Error('rmdir'); };
    expect(() => executePersistentPaneMigration({ action: 'clear-stale-then-cold-spawn' }, eff))
      .toThrow('rmdir');
    expect(calls).toEqual(['clear']);
  });

  it('refuse-inconclusive-probe → refuse ONLY (never kill/confirm/clear/reselect), throws', () => {
    const { calls, eff } = makeEffects();
    expect(() => executePersistentPaneMigration({ action: 'refuse-inconclusive-probe' }, eff))
      .toThrow('inconclusive probe');
    expect(calls).toEqual(['refuse']); // NOT kill, NOT clear, NOT reselect
  });
});

describe('policyOffTombstoneValid — secure-read schema/version check', () => {
  it('accepts a well-formed current-version tombstone (bootId diagnostic, not compared)', () => {
    expect(policyOffTombstoneValid(policyOffTombstoneContent('boot-xyz'))).toBe(true);
    // A DIFFERENT bootId is still valid — legit panes reattach across daemon restarts.
    expect(policyOffTombstoneValid(policyOffTombstoneContent('some-other-boot'))).toBe(true);
  });

  it('rejects empty / garbage / wrong-shape bodies (lstat-present must not authorize)', () => {
    expect(policyOffTombstoneValid(null)).toBe(false);
    expect(policyOffTombstoneValid(undefined)).toBe(false);
    expect(policyOffTombstoneValid('')).toBe(false);
    expect(policyOffTombstoneValid('   ')).toBe(false);
    expect(policyOffTombstoneValid('not json')).toBe(false);
    expect(policyOffTombstoneValid(JSON.stringify({ policyOff: true, bootId: 'x' }))).toBe(false); // no version
    expect(policyOffTombstoneValid(JSON.stringify({ version: 1, policyOff: true, bootId: 'x' }))).toBe(false); // stale version
    expect(policyOffTombstoneValid(JSON.stringify({ version: ISOLATION_PANE_MARKER_VERSION, policyOff: false, bootId: 'x' }))).toBe(false);
    expect(policyOffTombstoneValid(JSON.stringify({ version: ISOLATION_PANE_MARKER_VERSION, policyOff: true }))).toBe(false); // no bootId
    expect(policyOffTombstoneValid(JSON.stringify({ version: ISOLATION_PANE_MARKER_VERSION, policyOff: true, bootId: '' }))).toBe(false);
    // An isolation marker must NOT validate as a tombstone.
    expect(policyOffTombstoneValid(isolationPaneMarkerContent('boot', ['credential']))).toBe(false);
  });

  it('requires state:committed — rejects PENDING and any no-state/other-state record (v11 strict)', () => {
    // PENDING generation proof must never authorize (generational-race fix).
    expect(policyOffTombstoneValid(provenancePendingContent('nonce-abc'))).toBe(false);
    expect(policyOffTombstoneValid(JSON.stringify({
      version: ISOLATION_PANE_MARKER_VERSION, policyOff: true, bootId: 'x', state: 'pending',
    }))).toBe(false);
    // committed authorizes.
    expect(policyOffTombstoneValid(policyOffTombstoneContent('boot-xyz'))).toBe(true);
    // A NO-state record (the pre-v11 pre-spawn-write shape, possibly washed onto a
    // late-winner pane) is now REFUSED — state:'committed' is required, forcing a
    // cold-spawn once instead of trusting an unearned proof.
    expect(policyOffTombstoneValid(JSON.stringify({
      version: ISOLATION_PANE_MARKER_VERSION, policyOff: true, bootId: 'legacy',
    }))).toBe(false);
    // Any other explicit state is refused.
    expect(policyOffTombstoneValid(JSON.stringify({
      version: ISOLATION_PANE_MARKER_VERSION, policyOff: true, bootId: 'x', state: 'weird',
    }))).toBe(false);
  });
});

describe('provenance PENDING encoding (generational-race two-phase proof)', () => {
  it('both validators reject a pending body; presence-nonce round-trips', () => {
    const pending = provenancePendingContent('nonce-123');
    // Neither validator authorizes a pending record.
    expect(policyOffTombstoneValid(pending)).toBe(false);
    expect(isolatedPaneReattachSafe(pending, { requiredCapabilities: ['credential'] })).toBe(false);
    expect(isolatedPaneReattachSafe(pending)).toBe(false);
    // The nonce round-trips for the commit-time compare-before-replace.
    expect(provenancePendingNonce(pending)).toBe('nonce-123');
  });

  it('provenancePendingNonce returns null for committed / garbage / absent bodies', () => {
    expect(provenancePendingNonce(policyOffTombstoneContent('boot'))).toBeNull();
    expect(provenancePendingNonce(isolationPaneMarkerContent('boot', ['credential']))).toBeNull();
    expect(provenancePendingNonce(null)).toBeNull();
    expect(provenancePendingNonce('not json')).toBeNull();
    expect(provenancePendingNonce(JSON.stringify({ state: 'pending' }))).toBeNull(); // no nonce
    expect(provenancePendingNonce(JSON.stringify({ state: 'pending', nonce: '' }))).toBeNull();
  });

  it('a committed isolation marker carries state:committed and still validates', () => {
    const committed = isolationPaneMarkerContent('boot-abc', ['credential', 'read', 'write']);
    expect(JSON.parse(committed).state).toBe('committed');
    expect(isolatedPaneReattachSafe(committed, {
      requiredCapabilities: ['credential', 'read', 'write'], exactCapabilities: true,
    })).toBe(true);
    // An explicit state:'pending' spliced onto an otherwise-valid marker is refused.
    const tampered = JSON.stringify({ ...JSON.parse(committed), state: 'pending' });
    expect(isolatedPaneReattachSafe(tampered, {
      requiredCapabilities: ['credential', 'read', 'write'], exactCapabilities: true,
    })).toBe(false);
  });
});

/**
 * Regression guard (2026-08-03). The bots.json-EPERM fix injects a NEW start-time
 * env contract (BOTMUX_READ_ISOLATION / BOTMUX_API_ONLY) that only reaches a CLI
 * at spawn. A warm reattach preserves the live process untouched, so a pane that
 * was spawned by v3.8.0 — v7 marker, full capabilities, but a process carrying
 * NEITHER env key — would be judged reattach-safe and keep crashing on the denied
 * bots.json read after a plain `daemon:restart`. The marker version is the ONLY
 * lever that turns such a pane from "warm reattach (keep old process)" into
 * "kill + cold-spawn (inject the markers)". So bumping it past 7 is load-bearing,
 * not cosmetic. If someone reverts the bump, this test goes red.
 */
describe('isolatedPaneReattachSafe — start-time contract bump forces cold respawn', () => {
  // Exactly the shape codex reproduced: a v3.8.0 sandbox pane's marker.
  const legacyV7Full = JSON.stringify({
    version: 7,
    bootId: 'old-v3.8-pane',
    capabilities: ['credential', 'read', 'write'],
  });

  it('rejects a v7 pane even with FULL valid capabilities (its process lacks the new env markers)', () => {
    expect(isolatedPaneReattachSafe(legacyV7Full, ['read', 'write'])).toBe(false);
    expect(isolatedPaneReattachSafe(legacyV7Full, ['credential', 'read', 'write'])).toBe(false);
  });

  it('accepts a pane stamped with the current version (cold-spawned under the new contract)', () => {
    const current = isolationPaneMarkerContent('fresh-boot', ['credential', 'read', 'write']);
    expect(isolatedPaneReattachSafe(current, ['read', 'write'])).toBe(true);
  });

  it('has moved the version past 7 — the release that shipped without the env contract', () => {
    // Pins the intent: v7 was the last version whose isolated processes could
    // lack BOTMUX_READ_ISOLATION. Anything ≥ 8 is fine; reverting to ≤ 7 would
    // silently warm-reattach those broken panes.
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(7);
  });

  it('rejects a pre-v11 NO-state marker (the pre-spawn-write shape) → forces cold-spawn once', () => {
    // The generational-race fix (pending→commit) added state:'committed'. A v10
    // marker was written UNCONDITIONALLY before spawn (the vulnerable path) with NO
    // state field, so a late-winner pane may wear a "full-capability" v10 marker it
    // never earned. Both the version bump AND the strict state check must reject it
    // so it cold-spawns once under the new contract — closing the INSTALLED-BASE
    // risk, not just new spawns.
    const legacyV10NoState = JSON.stringify({
      version: 10,
      bootId: 'washed-late-winner',
      capabilities: ['credential', 'read', 'write'],
    });
    expect(isolatedPaneReattachSafe(legacyV10NoState, ['credential', 'read', 'write'])).toBe(false);
    // Even a hypothetical CURRENT-version marker with no state is refused (strict).
    const currentVersionNoState = JSON.stringify({
      version: ISOLATION_PANE_MARKER_VERSION,
      bootId: 'no-state',
      capabilities: ['credential', 'read', 'write'],
    });
    expect(isolatedPaneReattachSafe(currentVersionNoState, ['credential', 'read', 'write'])).toBe(false);
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThanOrEqual(12);
  });

  it('cold-spawns panes predating the canonical session-data root contract', () => {
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(13);
    expect(isolatedPaneReattachSafe(JSON.stringify({
      version: 13,
      bootId: 'lexical-data-root',
      state: 'committed',
      capabilities: ['credential', 'read', 'write'],
    }), ['credential', 'read', 'write'])).toBe(false);
  });

  it('cold-spawns v14 panes that lack the Linux kernel isolation stamp', () => {
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(14);
    expect(isolatedPaneReattachSafe(JSON.stringify({
      version: 14,
      bootId: 'before-kernel-marker',
      state: 'committed',
      capabilities: ['credential', 'read', 'write'],
    }), ['credential', 'read', 'write'])).toBe(false);
  });

  it('cold-spawns v16 credential-only panes that lack the relay scope marker', () => {
    // v17 adds BOTMUX_SEND_RELAY_SCOPE=send to the credential-only wrapper env;
    // a v16 pane never received it, so its legacy dispatch forms stay refused.
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(16);
    const current = JSON.parse(isolationPaneMarkerContent('boot', ['credential'])) as Record<string, unknown>;
    expect(isolatedPaneReattachSafe(JSON.stringify(current), ['credential'])).toBe(true);
    expect(isolatedPaneReattachSafe(JSON.stringify({ ...current, version: 16 }), ['credential'])).toBe(false);
  });

  it('restore path: a v17 sandboxed pane (no skill manifest / snapshot binds) is killed + cold-spawned; a current one warm-reattaches', () => {
    // v18 adds spawn-time read-only binds for the session's skill manifest and
    // its skill snapshot dir. Warm reattach keeps the old process + mounts
    // and skips skill generation, so a v17 pane would never get them. Compose
    // the worker's own gate: isolatedPaneReattachSafe (as spawnCli calls it for
    // the policy-ON arm) → evaluatePersistentPaneMigration.
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(17);
    const digest = 'ab'.repeat(32);
    for (const { label, readIsolation, writeSandbox } of [
      { label: 'linux oncall (bwrap)', readIsolation: false, writeSandbox: false },
      { label: 'darwin oncall (Seatbelt)', readIsolation: true, writeSandbox: true },
    ]) {
      const caps = ['credential', 'read', 'write'] as const;
      const expected = {
        requiredCapabilities: caps, exactCapabilities: true,
        readIsolation, writeSandbox, requireOriginChannel: true, policyDigest: digest,
      };
      const current = JSON.parse(isolationPaneMarkerContent('boot', caps, {
        originChannelId: G1, readIsolation, writeSandbox, policyDigest: digest,
      })) as Record<string, unknown>;
      const decide = (marker: Record<string, unknown>) => evaluatePersistentPaneMigration({
        appliedIsolationCapabilities: [...caps],
        isolationCapableBackend: true,
        noTransport: false,
        isolationMarkerPresent: true,
        policyOffTombstonePresent: false,
        policyOffTombstoneValid: false,
        paneProbe: 'exists',
        pendingProvenancePresent: false,
        isolationMarkerReattachSafe: isolatedPaneReattachSafe(JSON.stringify(marker), expected),
      });
      expect(decide(current), label).toEqual({ action: 'reattach' });
      expect(decide({ ...current, version: 17 }), label).toEqual({ action: 'kill-then-cold-spawn', clearAfterKill: true });
    }
  });

  it('has moved the version past 12 — the release before the sandboxed-Codex CA env contract', () => {
    // A pane spawned before this change keeps its ORIGINAL process environment, so
    // it would never see the host CA bundle (SSL_CERT_FILE) and its Codex would keep
    // failing TLS on UnknownIssuer — before any output, so the symptom is a pane that
    // simply never answers. The marker version is the only lever that turns such a
    // pane into kill + cold-spawn, so bumping past 12 is load-bearing.
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(12);
  });
});

// ─── #714: new spawn-time sandbox mount (traex/coco migration markers) ────────

/**
 * Regression guard. #714 adds a new spawn-time bwrap mount (traex/coco's
 * read-only migration done-markers via sandboxReadonlyPaths). A warm reattach
 * keeps the live process + its ORIGINAL mount set, so a pane spawned before this
 * change would reattach without the marker mount and keep wedging on the TRAE
 * migration prompt. The marker version is the only lever that turns such a pane
 * into kill + cold-spawn, so bumping past the pre-#714 versions is load-bearing.
 *
 * Ordering note: #709 took 8 (env contract); #714 takes 9. Both prior versions
 * must be rejected. If the merge order flips, rebase so this stays monotonic.
 */
describe('isolatedPaneReattachSafe — #714 mount contract forces cold respawn of pre-9 panes', () => {
  const full = ['credential', 'read', 'write'] as const;
  for (const v of [7, 8]) {
    it(`rejects a v${v} pane even with full capabilities (its bwrap lacks the marker mount)`, () => {
      const marker = JSON.stringify({ version: v, bootId: `pre-714-v${v}`, capabilities: [...full] });
      expect(isolatedPaneReattachSafe(marker, ['read', 'write'])).toBe(false);
    });
  }

  it('accepts a pane stamped with the current version', () => {
    expect(isolatedPaneReattachSafe(isolationPaneMarkerContent('fresh', [...full]), ['read', 'write'])).toBe(true);
  });

  it('has moved the version past 8 (the #709 env-contract version)', () => {
    // Reverting below 9 would silently warm-reattach panes that predate the
    // migration-marker mount. ≥ 9 is required.
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(8);
  });
});

describe('worker read-isolation fences', () => {
  const strippedSource = stripComments(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'));

  // 源码结构护栏(K2)：sandbox=true 下本会话 skill manifest 的放行是 mandatory read-only（按深度压过一切 deny），
  // 在 worker.ts spawnCli 闭包里组装，fs-policy 单测只喂手工 grant、没有 seam。不变量：只放行通过 lstat
  // 确认是普通文件的那一个 `<sid>.json`，且只 canonical 父目录——叶子若是植入的 symlink，canonical/bind
  // 会把这条强制只读放行转到任意目标上（d0ba221b20，#1036）。
  it('grants the own skill manifest read-only only when lstat proves a regular file', () => {
    const decl = strippedSource.match(/const (\w+) = sessionSkillManifestPath\(cfg\.sessionId\b/);
    expect(decl).not.toBeNull();
    const v = decl![1];
    expect(strippedSource).toMatch(new RegExp(
      `if \\(lstatSync\\(${v}\\)\\.isFile\\(\\)\\) \\{\\s*mandatoryReadOnlyPaths\\.push\\([^;]*\\b${v}\\b`,
    ));
    expect(strippedSource.match(new RegExp(`ReadOnlyPaths\\.push\\([^;]*\\b${v}\\b`, 'g'))).toHaveLength(1);
    expect(strippedSource).not.toMatch(new RegExp(`canonical\\(${v}\\)`));
  });

  // 源码结构护栏(K2)：强制凭证隔离的两道闸都在 spawnCli 闭包里、无 seam，删掉会静默开洞——
  // ① adopt 观察的是外部已在跑、无法补套边界的 CLI，必须在任何 adopt 分支之前拒绝；
  // ② credential-only Seatbelt/bwrap 必须是最外层 launch wrapper（在 wrapperCli 包装之后、
  // backend.spawn 之前套上），否则 wrapperCli 及其子孙跑在边界之外（ec167c403a）。
  it('refuses adopt under mandatory credential isolation and keeps credential confinement the outermost wrapper', () => {
    const gateAt = strippedSource.search(/if \(mandatoryCredentialIsolation && cfg\.adoptMode\)\s*\{\s*throw /);
    expect(gateAt).toBeGreaterThan(0);
    const adoptBranches = [...strippedSource.matchAll(/if \(cfg\.adoptMode && [^{]*adopt(?:Source|TmuxTarget|ZellijPaneId|Herdr)/g)];
    expect(adoptBranches.length).toBeGreaterThan(0);
    for (const branch of adoptBranches) expect(gateAt).toBeLessThan(branch.index!);

    const wrapperAt = strippedSource.search(/if \(cfg\.wrapperCli\b/);
    const spawnAt = strippedSource.search(/backend\.spawn\(spawnBin, spawnArgs\b/);
    expect(wrapperAt).toBeGreaterThan(0);
    for (const flavour of ['credentialOnlySeatbelt', 'credentialOnlyBwrap']) {
      const at = strippedSource.search(new RegExp(`if \\(!willReattachPersistent && ${flavour}\\)`));
      expect(at, flavour).toBeGreaterThan(wrapperAt);
      expect(at, flavour).toBeLessThan(spawnAt);
    }
  });
});

describe('CLI protected capability wiring', () => {
  const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

  /**
   * Comment text blanked to spaces, every other character left AT ITS OFFSET. The
   * shared `stripComments` helper deletes comment text instead, so its output no
   * longer addresses the original source — the enclosing-function scan below needs
   * the two to line up. Same two regexes, and the same deliberate over-strip on a
   * `//` inside a string literal: that direction is safe here because over-stripping
   * can only HIDE a mention, which turns these assertions red, never green.
   */
  const blankComments = (source: string): string => source
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

  /** Name of the top-level `function` (column-0 declaration) whose body encloses `at`. */
  const enclosingFunctionName = (source: string, at: number): string | undefined => {
    const head = source.slice(0, at);
    const decls = [...head.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_$]+)\(/gm)];
    return decls.at(-1)?.[1];
  };

  const code = blankComments(cliSource);

  // 源码结构护栏(K2)：`botmux send` 的读隔离分类与拒绝在 cmdSend 长函数里，内核 deny 无法在单测里伪造，
  // 没有 seam。不变量：固定 sentinel 被内核拒读即判定为读隔离发送；读隔离却拿不到绑定的 capability 时
  // 必须 fail-closed 退出，绝不降级成普通直发路径（ccbf2c672c，#602）。
  it('fail-closes a read-isolated send without a bound capability instead of downgrading to the direct path', () => {
    const sentinelAt = code.search(/managedOriginIsolationSentinelAccess\(\w+\)\s*===\s*'sandbox_denied'/);
    const refusalAt = code.search(/isolatedSendRequired && !isolatedCapabilityCtx\)\s*\{[^}]*process\.exit\(/);
    expect(sentinelAt).toBeGreaterThan(0);
    expect(refusalAt).toBeGreaterThan(sentinelAt);
    expect(enclosingFunctionName(code, sentinelAt)).toBe('cmdSend');
    expect(enclosingFunctionName(code, refusalAt)).toBe('cmdSend');
  });

  /**
   * The reporter resolves the live origin itself rather than trusting a
   * caller-supplied identity — EXCEPT for the turn-idle v2 report, whose origin
   * (turnId/attempt/capability) was frozen by the in-CLI plugin AT THE EVENT and is
   * transported verbatim (see cmdTurnIdle). That widening is only acceptable because
   * the exemption is unreachable from every user-facing command:
   * `postSessionScopedSignal` is module-local, only `cmdTurnIdle` (the versioned
   * internal `__turn-idle-v2` subcommand, never named by a user or an adapter
   * command line) constructs a frozen origin, and only its `/api/turn-idle` call
   * passes one. Wire a caller-supplied origin into `send` / reply / relay (or into
   * the session-ready call, or into any new transport call) and one of these
   * assertions goes red — the mention/ carrier sets are computed from the source,
   * not from a substring's presence.
   */
  // 源码结构护栏(K2)：调用方可供给的身份只能经内部 turn-idle 事件进入 reporter，其余入口必须自己解析
  // live origin；这是跨函数的可达性约束，只能对源码做函数归属扫描（8da52fe7ab）。
  it('keeps the frozen origin reachable only from the internal turn-idle event', () => {
    // Every mention — the opts type, the opts read, the field assignments, the
    // construction and the pass-through — must sit in one of these two functions.
    expect(
      [...new Set([...code.matchAll(/frozenOrigin/g)]
        .map(m => enclosingFunctionName(code, m.index!)))].sort(),
    ).toEqual(['cmdTurnIdle', 'postSessionScopedSignal']);
    // Without a frozen origin the reporter re-resolves the live one itself.
    expect(code).toMatch(/liveOrigin = frozenOrigin \? undefined : resolveSessionContext\(/);
    // Exactly one producer, inside cmdTurnIdle, behind the v2 payload check.
    const producers = [...code.matchAll(/frozenOrigin = \{/g)];
    expect(producers).toHaveLength(1);
    const versionCheckAt = code.lastIndexOf('TURN_IDLE_PROTOCOL_VERSION', producers[0].index!);
    expect(enclosingFunctionName(code, versionCheckAt)).toBe('cmdTurnIdle');
    // …and exactly two carriers. session-ready passes NO opts (so it must resolve
    // the live origin itself); turn-idle passes the frozen one.
    expect([...code.matchAll(/await postSessionScopedSignal\(/g)]
      .map(m => enclosingFunctionName(code, m.index!)).sort())
      .toEqual(['cmdSessionReady', 'cmdTurnIdle']);
    expect(code).toMatch(/await postSessionScopedSignal\('\/api\/session-ready', \{[^}]*\}\);/);
    expect(code).toMatch(/await postSessionScopedSignal\('\/api\/turn-idle', \{[^}]*\}, \{\s*frozenOrigin\s*\}\);/);
  });
});

// ─── underReadIsolation ───────────────────────────────────────────────────

/**
 * Regression guard (2026-08-03 fleet P0, introduced by #668). Two earlier
 * versions of this predicate were wrong and both are pinned here as negative
 * cases, so a future "simplification" back to either one fails loudly.
 */
describe('underReadIsolation', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  const load = async () => (await import('../src/adapters/cli/read-isolation.js')).underReadIsolation;

  it('is true when the worker marked the child as sandboxed', async () => {
    const underReadIsolation = await load();
    process.env.BOTMUX_READ_ISOLATION = '1';
    expect(underReadIsolation()).toBe(true);
  });

  it('is false on a plain host', async () => {
    const underReadIsolation = await load();
    delete process.env.BOTMUX_READ_ISOLATION;
    expect(underReadIsolation()).toBe(false);
  });

  it('does NOT infer isolation from SESSION_DATA_DIR + BOTMUX_LARK_APP_ID', async () => {
    // Rejected v1: the worker injects both of those for EVERY bot it spawns,
    // sandboxed or not, so this shape is an ordinary CLI. Treating it as isolated
    // would swallow a real unreadable-bots.json fault on a normal host.
    const underReadIsolation = await load();
    delete process.env.BOTMUX_READ_ISOLATION;
    process.env.SESSION_DATA_DIR = '/h/.botmux/data';
    process.env.BOTMUX_LARK_APP_ID = 'cli_plain';
    expect(underReadIsolation()).toBe(false);
  });

  it('only accepts the exact marker value "1"', async () => {
    const underReadIsolation = await load();
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.BOTMUX_READ_ISOLATION = v;
      expect(underReadIsolation()).toBe(false);
    }
  });
});
