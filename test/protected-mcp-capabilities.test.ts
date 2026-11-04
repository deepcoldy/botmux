import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureProtectedMcpDaemonEnvironment,
  prepareProtectedMcpWorkerProvisioning,
  protectedMcpContainmentActive,
  protectedMcpContainmentConfigured,
  serveProtectedMcpSecrets,
  type ProtectedMcpCapabilityConfig,
} from '../src/core/protected-mcp-capabilities.js';
import { parseSandboxNetworkPolicy } from '../src/core/sandbox-network-policy.js';
import type { ProtectedHttpEgressWorkerPolicy } from '../src/core/protected-http-egress.js';

const fixtureCapability = (
  overrides: Partial<ProtectedMcpCapabilityConfig> = {},
): ProtectedMcpCapabilityConfig => ({
  enabled: false,
  allowedPluginIds: ['fixture-plugin'],
  secret: { source: 'env', name: 'FIXTURE_SECRET' },
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
  policy: {
    id: 'fixture.secret.v1',
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

describe('protected MCP worker provisioning', () => {
  it('captures configured secrets once and removes every protected env name from the daemon', () => {
    const env: NodeJS.ProcessEnv = {
      FIXTURE_SECRET: ' daemon-secret ',
      FIXTURE_TOKEN: 'daemon-token',
      BOTMUX_PROTECTED_SECRET_FD: '3',
      UNRELATED: 'visible',
    };
    const captured = captureProtectedMcpDaemonEnvironment(
      { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
      env,
    );

    expect(captured.get('FIXTURE_SECRET')).toBe('daemon-secret');
    for (const key of ['FIXTURE_SECRET', 'FIXTURE_TOKEN', 'BOTMUX_PROTECTED_SECRET_FD']) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env.UNRELATED).toBe('visible');

    const provisioning = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      captured,
      { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
      true,
    );
    expect(provisioning.secrets.get('fixture.secret.v1')).toBe('daemon-secret');
  });

  it('globally redacts configured secret env names without widening Home paths for unmatched plugins', () => {
    const provisioning = prepareProtectedMcpWorkerProvisioning(
      [],
      {
        FIXTURE_SECRET: 'must-stay-daemon-only',
        FIXTURE_TOKEN: 'must-also-stay-daemon-only',
      },
      { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
      true,
    );

    expect(provisioning.workerPolicy).toEqual({
      capabilities: [],
      protectedHomePaths: [],
      redactEnv: ['FIXTURE_SECRET', 'FIXTURE_TOKEN'],
    });
    expect(provisioning.secrets.size).toBe(0);
  });

  it('keeps capabilities default-off while retaining matching isolation', () => {
    const provisioning = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      { FIXTURE_SECRET: 'fixture-value' },
      { 'fixture.secret.v1': fixtureCapability() },
      true,
    );

    expect(provisioning.workerPolicy).toEqual({
      capabilities: [],
      protectedHomePaths: ['.fixture-credential'],
      redactEnv: ['FIXTURE_SECRET', 'FIXTURE_TOKEN'],
    });
    expect(provisioning.secrets.size).toBe(0);
  });

  it('provisions only an enabled, allowed, non-empty secret under static containment', () => {
    const enabled = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      { FIXTURE_SECRET: ' fixture-value ' },
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
        { FIXTURE_SECRET: 'fixture-value' },
        { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
        true,
      ),
      prepareProtectedMcpWorkerProvisioning(
        ['fixture-plugin'],
        {},
        { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
        true,
      ),
      prepareProtectedMcpWorkerProvisioning(
        ['fixture-plugin'],
        { FIXTURE_SECRET: 'fixture-value' },
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
      { FIXTURE_SECRET: 'fixture-value' },
      { 'fixture.secret.v1': fixtureCapability({ enabled: true }) },
      true,
      'local-stdio-secret-egress-guard-v1',
    );
    expect(enabled.workerPolicy.capabilities[0]?.containmentProfile)
      .toBe('local-stdio-secret-egress-guard-v1');

    const disabled = prepareProtectedMcpWorkerProvisioning(
      ['fixture-plugin'],
      { FIXTURE_SECRET: 'fixture-value' },
      { 'fixture.secret.v1': fixtureCapability({ enabled: false }) },
      true,
      'local-stdio-secret-egress-guard-v1',
    );
    expect(disabled.workerPolicy.capabilities).toEqual([]);
    expect(disabled.secrets.size).toBe(0);
  });

  it('authorizes the egress-guard profile only with live digest-bound guard and complete sandbox proof', () => {
    const complete = {
      platform: 'linux',
      containmentProfile: 'local-stdio-secret-egress-guard-v1' as const,
      provisionedCapabilityCount: 1,
      sandboxEngaged: true,
      mcpSocketMounted: true,
      egressSocketMounted: true,
      directTargetDenyRulesInstalled: true,
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
      { ...complete, directTargetDenyRulesInstalled: false },
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
