import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, realpath, access, chmod, chown, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDoasTokenSource } from '../src/services/feedback-doas-token.js';
import { spawnTsScript, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { once } from 'node:events';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'feedback-doas-')); directories.push(root);
  const executable = join(root, 'doas');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const base = path.dirname(process.env.TMPDIR);
fs.appendFileSync(path.join(base, 'invocations'), JSON.stringify({args,tmp:process.env.TMPDIR,identity:process.env.DOAS_IDENTITY_DIR})+'\\n');
const marker = path.join(base, 'cleaned');
if (args.at(-1) === 'clean') { fs.writeFileSync(marker, 'yes'); process.exit(0); }
process.stdout.write(fs.existsSync(marker) ? 'new-token\\n' : 'old-token\\n');
`, { mode: 0o700 });
  return { root, executable, config: { psm: 'data.example.service', environment: 'boe' } };
}
describe('isolated doas token source', () => {
  it('uses an unexpired short-lived credential without caching it beyond its safety margin', async () => {
    const { root, executable, config } = await fixture();
    const now = Date.now();
    const token = `header.${Buffer.from(JSON.stringify({ expireTime: Math.floor(now / 1000) + 20 })).toString('base64url')}.signature`;
    await writeFile(executable, `#!/bin/sh\nprintf '%s' '${token}'\n`, { mode: 0o700 });
    const source = createDoasTokenSource(root, config, executable);
    expect((await source.get()).value).toBe(token);
    await writeFile(executable, "#!/bin/sh\nprintf '%s' 'replacement-token'\n", { mode: 0o700 });
    expect((await source.get()).value).toBe('replacement-token');
  });
  it('fails closed when generation metadata disappears after an existing credential was cached', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    await source.get();
    await unlink(join(source.directory, 'generation.json'));
    await expect(source.get()).rejects.toThrow('feedback_doas_state_invalid');
  });
  it('renews a shared credential after its bounded cache lifetime', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    const initial = await source.get();
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    try {
      clock.mockReturnValue(now + 61000);
      expect(await createDoasTokenSource(root, config, executable).get()).toEqual(initial);
      const calls = (await readFile(join(source.directory, 'invocations'), 'utf8')).trim().split('\n');
      expect(calls).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });
  it('bounds cache reuse by the token expiry and rejects an already-expired result', async () => {
    const { root, executable, config } = await fixture();
    const now = Date.now();
    const token = `header.${Buffer.from(JSON.stringify({ expireTime: Math.floor(now / 1000) + 35 })).toString('base64url')}.signature`;
    await writeFile(executable, `#!/bin/sh\nprintf '%s' '${token}'\n`, { mode: 0o700 });
    const source = createDoasTokenSource(root, config, executable);
    await source.get();
    const shared = JSON.parse(await readFile(join(source.directory, 'credential.json'), 'utf8'));
    expect(shared.validUntil).toBeLessThanOrEqual(now + 5000);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 36000);
    try { await expect(createDoasTokenSource(root, config, executable).get()).rejects.toThrow('feedback_doas_token_expired'); }
    finally { clock.mockRestore(); }
  });
  it('refuses a redirected or publicly readable shared credential', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    await source.get();
    const credential = join(source.directory, 'credential.json');
    await chmod(credential, 0o644);
    await expect(createDoasTokenSource(root, config, executable).get()).rejects.toThrow('feedback_doas_cache_unsafe');
    await chmod(credential, 0o600);
    const outside = join(root, 'outside-token');
    await writeFile(outside, await readFile(credential), { mode: 0o600 });
    await unlink(credential);
    await symlink(outside, credential);
    await expect(createDoasTokenSource(root, config, executable).get()).rejects.toThrow('feedback_doas_cache_unsafe');
  });
  it('shares a usable credential across alternating source instances without minting new tokens', async () => {
    const { root, executable, config } = await fixture();
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const base=path.dirname(process.env.TMPDIR), counter=path.join(base,'token-counter');
const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;
fs.writeFileSync(counter,String(count+1));
process.stdout.write('token-'+String(count+1));
`, { mode: 0o700 });
    const first = createDoasTokenSource(root, config, executable);
    const second = createDoasTokenSource(root, config, executable);
    const initial = await first.get();
    expect(await second.get()).toEqual(initial);
    expect(await first.get()).toEqual(initial);
    expect(await second.get()).toEqual(initial);
    expect(await readFile(join(first.directory, 'token-counter'), 'utf8')).toBe('1');
    expect((await stat(join(first.directory, 'credential.json'))).mode & 0o777).toBe(0o600);
  });
  it('coalesces initial reads and cleans once for concurrent failures of the same generation', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    const initial = await Promise.all([source.get(), source.get(), source.get()]);
    expect(initial.map(value => value.value)).toEqual(['old-token', 'old-token', 'old-token']);
    const refreshed = await Promise.all([source.refresh(initial[0].generation), source.refresh(initial[0].generation)]);
    expect(refreshed.map(value => value.value)).toEqual(['new-token', 'new-token']);
    const calls = (await readFile(join(source.directory, 'invocations'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.args.at(-1) === 'clean')).toHaveLength(1);
    expect(calls).toHaveLength(3);
    const canonical = await realpath(source.directory);
    expect(calls.every(call => call.tmp === join(canonical, 'tmp'))).toBe(true);
    expect(calls.every(call => call.identity === join(canonical, 'identity'))).toBe(true);
    expect(calls[0].args).toEqual(['--type', 'gdpr', '-p', 'data.example.service', '--print-env', '-e', 'boe', '--no-interaction', '--identity-dir', join(canonical, 'identity')]);
    expect((await stat(source.directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(source.directory, 'generation.json'), 'utf8')).not.toContain('new-token');
  });
  it('does not clean twice when another source instance already refreshed', async () => {
    const { root, executable, config } = await fixture();
    const first = createDoasTokenSource(root, config, executable);
    const second = createDoasTokenSource(root, config, executable);
    const old = await first.get();
    await second.get();
    await first.refresh(old.generation);
    expect((await second.refresh(old.generation)).value).toBe('new-token');
    const calls = (await readFile(join(first.directory, 'invocations'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.args.at(-1) === 'clean')).toHaveLength(1);
  });
  it('rejects a redirected cache root instead of cleaning outside the private directory', async () => {
    const { root, executable, config } = await fixture();
    const outside = join(root, 'outside'); await mkdir(outside);
    await symlink(outside, join(root, 'feedback-doas'));
    await expect(createDoasTokenSource(root, config, executable).get()).rejects.toThrow('feedback_doas_cache_unsafe');
  });
  it('rejects a cache root whose mode grants access to group or others', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    await source.get();
    try {
      for (const mode of [0o755, 0o777, 0o705]) {
        await chmod(source.directory, mode);
        await expect(createDoasTokenSource(root, config, executable).get()).rejects.toThrow('feedback_doas_cache_unsafe');
      }
    } finally { await chmod(source.directory, 0o700); }
  });
  it('rejects a cache root owned by another user even with 0700 mode', async () => {
    // Foreign ownership can only be staged by a privileged runner; unprivileged
    // environments cannot create it, so the case is a no-op there rather than
    // a fake failure. The mode-bits case above is the reachable branch on a
    // shared host running as the daemon user.
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    await source.get();
    await chown(source.directory, 65534, 65534);
    try {
      await expect(createDoasTokenSource(root, config, executable).get()).rejects.toThrow('feedback_doas_cache_unsafe');
    } finally { await chown(source.directory, 0, 0); }
  });
  it.each([
    '{',
    '{"generation":1}',
    '{"generation":"1","unusable":false}',
    '{"generation":-1,"unusable":false}',
    '{"generation":1,"unusable":"yes"}',
    '{"generation":1,"unusable":false,"rejectedHash":"zz"}',
    '{"generation":1,"unusable":false,"tokenHash":"tooshort"}',
  ])('rejects a malformed generation state (%s) instead of guessing a generation', async corrupted => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    await source.get();
    await writeFile(join(source.directory, 'generation.json'), corrupted, 'utf8');
    await expect(createDoasTokenSource(root, config, executable).get()).rejects.toThrow('feedback_doas_state_invalid');
  });
  it('suppresses command stderr and fails closed on malformed output', async () => {
    const { root, executable, config } = await fixture();
    await writeFile(executable, '#!/bin/sh\nprintf "secret-value\\n" >&2\nprintf "export SEC_TOKEN_STRING=secret-value\\n"\n', { mode: 0o700 });
    let error: unknown;
    try { await createDoasTokenSource(root, config, executable).get(); } catch (caught) { error = caught; }
    expect(String(error)).toContain('feedback_doas_output_invalid');
    expect(String(error)).not.toContain('secret-value');
  });
  it('does not reuse rejected tokens when cleaning or fetching fails', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    const old = await source.get();
    await writeFile(executable, '#!/bin/sh\nprintf "do-not-log-secret" >&2\nexit 1\n', { mode: 0o700 });
    await expect(source.refresh(old.generation)).rejects.toThrow('feedback_doas_command_failed');
    await expect(source.get()).rejects.toThrow('feedback_doas_command_failed');
  });
  it('recovers after a failed fetch without repeating cleanup for stale failures', async () => {
    const { root, executable, config } = await fixture();
    const original = await readFile(executable, 'utf8');
    const source = createDoasTokenSource(root, config, executable);
    const old = await source.get();
    await writeFile(executable, original.replace("process.stdout.write(", "process.exit(1); process.stdout.write("));
    await expect(source.refresh(old.generation)).rejects.toThrow();
    await writeFile(executable, original);
    const restarted = createDoasTokenSource(root, config, executable);
    expect((await restarted.get()).value).toBe('new-token');
    expect((await source.refresh(old.generation)).value).toBe('new-token');
    const calls = (await readFile(join(source.directory, 'invocations'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.args.at(-1) === 'clean')).toHaveLength(1);
  });
  it('does not repeat a failed clean for a rejected generation', async () => {
    const { root, executable, config } = await fixture();
    const original = await readFile(executable, 'utf8');
    const source = createDoasTokenSource(root, config, executable);
    const old = await source.get();
    await writeFile(executable, original.replace("fs.writeFileSync(marker, 'yes');", "process.exit(1);"));
    await expect(source.refresh(old.generation)).rejects.toThrow();
    await createDoasTokenSource(root, config, executable).refresh(old.generation).catch(() => {});
    const calls = (await readFile(join(source.directory, 'invocations'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.args.at(-1) === 'clean')).toHaveLength(1);
  });
  it('assigns a new generation when doas returns a different token to another process', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    const first = await source.get();
    await writeFile(join(source.directory, 'cleaned'), 'yes');
    await unlink(join(source.directory, 'credential.json'));
    const second = await createDoasTokenSource(root, config, executable).get();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect((await source.refresh(first.generation)).value).toBe('new-token');
    const calls = (await readFile(join(source.directory, 'invocations'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.args.at(-1) === 'clean')).toHaveLength(0);
  });
  it('keeps cache commands serialized when their caller is killed', async () => {
    const { root, executable, config } = await fixture();
    const original = await readFile(executable, 'utf8');
    const started = join(root, 'started');
    const release = join(root, 'release');
    const active = join(root, 'active');
    const overlap = join(root, 'overlap');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const active = ${JSON.stringify(active)};
if (fs.existsSync(active)) fs.writeFileSync(${JSON.stringify(overlap)}, 'yes');
fs.writeFileSync(active, 'yes');
fs.writeFileSync(${JSON.stringify(started)}, 'yes');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    clearInterval(timer);
    if (fs.existsSync(active)) fs.unlinkSync(active);
    process.stdout.write('old-token');
  }
}, 10);
`, { mode: 0o700 });
    const child = spawnTsEvalWithRepoImports(`
import { createDoasTokenSource } from './src/services/feedback-doas-token.js';
await createDoasTokenSource(${JSON.stringify(root)}, ${JSON.stringify(config)}, ${JSON.stringify(executable)}).get();
`, { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      const deadline = Date.now() + 5000;
      while (!(await access(started).then(() => true, () => false))) {
        if (Date.now() > deadline) throw new Error('credential command did not start');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const next = createDoasTokenSource(root, config, executable).get();
      await new Promise(resolve => setTimeout(resolve, 500));
      await writeFile(release, 'yes');
      await next;
      expect(await access(overlap).then(() => true, () => false)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await writeFile(release, 'yes');
      await writeFile(executable, original);
    }
  });
  it('serializes refresh across independent processes sharing the source', async () => {
    const { root, executable, config } = await fixture();
    const source = createDoasTokenSource(root, config, executable);
    const old = await source.get();
    const children = [1, 2].map(() => spawnTsScript('test/helpers/feedback-doas-child.ts', [root, executable, String(old.generation)], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const statuses = await Promise.all(children.map(child => once(child, 'exit')));
    expect(statuses.map(([code]) => code)).toEqual([0, 0]);
    const calls = (await readFile(join(source.directory, 'invocations'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.args.at(-1) === 'clean')).toHaveLength(1);
    expect((await source.get()).value).toBe('new-token');
  });
});
