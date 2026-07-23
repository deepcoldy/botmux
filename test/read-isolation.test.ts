import { describe, it, expect } from 'vitest';
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
});

describe('worker capability carve-out ordering', () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('publishes each child-visible capability before the sandbox starts', () => {
    const macPathAt = source.indexOf("readIsolationOriginCapabilityFile = process.platform === 'darwin'");
    const macPublishAt = source.indexOf(
      'publishSandboxRelayCapability({ failClosed: true })',
      macPathAt,
    );
    const policyAt = source.indexOf('const policy = buildFsPolicy({', macPublishAt);
    expect(macPathAt).toBeGreaterThanOrEqual(0);
    expect(macPublishAt).toBeGreaterThan(macPathAt);
    expect(policyAt).toBeGreaterThan(macPublishAt);
    expect(source).toContain('mandatoryReadOnlyPaths.push(readIsolationOriginCapabilityFile)');

    const relayAt = source.indexOf('sandboxRelayOutbox = sbx.outbox');
    const relayPublishAt = source.indexOf('publishSandboxRelayCapability();', relayAt);
    expect(relayAt).toBeGreaterThan(policyAt);
    expect(relayPublishAt).toBeGreaterThan(relayAt);
    expect(source).toContain('replaceManagedOriginCapabilityFile(profilePath, buildSeatbeltProfile(');
  });

  it('denies every same-UID Gateway socket before allowing only the current session socket', () => {
    const regexAt = source.indexOf('sessionMcpGatewayPathRegex(gatewaySocketRoot)');
    const denyAt = source.indexOf('mandatoryDenyRegexes.push(', regexAt - 80);
    const allowAt = source.indexOf(
      'mandatoryReadOnlyPaths.push(canonical(sessionMcpGatewayHost.socketDir))',
      regexAt,
    );
    const profileAt = source.indexOf('const policy = buildFsPolicy({', allowAt);
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
