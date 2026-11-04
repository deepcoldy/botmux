import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDoasTokenSource } from '../src/services/feedback-doas-token.js';
import { spawnTsScript } from './helpers/ts-runner.js';
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
    expect(await readFile(join(source.directory, 'generation.json'), 'utf8')).not.toContain('token');
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
    await expect(source.get()).rejects.toThrow('feedback_doas_refresh_failed');
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
