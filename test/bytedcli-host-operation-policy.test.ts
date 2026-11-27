import './helpers/require-fenced-data-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBytedcliHostOperationPolicyReader } from '../src/core/bytedcli-host-operation-policy.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const hooks = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: (...args: Parameters<typeof fs.readSync>) => { const count = (actual.readSync as any)(...args); hooks.afterRead?.(); return count; } };
});

const roots: string[] = [];
afterEach(() => { hooks.afterRead = undefined; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const config = (rules = {}) => ({ schema: 'botmux.bytedcli-operation-policy.v1', cliVersion: '0.199.0', catalogVersion: '2026-11-26.1', rules });
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'bytedcli-host-policy-')); roots.push(root);
  const reader = createBytedcliHostOperationPolicyReader(root);
  return { root, reader, directory: join(root, 'policy'), file: join(root, 'policy', 'operation-policy.json') };
}
describe('fixed private host policy', () => {
  it('refuses a relative host root promptly without traversing or creating it', () => {
    const module = new URL('../src/core/bytedcli-host-operation-policy.ts', import.meta.url).href;
    const child = spawnSyncTsEvalWithRepoImports(`import {createBytedcliHostOperationPolicyReader} from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(createBytedcliHostOperationPolicyReader('relative')()));`, { timeout: 1500, encoding: 'utf8' });
    expect(child.status, String(child.stderr)).toBe(0);
    expect(JSON.parse(String(child.stdout))).toMatchObject({ errorCode: 'operation_policy_invalid' });
  });
  it('creates only on invocation and detects missing → created → deleted revisions independently of request files', () => {
    const s = setup(); expect(fs.readdirSync(s.root)).toEqual([]);
    const before = s.reader(); expect(before.errorCode).toBeUndefined(); expect(before.policy).toBeUndefined();
    fs.mkdirSync(join(s.root, 'request-fake'), { mode: 0o700 }); expect(s.reader().revision).toBe(before.revision);
    fs.writeFileSync(s.file, JSON.stringify(config({ 'codebase.mr.list': 'actor' })), { mode: 0o600 });
    const created = s.reader(); expect(created.policy?.rules['codebase.mr.list']).toBe('actor'); expect(created.revision).not.toBe(before.revision);
    fs.unlinkSync(s.file); expect(s.reader().revision).not.toBe(before.revision); expect(s.reader().revision).not.toBe(created.revision);
    expect(Object.isFrozen(created)).toBe(true); expect(Object.isFrozen(created.policy?.rules)).toBe(true);
    expect(Buffer.byteLength(created.revision)).toBeLessThanOrEqual(256);
  });
  it.each([['null','null'], ['array','[]'], ['boolean','true'], ['wrong-schema','{}'], ['partial','{'],
    ['oversized-valid-JSON',JSON.stringify(config()) + ' '.repeat(32769)], ['bad-json','\ufffd']])('refuses present invalid JSON without a last-good fallback (%s)', (_label, raw) => {
    const s = setup(); s.reader(); fs.writeFileSync(s.file, JSON.stringify(config()), { mode: 0o600 }); const good = s.reader();
    fs.writeFileSync(s.file, raw); expect(s.reader()).toMatchObject({ errorCode: 'operation_policy_invalid' }); expect(s.reader().policy).toBeUndefined();
    fs.writeFileSync(s.file, JSON.stringify(config({ 'codebase.mr.close': 'deny' })));
    expect(s.reader().policy?.rules['codebase.mr.close']).toBe('deny'); expect(s.reader().revision).not.toBe(good.revision);
  });
  it.each(['file-mode', 'directory-mode', 'root-mode', 'symlink', 'hardlink', 'directory', 'parent-symlink'])('refuses unsafe %s without repairing it', kind => {
    const s = setup(); s.reader(); fs.writeFileSync(s.file, JSON.stringify(config()), { mode: 0o600 });
    if (kind === 'file-mode') fs.chmodSync(s.file, 0o644);
    if (kind === 'directory-mode') fs.chmodSync(s.directory, 0o755);
    if (kind === 'root-mode') fs.chmodSync(s.root, 0o755);
    if (kind === 'hardlink') fs.linkSync(s.file, join(s.root, 'alias'));
    if (kind === 'symlink' || kind === 'directory') { fs.unlinkSync(s.file); kind === 'symlink' ? fs.symlinkSync(join(s.root, 'outside'), s.file) : fs.mkdirSync(s.file); }
    if (kind === 'parent-symlink') { fs.renameSync(s.directory, join(s.root, 'outside')); fs.symlinkSync(join(s.root, 'outside'), s.directory); }
    expect(s.reader().errorCode).toBe('operation_policy_invalid'); expect(s.reader().policy).toBeUndefined();
  });
  it('refuses invalid UTF-8 rather than decoding with replacement', () => {
    const s = setup(); s.reader(); fs.writeFileSync(s.file, Buffer.from([0xff]), { mode: 0o600 });
    expect(s.reader().errorCode).toBe('operation_policy_invalid');
  });
  it('refuses an atomic replacement during the bounded read', () => {
    const s = setup(); s.reader(); fs.writeFileSync(s.file, JSON.stringify(config()), { mode: 0o600 });
    let replaced = false;
    hooks.afterRead = () => {
      if (!replaced) { replaced = true; fs.writeFileSync(join(s.directory, 'next'), JSON.stringify(config({ 'codebase.mr.close': 'deny' })), { mode: 0o600 }); fs.renameSync(join(s.directory, 'next'), s.file); }
    };
    expect(s.reader().errorCode).toBe('operation_policy_invalid');
  });
  it('keeps valid policy current when request directories churn during its read', () => {
    const s = setup(); s.reader(); fs.writeFileSync(s.file, JSON.stringify(config({ 'codebase.mr.list':'actor' })), { mode:0o600 });
    const before = s.reader();
    hooks.afterRead = () => { const request = fs.mkdtempSync(join(s.root,'request-')); fs.rmSync(request,{recursive:true,force:true}); };
    const after=s.reader();expect(after.errorCode).toBeUndefined();expect(after.policy?.rules['codebase.mr.list']).toBe('actor');expect(after.revision).toBe(before.revision);
  });
});
