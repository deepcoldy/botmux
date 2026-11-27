import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBunExecutable, spawnSyncTsScript } from './helpers/ts-runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function privateRoot(): string {
  const root = mkdtempSync(join(process.env.HOME!, 'bytedcli-embedded-')); roots.push(root); return root;
}
it('the strict asset gate accounts for the packaged catalog and still refuses an unrelated JSON asset', () => {
  const root = privateRoot();
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'dist', 'core'), { recursive: true });
  cpSync(resolve('scripts/audit-embedded-assets.mjs'), join(root, 'scripts', 'audit-embedded-assets.mjs'));
  cpSync(resolve('src/core/bytedcli-operation-catalog.json'), join(root, 'dist', 'core', 'bytedcli-operation-catalog.json'));
  // The strict asset inventory retains its existing runtime-ID exemption.
  writeFileSync(join(root, 'dist', '.runtime-build-id'), 'private-fixture');
  const audit = () => spawnSyncTsScript(join(root, 'scripts', 'audit-embedded-assets.mjs'), ['--require-dist'],
    { cwd: resolve('.'), env: process.env, encoding: 'utf8', timeout: 30_000 });
  const accepted = audit();
  expect(accepted.error).toBeUndefined();
  expect(accepted.status, String(accepted.stdout) + String(accepted.stderr)).toBe(0);
  writeFileSync(join(root, 'dist', 'core', 'unreviewed.json'), '{}');
  const refused = audit(); expect(refused.status).toBe(1); expect(String(refused.stderr)).toContain('core/unreviewed.json');
});
it('compiled actual catalog, configuration and parser execute after every source and JSON fixture is removed', () => {
  const root = privateRoot();
  // 非文本断言：将真实模块复制进私有编译夹具，删除它们后验证实际二进制结果；不钉源码文本。
  for (const rel of ['core/bytedcli-operation-catalog.ts', 'core/bytedcli-operation-catalog.json',
    'core/bytedcli-business-command-catalog.ts', 'core/bytedcli-fallback-operation.ts',
    'core/bytedcli-operation-policy-config.ts', 'core/bytedcli-operation-policy.ts', 'cli/bytedcli-exec-protocol.ts']) {
    const target = join(root, 'src', rel); mkdirSync(resolve(target, '..'), { recursive: true }); cpSync(resolve('src', rel), target);
  }
  const entry = join(root, 'test', 'fixtures', 'bytedcli-catalog-compiled', 'entry.ts');
  mkdirSync(resolve(entry, '..'), { recursive: true }); cpSync(resolve('test/fixtures/bytedcli-catalog-compiled/entry.ts'), entry);
  const binary = join(root, 'compiled-catalog'), bun = resolveBunExecutable();
  expect(bun).toBeDefined();
  const built = spawnSync(bun!, ['build', '--compile', '--minify', entry, '--outfile', binary],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 60_000 });
  expect(built.error).toBeUndefined(); expect(built.status, built.stdout + built.stderr).toBe(0);
  rmSync(join(root, 'src'), { recursive: true }); rmSync(join(root, 'test'), { recursive: true });
  expect(existsSync(join(root, 'src'))).toBe(false); expect(existsSync(entry)).toBe(false);
  const executed = spawnSync(binary, [], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000 });
  expect(executed.error).toBeUndefined(); expect(executed.status, executed.stdout + executed.stderr).toBe(0);
  const output = JSON.parse(executed.stdout);
  expect(output.catalogEntries).toBeGreaterThan(18);
  expect(output).toMatchObject({
    cliVersion: '0.199.0', catalogVersion: '2026-11-27.1', frozenCatalog: true,
    read: { id: 'codebase.mr.get', effect: 'read', argv: ['--json', '--site', 'cn', 'codebase', 'mr', 'get', '42', '--repo', 'team/service'] },
    write: { id: 'codebase.mr.close', effect: 'write' },
    effectiveRead: { operationId: 'codebase.mr.get', effect: 'read', enabled: true, identity: 'actor' },
    effectiveWrite: { operationId: 'codebase.mr.close', effect: 'write', enabled: false, identity: 'actor' },
    invalidWriteRefused: true, unknown: { effect: 'unknown', execution: 'isolated-native', identity: 'actor' },
    debug: { id: 'api-test.rpc-call.picko-size', effect: 'read', execution: 'isolated-native' }, badDebugRefused: true,
  });
}, 90_000);
