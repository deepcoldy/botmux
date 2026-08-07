import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  evaluateReadIsolationGate,
  evaluateCredentialOnlyIsolationGate,
  credentialIsolationRequired,
  deviceCredentialIsolationMarkerPath,
  isCredentialIsolationReservedBasename,
  buildCredentialIsolationRules,
  isolatedPaneReattachSafe,
  isolationPaneMarkerContent,
  ISOLATION_PANE_MARKER_VERSION,
  botHomePath,
  buildCliExecutableReadCarveOuts,
  sendCredFilePath,
  assertSafeAppId,
  normalizeIsolationPath,
} from '../src/adapters/cli/read-isolation.js';

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
});

// ─── cold-start migration: START-TIME env contract (bots.json EPERM fix) ──────

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

  it('has moved the version past 9 (credential-only capability mount contract)', () => {
    // Reverting below 10 would silently warm-reattach credential-only panes
    // that lack the private capability mount/env contract.
    expect(ISOLATION_PANE_MARKER_VERSION).toBeGreaterThan(9);
  });
});

describe('worker capability carve-out ordering', () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('publishes each child-visible capability before the sandbox starts', () => {
    const macPathAt = source.indexOf("readIsolationOriginCapabilityFile = process.platform === 'darwin'");
    const macPublishAt = source.indexOf(
      'publishSandboxRelayCapability({ failClosed: true })',
      macPathAt,
    );
    const policyAt = source.indexOf('const fsPolicyCtx = {', macPublishAt);
    expect(macPathAt).toBeGreaterThanOrEqual(0);
    expect(macPublishAt).toBeGreaterThan(macPathAt);
    expect(policyAt).toBeGreaterThan(macPublishAt);
    expect(source).toContain('mandatoryReadOnlyPaths.push(readIsolationOriginCapabilityFile)');

    const relayAt = source.indexOf('sandboxRelayOutbox = sbx.outbox');
    const relayPublishAt = source.indexOf('publishSandboxRelayCapability();', relayAt);
    expect(relayAt).toBeGreaterThan(policyAt);
    expect(relayPublishAt).toBeGreaterThan(relayAt);
    expect(source).toContain('replaceManagedOriginCapabilityFile(profilePath, buildSeatbeltProfile(');

    const credentialSetupAt = source.indexOf('if (credentialOnlyBwrap) {');
    const credentialDirectoryAt = source.indexOf(
      'managedOriginCapabilityDirectory(\n      isolationRuntimeDataDir,\n      cfg.sessionId,',
      credentialSetupAt,
    );
    const credentialPublishAt = source.indexOf(
      'publishSandboxRelayCapability({ failClosed: true })',
      credentialDirectoryAt,
    );
    const credentialBwrapAt = source.indexOf(
      'if (!willReattachPersistent && credentialOnlyBwrap)',
      credentialPublishAt,
    );
    const credentialSandboxAt = source.indexOf(
      'prepareCredentialOnlySandbox({',
      credentialBwrapAt,
    );
    expect(credentialSetupAt).toBeGreaterThan(-1);
    expect(credentialDirectoryAt).toBeGreaterThan(credentialSetupAt);
    expect(credentialPublishAt).toBeGreaterThan(credentialDirectoryAt);
    expect(credentialBwrapAt).toBeGreaterThan(credentialPublishAt);
    expect(credentialSandboxAt).toBeGreaterThan(credentialBwrapAt);
    expect(source).toContain('privateReadonlyDirectories: [{');
    expect(source).toContain('childEnv[MANAGED_ORIGIN_CAPABILITY_DIR_ENV]');
    expect(source).toContain('delete childEnv[MANAGED_ORIGIN_CAPABILITY_DIR_ENV]');
  });

  it('denies every same-UID Gateway socket before allowing only the current session socket', () => {
    const regexAt = source.indexOf('sessionMcpGatewayPathRegex(gatewaySocketRoot)');
    const denyAt = source.indexOf('mandatoryDenyRegexes.push(', regexAt - 80);
    const allowAt = source.indexOf(
      'mandatoryReadOnlyPaths.push(canonical(sessionMcpGatewayHost.socketDir))',
      regexAt,
    );
    const profileAt = source.indexOf('const fsPolicyCtx = {', allowAt);
    expect(regexAt).toBeGreaterThanOrEqual(0);
    expect(denyAt).toBeGreaterThanOrEqual(0);
    expect(denyAt).toBeLessThanOrEqual(regexAt);
    expect(allowAt).toBeGreaterThan(denyAt);
    expect(profileAt).toBeGreaterThan(allowAt);
    expect(source).toContain('mcpGatewaySocketPath: sessionMcpGatewayHost?.socketPath');
  });

  it('carves back only the prepared Pi session prompt directory after masking the shared root', () => {
    expect(source).toContain('readonlyRoots: keepExisting([');
    expect(source).toContain('...piInitialPromptReadonlyRoots,');
    expect(source).not.toContain(
      'cfg.skillReadonlyRoots = [...(cfg.skillReadonlyRoots ?? []), ...prepared.readonlyRoots]',
    );
  });

  it('wires adapter sandboxReadonlyPaths() into the readonlyRoots channel (traex/coco migration markers)', () => {
    // Guards a call-site blind spot: the adapter test only checks the method's
    // RETURN value and the fs-policy test hand-feeds readonlyRoots, so if this
    // spread were deleted the markers would silently stop reaching the sandbox
    // and BOTH of those tests would stay green (goal-mode traex would wedge again
    // on the migration prompt). Assert the worker actually threads the method
    // output into readonlyRoots.
    expect(source).toContain('...[...(cliAdapter.sandboxReadonlyPaths?.() ?? [])].map(expandTildeLexical),');
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
    expect(source).toContain('isolatedPaneReattachSafe(marker, appliedIsolationCapabilities)');
  });
});

describe('CLI protected capability wiring', () => {
  const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const vcSource = readFileSync(new URL('../src/cli/vc-agent.ts', import.meta.url), 'utf8');

  it('passes the session id when resolving protected turn snapshots', () => {
    expect(cliSource).toContain(
      'const liveMarkerCtx = resolveSessionContext(\n    resolveDataDir(),\n    process.env.BOTMUX_SESSION_ID,',
    );
    expect(cliSource).toContain(
      'const liveOrigin = resolveSessionContext(resolveDataDir(), sessionId);',
    );
    expect(vcSource).toContain(
      'const liveOrigin = resolveSessionContext(config.session.dataDir, receiverSessionId);',
    );
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
