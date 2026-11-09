// Must stay the first import: this file fakes node:fs, so refuse to run outside
// the data-dir fence instead of touching live botmux data (see the helper).
import './helpers/require-fenced-data-dir.js';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeProtectedMcpCapabilities,
  prepareProtectedMcpWorkerProvisioning,
  protectedMcpConfiguredEnvKeys,
  protectedMcpGlobalRedactedEnvKeys,
  protectedMcpContainmentActive,
  protectedMcpContainmentConfigured,
  serveProtectedMcpSecrets,
  type ProtectedMcpCapabilityConfig,
} from '../src/core/protected-mcp-capabilities.js';
import { parseSandboxNetworkPolicy } from '../src/core/sandbox-network-policy.js';
import type { ProtectedHttpEgressWorkerPolicy } from '../src/core/protected-http-egress.js';

// Keep all real filesystem effects; intercept only the open boundary to
// deterministically replace an intermediate directory while its fd is live.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const fixtureCapability = (
  overrides: Partial<ProtectedMcpCapabilityConfig> = {},
): ProtectedMcpCapabilityConfig => ({
  enabled: false,
  allowedPluginIds: ['fixture-plugin'],
  secret: { source: 'file', path: '.secrets/mcp-secret' },
  principal: 'verified-human-email',
  containmentProfile: 'local-stdio-secret-v1',
  isolation: {
    protectedHomePaths: ['.fixture-credential'],
    redactEnv: ['FIXTURE_TOKEN'],
  },
  ...overrides,
});

const contained = parseSandboxNetworkPolicy({
  version: 1,
  public: { mode: 'allow' },
  private: { mode: 'block' },
  proxyMode: 'reject',
});

const frozenEgress: ProtectedHttpEgressWorkerPolicy = {
  pluginId: 'fixture-plugin',
  capabilityId: 'fixture.actor-write.v1',
  policy: {
    id: 'fixture.platform-write.v1',
    targets: [{
      scheme: 'https',
      host: 'fixture.internal.example',
      port: 443,
      denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }],
    }],
  },
  policyDigest: 'b'.repeat(64),
  frozenAddresses: [['10.20.30.40']],
};

describe.skipIf(process.platform !== 'linux')('protected MCP worker provisioning', () => {
  let home: string;
  let secretPath: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'protected-mcp-file-'));
    mkdirSync(join(home, '.secrets'));
    secretPath = join(home, '.secrets', 'mcp-secret');
    writeFileSync(secretPath, ' fixture-value\n', { mode: 0o600 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const provision = (home: string) => prepareProtectedMcpWorkerProvisioning(
    ['fixture-plugin'], home, { 'fixture.secret.v1': fixtureCapability({ enabled: true }) }, true,
  );

  it('reads the current file on each worker generation after atomic rotation', () => {
    const first = provision(home);
    writeFileSync(join(home, '.secrets', 'replacement'), 'rotated-secret\n', { mode: 0o600 });
    renameSync(join(home, '.secrets', 'replacement'), secretPath);
    const next = provision(home);
    expect(first.secrets.get('fixture.secret.v1')).toBe('fixture-value');
    expect(next.secrets.get('fixture.secret.v1')).toBe('rotated-secret');
    expect(JSON.stringify(next.workerPolicy)).not.toContain('rotated-secret');
  });

  it.each([0o400, 0o640, 0o644, 0o700, 0o1600])('rejects a secret whose exact mode is %s without repairing it', mode => {
    chmodSync(secretPath, mode);
    expect(provision(home).secrets.size).toBe(0);
    expect(lstatSync(secretPath).mode & 0o7777).toBe(mode);
  });

  it.each(['', ' \n\t ', 'x'.repeat(64 * 1024 + 1)])('rejects empty or oversized secret files (%#)', value => {
    writeFileSync(secretPath, value);
    expect(provision(home).workerPolicy.capabilities).toEqual([]);
  });

  it('rejects a leaf symlink and a directory rather than reading their targets', () => {
    renameSync(secretPath, join(home, '.secrets', 'original'));
    symlinkSync(join(home, '.secrets', 'original'), secretPath);
    expect(provision(home).secrets.size).toBe(0);
    rmSync(secretPath);
    mkdirSync(secretPath, { mode: 0o600 });
    expect(provision(home).secrets.size).toBe(0);
  });

  it('rejects an intermediate symlink even when it points back inside Home', () => {
    renameSync(join(home, '.secrets'), join(home, 'original'));
    symlinkSync(join(home, 'original'), join(home, '.secrets'));
    expect(provision(home).secrets.size).toBe(0);
  });

  it('keeps reads anchored to the opened directory during an intermediate replacement race', () => {
    const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;
    const outside = mkdtempSync(join(tmpdir(), 'protected-mcp-outside-'));
    writeFileSync(join(outside, 'mcp-secret'), 'attacker-secret', { mode: 0o600 });
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      const fd = realOpen(path, flags, mode);
      if (!swapped && String(path).endsWith('/.secrets')) {
        swapped = true;
        renameSync(join(home, '.secrets'), join(home, 'pinned'));
        symlinkSync(outside, join(home, '.secrets'));
      }
      return fd;
    });
    try {
      const provisioning = provision(home);
      expect(swapped).toBe(true);
      expect(provisioning.secrets.get('fixture.secret.v1')).not.toBe('attacker-secret');
      expect(['fixture-value', undefined]).toContain(provisioning.secrets.get('fixture.secret.v1'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a file owned by a different uid', () => {
    const actualUid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1);
    expect(provision(home).secrets.size).toBe(0);
  });

  it('accepts only validated Home-relative file sources while keeping old env names redacted', () => {
    expect(normalizeProtectedMcpCapabilities({ good: fixtureCapability({ enabled: true }) })).toEqual({ good: fixtureCapability({ enabled: true }) });
    for (const secret of [
      { source: 'env', name: 'OLD_SECRET' }, { source: 'file', path: '/tmp/secret' },
      { source: 'file', path: '../secret' }, { source: 'file', path: '.secrets/../secret' },
      { source: 'file', path: '.secrets/./secret' }, { source: 'file', path: 'bad\u0000path' },
    ]) {
      const raw = { invalid: { ...fixtureCapability({ enabled: true }), secret } };
      expect(normalizeProtectedMcpCapabilities(raw)).toBeUndefined();
    }
    expect(protectedMcpConfiguredEnvKeys({ old: {
      secret: { source: 'env', name: 'OLD_SECRET' }, isolation: { redactEnv: ['EXTRA_SECRET', 'bad-key'] },
    } })).toEqual(['OLD_SECRET', 'EXTRA_SECRET']);
    expect(protectedMcpGlobalRedactedEnvKeys({ good: fixtureCapability() })).toEqual(['FIXTURE_TOKEN']);
  });

  it('globally redacts env names and denies secret files while scoping extra Home paths to matching plugins', () => {
    const provisioning = prepareProtectedMcpWorkerProvisioning(
      [],
      home,
      { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
      true,
    );

    expect(provisioning.workerPolicy).toEqual({
      capabilities: [],
      protectedHomePaths: ['.secrets/mcp-secret'],
      redactEnv: ['FIXTURE_TOKEN'],
    });
    expect(provisioning.secrets.size).toBe(0);
  });

  it('keeps capabilities default-off while retaining matching isolation', () => {
    const provisioning = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      home,
      { 'fixture.secret.v1': fixtureCapability() },
      true,
    );

    expect(provisioning.workerPolicy).toEqual({
      capabilities: [],
      protectedHomePaths: ['.secrets/mcp-secret', '.fixture-credential'],
      redactEnv: ['FIXTURE_TOKEN'],
    });
    expect(provisioning.secrets.size).toBe(0);
  });

  it('provisions only an enabled, allowed, non-empty secret under static containment', () => {
    const enabled = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      home,
      { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
      true,
    );
    expect(enabled.workerPolicy.capabilities).toEqual([{
      id: 'fixture.secret.v1',
      allowedPluginIds: ['fixture-plugin'],
      principal: 'verified-human-email',
      containmentProfile: 'local-stdio-secret-v1',
    }]);
    expect(enabled.secrets.get('fixture.secret.v1')).toBe('fixture-value');
    expect(JSON.stringify(enabled.workerPolicy)).not.toContain('fixture-value');

    for (const provisioning of [
      prepareProtectedMcpWorkerProvisioning(
        ['other-plugin'],
        home,
        { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
        true,
      ),
      prepareProtectedMcpWorkerProvisioning(
        ['fixture-plugin'],
        home,
        { 'fixture.secret.v1': fixtureCapability({ enabled: true, secret: { source: 'file', path: '.secrets/missing' } }) },
        true,
      ),
      prepareProtectedMcpWorkerProvisioning(
        ['fixture-plugin'],
        home,
        { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
        false,
      ),
    ]) {
      expect(provisioning.workerPolicy.capabilities).toEqual([]);
      expect(provisioning.secrets.size).toBe(0);
    }
  });

  it('requires the fixed local stdio containment profile inputs', () => {
    const base = {
      platform: 'linux',
      backendType: 'pty',
      sandboxMode: 'oncall' as const,
      networkPolicy: contained,
      adopt: false,
    };
    expect(protectedMcpContainmentConfigured(base)).toBe(true);
    expect(protectedMcpContainmentConfigured({ ...base, platform: 'darwin' })).toBe(false);
    expect(protectedMcpContainmentConfigured({ ...base, backendType: 'tmux' })).toBe(false);
    expect(protectedMcpContainmentConfigured({ ...base, sandboxMode: 'off' })).toBe(false);
    expect(protectedMcpContainmentConfigured({ ...base, networkPolicy: undefined })).toBe(false);
    expect(protectedMcpContainmentConfigured({ ...base, adopt: true })).toBe(false);
  });

  it('uses the egress-guard profile only for local Linux PTY oncall sessions with frozen targets', () => {
    const base = {
      platform: 'linux',
      backendType: 'pty',
      sandboxMode: 'oncall' as const,
      networkPolicy: undefined,
      protectedHttpEgressPolicy: frozenEgress,
      adopt: false,
    };
    expect(protectedMcpContainmentConfigured(base)).toBe(true);
    for (const input of [
      { ...base, platform: 'darwin' },
      { ...base, backendType: 'tmux' },
      { ...base, sandboxMode: 'off' as const },
      { ...base, adopt: true },
      { ...base, protectedHttpEgressPolicy: undefined },
    ]) expect(protectedMcpContainmentConfigured(input)).toBe(false);

    const enabled = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      home,
      {
        'fixture.actor-write.v1': fixtureCapability({
          enabled: true,
          allowedPluginIds: ['fixture-plugin', 'unrelated-plugin'],
          containmentProfile: 'local-stdio-secret-egress-guard-v1',
        }),
        'fixture.unrelated.v1': fixtureCapability({
          enabled: true,
          allowedPluginIds: ['unrelated-plugin'],
        }),
      },
      true,
      frozenEgress,
    );
    expect(enabled.workerPolicy.capabilities).toEqual([{
      id: 'fixture.actor-write.v1',
      allowedPluginIds: ['fixture-plugin'],
      principal: 'verified-human-email',
      containmentProfile: 'local-stdio-secret-egress-guard-v1',
    }]);
    expect([...enabled.secrets.keys()]).toEqual(['fixture.actor-write.v1']);

    const disabled = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      home,
      { 'fixture.actor-write.v1': fixtureCapability({
        enabled: false,
        containmentProfile: 'local-stdio-secret-egress-guard-v1',
      }) },
      true,
      frozenEgress,
    );
    expect(disabled.workerPolicy.capabilities).toEqual([]);
    expect(disabled.secrets.size).toBe(0);
  });

  it('requires the egress containment profile only for the descriptor-bound capability', () => {
    const oldProfile = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      home,
      { 'fixture.actor-write.v1': fixtureCapability({ enabled: true }) },
      true,
      frozenEgress,
    );
    expect(oldProfile.workerPolicy.capabilities).toEqual([]);
    expect(oldProfile.secrets.size).toBe(0);

    const egressProfileWithoutDescriptor = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      home,
      { 'fixture.other.v1': fixtureCapability({
        enabled: true,
        containmentProfile: 'local-stdio-secret-egress-guard-v1',
      }) },
      true,
    );
    expect(egressProfileWithoutDescriptor.workerPolicy.capabilities).toEqual([]);
    expect(egressProfileWithoutDescriptor.secrets.size).toBe(0);
  });

  it('authorizes the egress-guard profile only with live digest-bound guard and complete sandbox proof', () => {
    const complete = {
      platform: 'linux',
      containmentProfile: 'local-stdio-secret-egress-guard-v1' as const,
      provisionedCapabilityCount: 1,
      sandboxEngaged: true,
      mcpSocketMounted: true,
      egressSocketMounted: true,
      guardLive: true,
      expectedPolicyDigest: frozenEgress.policyDigest,
      guardPolicyDigest: frozenEgress.policyDigest,
      pidNamespaceRetained: true,
      networkPolicy: contained,
    };
    expect(protectedMcpContainmentActive(complete)).toBe(true);
    for (const input of [
      { ...complete, sandboxEngaged: false },
      { ...complete, mcpSocketMounted: false },
      { ...complete, egressSocketMounted: false },
      { ...complete, guardLive: false },
      { ...complete, guardPolicyDigest: 'c'.repeat(64) },
      { ...complete, pidNamespaceRetained: false },
      { ...complete, provisionedCapabilityCount: 0 },
    ]) expect(protectedMcpContainmentActive(input)).toBe(false);
  });
});

async function runChannelFixture(input: {
  fixture: string;
  count: number;
  secrets: ReadonlyMap<string, string>;
  capabilityId?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const worker = spawn(process.env.NODE_BINARY ?? 'node', [
    resolve(`test/fixtures/${input.fixture}`),
    String(input.count),
    input.capabilityId ?? 'fixture.secret.v1',
  ], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  serveProtectedMcpSecrets(worker, input.secrets);
  worker.stdout.setEncoding('utf8');
  worker.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  worker.stdout.on('data', chunk => { stdout += chunk; });
  worker.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(worker, 'close');
  return { code, stdout, stderr };
}

describe('protected MCP secret channel', () => {
  it('rejects a worker attempt to request an unprovisioned capability', async () => {
    const result = await runChannelFixture({
      fixture: 'protected-secret-channel-limit-worker.mjs',
      count: 1,
      capabilityId: 'fixture.other.v1',
      secrets: new Map([['fixture.secret.v1', 'fixture-value']]),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ successes: 0, failures: 1 });
  });

  it('delivers 40 overlapping handshakes without partial frames or leaks', async () => {
    const secret = 'forty-way-overlap-secret';
    const result = await runChannelFixture({
      fixture: 'protected-secret-concurrency-worker.mjs',
      count: 40,
      secrets: new Map([['fixture.secret.v1', secret]]),
    });
    expect(result.code, result.stderr).toBe(0);
    const results = JSON.parse(result.stdout) as Array<{
      code: number | null;
      signal: string | null;
      stderr: string;
      result?: {
        id: string;
        secret: string;
        secretInEnv: boolean;
        secretInArgv: boolean;
        fdEnv: string;
      };
    }>;
    expect(results).toHaveLength(40);
    expect(results.filter(entry => entry.code === 0), JSON.stringify(results)).toHaveLength(40);
    expect(results.map(entry => entry.result?.id).sort((a, b) => Number(a) - Number(b)))
      .toEqual(Array.from({ length: 40 }, (_, index) => String(index)));
    for (const entry of results) {
      expect(entry.result).toMatchObject({
        secret,
        secretInEnv: false,
        secretInArgv: false,
        fdEnv: '3',
      });
    }
  }, 15_000);

  it('caps overlapping live secret channels at 128', async () => {
    const result = await runChannelFixture({
      fixture: 'protected-secret-channel-limit-worker.mjs',
      count: 129,
      secrets: new Map([['fixture.secret.v1', 'channel-limit-secret']]),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ successes: 128, failures: 1 });
  }, 15_000);
});
