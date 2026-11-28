import { afterEach, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { readPluginRegistry } from '../src/services/plugin-registry-store.js';
import { scanPluginContributions } from '../src/core/plugins/convention-scanner.js';
import { parsePluginBytedcliOperationPresets, readPluginBytedcliOperationPresets, selectPluginBytedcliOperationPreset } from '../src/core/plugins/bytedcli-operation-presets.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const policy = (rules: Record<string, string> = { 'codebase.mr.close': 'machine', 'codebase.mr.list': 'actor' }) => ({
  schema: 'botmux.bytedcli-operation-policy.v2', cliVersion: '0.199.0', catalogVersion: '2026-11-27.2', rules,
});
const declaration = (presets: unknown[] = [{ id: 'support', title: 'Support policy', description: 'Reviewed command identities', policy: policy() }]) => ({ schema: 'botmux.bytedcli-operation-presets.v1', presets });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'plugin-command-presets-')); roots.push(home); vi.stubEnv('HOME', home);
  const source = join(home, 'source'), runtime = join(source, 'dist'); mkdirSync(join(runtime, 'bytedcli'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'botmux-plugin-support', version: '1.0.0', keywords: ['botmux-plugin'], botmux: { id: 'support' } }));
  const file = join(runtime, 'bytedcli', 'operation-presets.json'); writeFileSync(file, JSON.stringify(declaration()));
  return { home, source, runtime, file };
}
it('installs declarative operation presets without requiring executable plugin contributions', () => {
  const s = fixture();
  expect(scanPluginContributions(s.runtime, { schemaVersion: 1, id: 'support' })?.bytedcliOperationPresets).toEqual(declaration());
  const installed = installLocalPlugin(s.source);
  expect(installed.record.contributions?.bytedcliOperationPresets).toEqual(declaration());
  expect(readPluginRegistry().plugins.support?.contributions?.bytedcliOperationPresets).toEqual(declaration());
});
it('rejects an invalid update before replacing the installed preset or runtime', () => {
  const s = fixture(); installLocalPlugin(s.source);
  const before = readPluginRegistry().plugins.support;
  writeFileSync(s.file, JSON.stringify(declaration([{ id: 'support', title: 'Unsafe', policy: policy({ ['unknown.' + 'a'.repeat(64)]: 'machine' }) }])));
  expect(() => installLocalPlugin(s.source)).toThrow();
  expect(readPluginRegistry().plugins.support).toEqual(before);
  expect(JSON.parse(readFileSync(join(s.home, '.botmux/plugins/support/dist/bytedcli/operation-presets.json'), 'utf8'))).toEqual(declaration());
});
it.each([
  { ...declaration(), token: 'private-token' },
  declaration([{ id: 'support', title: 'Support', policy: policy(), token: 'private-token' }]),
  declaration([{ id: 'support', title: 'Support', policy: null }]),
  declaration([{ id: 'support', title: 'Support', policy: { ...policy(), cliVersion: 'latest' } }]),
  declaration([{ id: 'support', title: 'Support', policy: policy({ 'opaque-command': 'machine' }) }]),
  declaration(Array.from({ length: 2 }, () => ({ id: 'support', title: 'Support', policy: policy() }))),
  declaration([{ id: '../escape', title: 'Support', policy: policy() }]),
  declaration([{ id: 'support', title: 'x'.repeat(129), policy: policy() }]),
  declaration([{ id: 'support', title: 'Support', description: 'x'.repeat(513), policy: policy() }]),
  declaration([{ id: 'support', title: 'Support\nsecret', policy: policy() }]),
  declaration(Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, title: 'Support', policy: policy() }))),
])('refuses malformed declarations without accepting credential or executable extensions (%#)', raw => {
  expect(() => parsePluginBytedcliOperationPresets(raw)).toThrow('invalid_plugin_bytedcli_operation_presets');
});
it.each(['oversized', 'symlink', 'hardlink', 'bad-json'])('refuses unsafe fixed contribution files (%s)', kind => {
  const s = fixture();
  if (kind === 'oversized') writeFileSync(s.file, JSON.stringify(declaration()) + ' '.repeat(256 * 1024));
  if (kind === 'bad-json') writeFileSync(s.file, '{');
  if (kind === 'symlink') { const target = join(s.home, 'outside.json'); writeFileSync(target, JSON.stringify(declaration())); rmSync(s.file); symlinkSync(target, s.file); }
  if (kind === 'hardlink') linkSync(s.file, join(s.home, 'outside.json'));
  expect(() => scanPluginContributions(s.runtime, { schemaVersion: 1, id: 'support' })).toThrow();
});
it('discovers only effective installed plugins and validates references against current source content', () => {
  const s = fixture(); installLocalPlugin(s.source);
  expect(readPluginBytedcliOperationPresets({}, {}).presets).toEqual([]);
  const snapshot = readPluginBytedcliOperationPresets({ plugins: ['support'] }, {});
  expect(snapshot.issues).toEqual([]); expect(snapshot.presets).toHaveLength(1);
  const row = snapshot.presets[0]!;
  expect(row).toMatchObject({ pluginId: 'support', id: 'support', pluginVersion: '1.0.0', machineWriteExceptions: ['codebase.mr.close'] });
  const ref = { pluginId: row.pluginId, presetId: row.id, revision: row.revision };
  expect(selectPluginBytedcliOperationPreset(snapshot, ref).policy.rules['codebase.mr.close']).toBe('machine');
  expect(() => selectPluginBytedcliOperationPreset(readPluginBytedcliOperationPresets({}, {}), ref)).toThrow('bytedcli_operation_preset_unavailable');
  const registry = readPluginRegistry();
  registry.plugins.support!.contributions!.bytedcliOperationPresets = parsePluginBytedcliOperationPresets(declaration([{ id: 'support', title: 'Updated', policy: policy({ 'codebase.mr.close': 'actor' }) }]));
  const changed = readPluginBytedcliOperationPresets({ plugins: ['support'] }, {}, registry);
  expect(() => selectPluginBytedcliOperationPreset(changed, ref)).toThrow('bytedcli_operation_preset_changed');
  expect(() => selectPluginBytedcliOperationPreset(snapshot, { ...ref, policy: policy() })).toThrow('invalid_bytedcli_operation_preset_reference');
  expect(Object.isFrozen(row.policy.rules)).toBe(true);
});
it('namespaces identical preset IDs and isolates corrupted metadata without exposing its raw values', () => {
  const s = fixture(); installLocalPlugin(s.source); const registry = readPluginRegistry(); const original = registry.plugins.support!;
  registry.plugins.second = { ...original, id: 'second', manifest: { schemaVersion: 1, id: 'second' } };
  const both = readPluginBytedcliOperationPresets({ plugins: ['support'] }, { plugins: ['second'] }, registry);
  expect(both.presets.map(row => [row.pluginId, row.id])).toEqual([['second', 'support'], ['support', 'support']]);
  registry.plugins.second.contributions = { bytedcliOperationPresets: { ...declaration(), token: 'private-token' } as any };
  const corrupted = readPluginBytedcliOperationPresets({ plugins: ['support', 'second', 'uninstalled'] }, {}, registry);
  expect(corrupted.presets.map(row => row.pluginId)).toEqual(['support']);
  expect(corrupted.issues).toEqual([{ pluginId: 'second', code: 'invalid_contribution' }, { pluginId: 'uninstalled', code: 'plugin_not_installed' }]);
  expect(JSON.stringify(corrupted)).not.toContain('private-token');
});
it('bounds the combined discovery response without partially publishing a plugin contribution', () => {
  const s = fixture(); installLocalPlugin(s.source); const registry = readPluginRegistry(), original = registry.plugins.support!;
  for (let i = 0; i < 65; i++) { const id = 'plugin-' + i; registry.plugins[id] = { ...original, id, manifest: { schemaVersion: 1, id } }; }
  const snapshot = readPluginBytedcliOperationPresets({ plugins: Array.from({ length: 65 }, (_, i) => 'plugin-' + i) }, {}, registry);
  expect(snapshot.presets).toHaveLength(64); expect(snapshot.issues).toEqual([{ pluginId: 'plugin-64', code: 'too_many_presets' }]);
});
