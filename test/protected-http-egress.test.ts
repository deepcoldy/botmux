import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectProtectedHttpEgressPolicies,
  normalizeProtectedHttpEgressPolicy,
  normalizeProtectedHttpPath,
  protectedHttpEgressDecision,
  protectedHttpEgressPolicyDigest,
  resolveProtectedHttpEgressTargets,
} from '../src/core/protected-http-egress.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { pluginMcpPrivatePath } from '../src/core/plugins/paths.js';

const validPolicy = {
  id: 'fixture.write.v1',
  targets: [{
    scheme: 'https',
    host: 'fixture.internal.example',
    port: 443,
    denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }],
  }],
};

describe('protected HTTP egress policy schema', () => {
  it('normalizes a valid policy and hashes its key-sorted representation', () => {
    const reordered = {
      targets: [{
        port: 443,
        denyRoutes: [{ path: '/v1/items/update', methods: ['POST'] }],
        scheme: 'https',
        host: 'fixture.internal.example',
      }],
      id: 'fixture.write.v1',
    };

    const normalized = normalizeProtectedHttpEgressPolicy(reordered);

    expect(normalized).toEqual(validPolicy);
    expect(normalized).not.toBe(reordered);
    expect(protectedHttpEgressPolicyDigest(normalized!)).toBe(
      'b8dc12e11e75dc147bf984b81b59a9f8e1bd68163ed563acd4cd4ef9da445816',
    );
  });

  it.each([
    ['invalid id', { ...validPolicy, id: '../escape' }],
    ['non-https scheme', { ...validPolicy, targets: [{ ...validPolicy.targets[0], scheme: 'http' }] }],
    ['wildcard host', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: '*.example.com' }] }],
    ['upper-case host', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: 'API.example.com' }] }],
    ['IP literal host', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: '127.0.0.1' }] }],
    ['abbreviated IP literal host', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: '127.1' }] }],
    ['integer IP literal host', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: '2130706433' }] }],
    ['hex IP literal host', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: '0x7f000001' }] }],
    ['host with user info', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: 'user@example.com' }] }],
    ['host with slash', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: 'example.com/path' }] }],
    ['host with colon', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: 'example.com:443' }] }],
    ['host with trailing dot', { ...validPolicy, targets: [{ ...validPolicy.targets[0], host: 'example.com.' }] }],
    ['zero port', { ...validPolicy, targets: [{ ...validPolicy.targets[0], port: 0 }] }],
    ['too-large port', { ...validPolicy, targets: [{ ...validPolicy.targets[0], port: 65_536 }] }],
    ['fractional port', { ...validPolicy, targets: [{ ...validPolicy.targets[0], port: 443.5 }] }],
    ['lower-case method', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [{ methods: ['post'], path: '/v1/items/update' }] }] }],
    ['non-token method', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [{ methods: ['POST GET'], path: '/v1/items/update' }] }] }],
    ['relative route', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [{ methods: ['POST'], path: 'relative' }] }] }],
    ['unknown policy field', { ...validPolicy, future: true }],
    ['unknown target field', { ...validPolicy, targets: [{ ...validPolicy.targets[0], future: true }] }],
    ['unknown route field', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [{ methods: ['POST'], path: '/v1/items/update', future: true }] }] }],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeProtectedHttpEgressPolicy(raw)).toBeUndefined();
  });

  it.each([
    ['empty targets', { ...validPolicy, targets: [] }],
    ['too many targets', { ...validPolicy, targets: Array.from({ length: 9 }, (_, index) => ({
      ...validPolicy.targets[0],
      host: `fixture-${index}.internal.example`,
    })) }],
    ['duplicate targets', { ...validPolicy, targets: [
      validPolicy.targets[0],
      { ...validPolicy.targets[0], denyRoutes: [{ methods: ['PUT'], path: '/v1/items/update' }] },
    ] }],
    ['empty routes', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [] }] }],
    ['too many routes', { ...validPolicy, targets: [{
      ...validPolicy.targets[0],
      denyRoutes: Array.from({ length: 129 }, (_, index) => ({ methods: ['POST'], path: `/v1/items/${index}` })),
    }] }],
    ['empty methods', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [{ methods: [], path: '/v1/items/update' }] }] }],
    ['too many methods', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [{
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'],
      path: '/v1/items/update',
    }] }] }],
    ['duplicate method/path pair in one route', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [{ methods: ['POST', 'POST'], path: '/v1/items/update' }] }] }],
    ['duplicate method/path pair across routes', { ...validPolicy, targets: [{ ...validPolicy.targets[0], denyRoutes: [
      { methods: ['POST', 'PUT'], path: '/v1/items/update' },
      { methods: ['POST'], path: '/v1/items/update' },
    ] }] }],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeProtectedHttpEgressPolicy(raw)).toBeUndefined();
  });
});

describe('protected HTTP egress worker policy collection', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-egress-policy-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function installPolicyPlugin(
    pluginId: string,
    policy = validPolicy,
    protectedCapability = policy.id,
  ): void {
    const source = join(home, `${pluginId}-source`);
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: `@botmux-ai/plugin-${pluginId}`,
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: pluginId },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [process.execPath, '--version'],
      protectedCapability,
      protectedEgressPolicy: policy,
    }));
    installLocalPlugin(source);
  }

  it('collects enabled plugin policies independently of protected capability enablement', () => {
    installPolicyPlugin('fixture-plugin');

    const collected = collectProtectedHttpEgressPolicies(['fixture-plugin']);

    expect(collected).toEqual([{
      pluginId: 'fixture-plugin',
      policy: validPolicy,
      policyDigest: protectedHttpEgressPolicyDigest(validPolicy),
    }]);
    expect(collectProtectedHttpEgressPolicies([])).toEqual([]);
    expect(collectProtectedHttpEgressPolicies(['not-enabled'])).toEqual([]);
  });

  it('aborts collection when an enabled plugin private descriptor is missing or invalid', () => {
    installPolicyPlugin('fixture-plugin');
    rmSync(pluginMcpPrivatePath('fixture-plugin'));
    expect(() => collectProtectedHttpEgressPolicies(['fixture-plugin']))
      .toThrow('plugin_mcp_private_descriptor_missing:fixture-plugin');

    installPolicyPlugin('fixture-plugin');
    writeFileSync(pluginMcpPrivatePath('fixture-plugin'), '{not-json');
    expect(() => collectProtectedHttpEgressPolicies(['fixture-plugin'])).toThrow();
  });

  it('rejects a policy whose id is not bound to the same plugin protected capability', () => {
    installPolicyPlugin('fixture-plugin', validPolicy, 'fixture.unrelated.v1');

    expect(() => collectProtectedHttpEgressPolicies(['fixture-plugin']))
      .toThrow('plugin_mcp_protected_egress_capability_mismatch:fixture-plugin');
  });

  it('freezes unique A and AAAA results once per target and caps each target at 32 addresses', async () => {
    const policy = normalizeProtectedHttpEgressPolicy({
      id: 'fixture.resolve.v1',
      targets: [
        { ...validPolicy.targets[0], host: 'one.internal.example' },
        { ...validPolicy.targets[0], host: 'two.internal.example' },
      ],
    })!;
    const calls: Array<{ host: string; options: unknown }> = [];
    const lookup = async (host: string, options: { all: true; verbatim: true }) => {
      calls.push({ host, options });
      if (host === 'one.internal.example') {
        return [
          { address: '10.20.30.40', family: 4 as const },
          { address: '2001:db8::40', family: 6 as const },
          { address: '10.20.30.40', family: 4 as const },
        ];
      }
      return Array.from({ length: 40 }, (_, index) => ({
        address: `2001:db8::${(index + 1).toString(16)}`,
        family: 6 as const,
      }));
    };

    const frozen = await resolveProtectedHttpEgressTargets(policy, lookup);

    expect(calls).toEqual([
      { host: 'one.internal.example', options: { all: true, verbatim: true } },
      { host: 'two.internal.example', options: { all: true, verbatim: true } },
    ]);
    expect(frozen[0]).toEqual(['10.20.30.40', '2001:db8::40']);
    expect(frozen[1]).toHaveLength(32);
    expect(frozen[1][0]).toBe('2001:db8::1');
    expect(frozen[1][31]).toBe('2001:db8::20');
  });

  it('fails closed when a target resolves to no usable address', async () => {
    await expect(resolveProtectedHttpEgressTargets(
      validPolicy,
      async () => [],
    )).rejects.toThrow('protected_http_egress_target_not_frozen');
  });
});

describe('protected HTTP egress route decisions', () => {
  const policy = normalizeProtectedHttpEgressPolicy({
    id: 'fixture.catalog.write.v1',
    targets: [{
      scheme: 'https',
      host: 'fixture.internal.example',
      port: 443,
      denyRoutes: [{ methods: ['POST'], path: '/api/v2/catalog/info' }],
    }],
  })!;

  const decide = (method: string, path: string) => (
    protectedHttpEgressDecision(policy, policy.id, method, path)
  );

  it('denies exact registered method/path pairs without treating reads or sibling routes as writes', () => {
    expect(decide('POST', '/api/v2/catalog/info')).toBe('deny');
    expect(decide('post', '/api/v2/catalog/info?x=1')).toBe('deny');
    expect(decide('GET', '/api/v2/catalog/info')).toBe('allow');
    expect(decide('POST', '/api/v2/catalog/list')).toBe('allow');
  });

  it.each([
    ['/api/v2/catalog/%69nfo', 'encoded unreserved character'],
    ['/api/v2/catalog/../catalog/info', 'dot segment'],
    ['/api/v2/catalog/./info', 'single-dot segment'],
    ['//api/v2/catalog/info', 'scheme-relative path'],
    ['https://fixture.internal.example/api/v2/catalog/info', 'absolute URL'],
    ['/api/v2/catalog\\info', 'backslash'],
    ['/api/v2/catalog/%2finfo', 'encoded slash'],
    ['/api/v2/catalog/%5Cinfo', 'encoded backslash'],
    ['/api/v2/catalog/%2e%2e/info', 'encoded dot segment'],
    ['/api/v2/catalog/info/', 'trailing separator'],
    ['/api/v2/catalog//info', 'repeated separator'],
    ['/api/v2/catalog/%2569nfo', 'encoded percent alias'],
    ['/api/v2/catalog/%252e%252e/info', 'double-encoded dot segment'],
    ['/api/v2/catalog/%', 'invalid percent escape'],
    ['/api/v2/catalog/%0ainfo', 'encoded control character'],
    ['/api/v2/catalog/info\u0000', 'literal control character'],
    ['/api/v2/catalog/info#fragment', 'fragment'],
  ])('rejects ambiguous or unsafe path spelling: %s (%s)', (path) => {
    expect(() => decide('POST', path)).toThrow('invalid_protected_http_path');
  });

  it('preserves query semantics while canonicalizing percent hex case', () => {
    expect(normalizeProtectedHttpPath('/api/v2/catalog/list?cursor=%aa%2f&view=all'))
      .toBe('/api/v2/catalog/list?cursor=%AA%2F&view=all');
  });

  it('fails closed on a policy identifier mismatch or malformed method', () => {
    expect(() => protectedHttpEgressDecision(
      policy,
      'fixture.other.write.v1',
      'POST',
      '/api/v2/catalog/info',
    )).toThrow('protected_http_egress_policy_mismatch');
    expect(() => decide('POST GET', '/api/v2/catalog/info'))
      .toThrow('invalid_protected_http_method');
  });
});
