import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  BYTEDCLI_OPERATION_POLICY_SCHEMA, parseBytedcliOperationPolicy, resolveBytedcliOperationRule,
} from '../src/core/bytedcli-operation-policy-config.js';
import { BYTEDCLI_OPERATION_CATALOG, BYTEDCLI_OPERATION_GRAMMAR } from '../src/core/bytedcli-operation-catalog.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';

const base = { schema: 'botmux.bytedcli-operation-policy.v1', cliVersion: '0.199.0', catalogVersion: '2026-11-26.1' };
const policy = (rules: Record<string, unknown>) => parseBytedcliOperationPolicy({ ...base, rules });

describe('versioned bytedcli operation policy', () => {
  it('normalizes known rules into an immutable independent snapshot', () => {
    const raw = { ...base, rules: { 'codebase.mr.list': 'actor', 'codebase.mr.close': 'deny' } };
    const parsed = parseBytedcliOperationPolicy(raw)!;
    raw.rules['codebase.mr.list'] = 'machine';
    expect(parsed).toEqual({ ...base, rules: { 'codebase.mr.close': 'deny', 'codebase.mr.list': 'actor' } });
    expect(parsed.schema).toBe(BYTEDCLI_OPERATION_POLICY_SCHEMA);
    expect(Object.keys(parsed.rules)).toEqual(['codebase.mr.close', 'codebase.mr.list']);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.rules)).toBe(true);
    expect(() => { (parsed.rules as Record<string, string>)['codebase.mr.list'] = 'machine'; }).toThrow();
    expect(parseBytedcliOperationPolicy(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('clears optional config only on absent or null input and accepts explicit inheritance', () => {
    expect(parseBytedcliOperationPolicy(undefined)).toBeUndefined();
    expect(parseBytedcliOperationPolicy(null)).toBeUndefined();
    expect(policy({})).toEqual({ ...base, rules: {} });
  });

  it('rejects machine identity for every write even before policies are composed', () => {
    for (const operationId of ['codebase.mr.create', 'codebase.mr.update', 'codebase.mr.close', 'codebase.mr.reopen']) {
      expect(() => policy({ [operationId]: 'machine' })).toThrow();
      expect(policy({ [operationId]: 'actor' })?.rules[operationId]).toBe('actor');
    }
  });

  it('rejects unknown IDs, aliases and auth/help instead of granting business execution', () => {
    for (const operationId of ['codebase.mr.merge', 'codebase.pr.list', 'codebase.mr.edit', 'auth.login',
      'help.codebase.mr.list', 'toString', '__proto__']) {
      expect(() => policy({ [operationId]: 'actor' })).toThrow();
      expect(() => resolveBytedcliOperationRule(operationId)).toThrow();
    }
  });

  it('rejects unknown fields, versions, malformed objects and unsupported rules with bounded errors', () => {
    const invalid = [false, [], '', 1, {}, { ...base }, { ...base, rules: [] }, { ...base, rules: null },
      { ...base, rules: {}, schema: 'v2' }, { ...base, rules: {}, cliVersion: '0.200.0' },
      { ...base, rules: {}, catalogVersion: '2026-11-27.1' }, { ...base, rules: {}, effect: 'read' },
      { ...base, rules: {}, ['secret'.repeat(1000)]: true },
      ...['inherit', 'read', true, null, {}, ''].map(rule => ({ ...base, rules: { 'codebase.mr.list': rule } })),
      { ...base, rules: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`unknown.${i}`, 'deny'])) },
    ];
    for (const raw of invalid) {
      let error: unknown;
      try { parseBytedcliOperationPolicy(raw); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.length).toBeLessThan(256);
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('rejects hidden, symbolic, accessor and non-data object fields instead of dropping rules', () => {
    const hidden = Object.defineProperty({ ...base, rules: {} }, 'unknown', { value: true });
    const hiddenRule = Object.defineProperty({}, 'codebase.mr.list', { value: 'deny' });
    const accessor = { ...base, get rules() { throw new Error('private detail'); } };
    for (const raw of [hidden, { ...base, rules: hiddenRule }, { ...base, rules: {}, [Symbol('unknown')]: true },
      accessor, new Date(), { ...base, rules: new Map() }]) {
      expect(() => parseBytedcliOperationPolicy(raw)).toThrow();
    }
    expect(() => policy({ 'codebase.mr.list': { toString() { throw new Error('private detail'); } } }))
      .toThrow(/Invalid bytedcli/);
  });

  it('preserves real effects and audited defaults when policies are absent', () => {
    expect(resolveBytedcliOperationRule('codebase.mr.list'))
      .toEqual({ operationId: 'codebase.mr.list', effect: 'read', enabled: true, identity: 'machine' });
    expect(resolveBytedcliOperationRule('codebase.mr.close'))
      .toEqual({ operationId: 'codebase.mr.close', effect: 'write', enabled: true, identity: 'actor' });
  });

  it('keeps the global actor floor when the bot asks for machine reads', () => {
    const globalPolicy = policy({ 'codebase.mr.list': 'actor' });
    const botPolicy = policy({ 'codebase.mr.list': 'machine' });
    const result = resolveBytedcliOperationRule('codebase.mr.list', globalPolicy, botPolicy);
    expect(result).toEqual({ operationId: 'codebase.mr.list', effect: 'read', enabled: true, identity: 'actor' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(globalPolicy?.rules['codebase.mr.list']).toBe('actor');
    expect(botPolicy?.rules['codebase.mr.list']).toBe('machine');
  });

  it('keeps deny from either layer and lets the bot further tighten machine reads', () => {
    expect(resolveBytedcliOperationRule('codebase.mr.list', policy({ 'codebase.mr.list': 'deny' }),
      policy({ 'codebase.mr.list': 'actor' }))).toMatchObject({ enabled: false });
    expect(resolveBytedcliOperationRule('codebase.mr.close', policy({ 'codebase.mr.close': 'deny' }),
      policy({ 'codebase.mr.close': 'actor' }))).toMatchObject({ effect: 'write', enabled: false, identity: 'actor' });
    expect(resolveBytedcliOperationRule('codebase.mr.list', policy({ 'codebase.mr.list': 'machine' }),
      policy({ 'codebase.mr.list': 'deny' }))).toMatchObject({ effect: 'read', enabled: false });
    expect(resolveBytedcliOperationRule('codebase.mr.list', undefined, policy({ 'codebase.mr.list': 'actor' })))
      .toMatchObject({ effect: 'read', enabled: true, identity: 'actor' });
  });

  it('aliases resolve to the same canonical business ID and rule', () => {
    const operation = parseBytedcliOperation(['codebase', 'pr', 'edit', '42', '--repo', 'org/repo', '--title', 'new']);
    expect(operation).toMatchObject({ id: 'codebase.mr.update', effect: 'write', cliVersion: '0.199.0' });
    expect(resolveBytedcliOperationRule(operation.id, undefined, policy({ 'codebase.mr.update': 'deny' })))
      .toMatchObject({ operationId: 'codebase.mr.update', effect: 'write', enabled: false, identity: 'actor' });
    const metadata = BYTEDCLI_OPERATION_CATALOG.find(entry => entry.id === operation.id)!;
    expect(metadata.aliases).toContainEqual(['codebase', 'pr', 'edit']);
    expect(Object.isFrozen(metadata.aliases[0])).toBe(true);
    expect(() => { (metadata.path as string[])[0] = 'auth'; }).toThrow();
    const flags = BYTEDCLI_OPERATION_GRAMMAR.entries.find(entry => entry.id === operation.id)!.flags;
    expect(Object.isFrozen(flags[0])).toBe(true);
    expect(() => { (flags[0] as { validator: string }).validator = 'json'; }).toThrow();
  });

  it.each([
    { field: 'effect', valid: 'write' },
    { field: 'arity', valid: 'value' },
    { field: 'positional', valid: 'repo' },
  ])('refuses catalog import when $field is a non-string enum shape', async ({ field, valid }) => {
    for (const malformed of [[valid], [[valid]], null, true, 42, {}]) {
      const fixture = JSON.parse(JSON.stringify(BYTEDCLI_OPERATION_GRAMMAR));
      if (field === 'arity') fixture.entries[0].flags[0].arity = malformed;
      else fixture.entries[0][field] = malformed;
      const bundled = await build({ stdin: { contents: `export * from './src/core/bytedcli-operation-catalog.js';`,
        resolveDir: resolve(import.meta.dirname, '..') }, bundle: true, platform: 'browser', format: 'iife',
        globalName: 'Catalog', write: false, plugins: [{ name: 'malformed-packaged-catalog', setup(plugin) {
          plugin.onLoad({ filter: /bytedcli-operation-catalog\.json$/ }, () => ({ contents: JSON.stringify(fixture), loader: 'json' }));
        } }] });
      expect(() => runInNewContext(bundled.outputFiles[0].text, {}))
        .toThrow('Invalid packaged bytedcli operation catalog');
    }
  });

  it('bundles catalog and policy for the browser and resolves rules without Node globals', async () => {
    const bundled = await build({ stdin: { contents: `
      export * from './src/core/bytedcli-operation-catalog.js';
      export * from './src/core/bytedcli-operation-policy-config.js';
    `, resolveDir: resolve(import.meta.dirname, '..') }, bundle: true, platform: 'browser', format: 'iife',
      globalName: 'Policy', write: false });
    const result = runInNewContext(`${bundled.outputFiles[0].text}
      const policy = Policy.parseBytedcliOperationPolicy({schema:'botmux.bytedcli-operation-policy.v1',
        cliVersion:'0.199.0',catalogVersion:'2026-11-26.1',rules:{'codebase.mr.list':'actor'}});
      JSON.stringify({result:Policy.resolveBytedcliOperationRule('codebase.mr.list',policy),
        catalogFrozen:Object.isFrozen(Policy.BYTEDCLI_OPERATION_CATALOG),buffer:typeof Buffer,process:typeof process});
    `, {});
    expect(JSON.parse(result)).toEqual({ result: { operationId: 'codebase.mr.list', effect: 'read', enabled: true, identity: 'actor' },
      catalogFrozen: true, buffer: 'undefined', process: 'undefined' });
  });
});
