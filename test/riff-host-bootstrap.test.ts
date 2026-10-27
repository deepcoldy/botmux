import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiffBackend, isValidRiffHostToolsUrl } from '../src/adapters/backend/riff-backend.js';
import type { RiffHostBinding } from '../src/services/riff-host-tools.js';
import { logger } from '../src/utils/logger.js';

vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const roots: string[] = [];
const backends: RiffBackend[] = [];
afterEach(() => {
  for (const backend of backends.splice(0)) backend.kill();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function backend(binding: () => RiffHostBinding | undefined) {
  const requests: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api2/task-stream')) return new Response(new ReadableStream({ start() {} }));
    if (init?.body) requests.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ success: true, data: { id: `task-${requests.length}`, task: {} } });
  }));
  const instance = new RiffBackend({ baseUrl: 'https://riff.example', jwt: 'test-jwt',
    hostToolsBinding: binding, env: { BOTMUX_RIFF_HOST_TOOLS: '1' }, injectStatusLines: false }, 'session-1');
  backends.push(instance);
  return { instance, requests };
}

describe('Riff host-tools preflight', () => {
  it.each([
    'http://localhost:8801/api/riff-host-tools',
    'https://host/s/{sessionId}/api/riff-host-tools',
    'http://[2001:db8::1]:18886/s/{sessionId}/api/riff-host-tools',
    'https://host/$literal`value`/api/riff-host-tools',
  ])('accepts endpoint %s', value => expect(isValidRiffHostToolsUrl(value)).toBe(true));
  it.each([undefined, null, 42, '', ' ', 'not a url', 'file:///api/riff-host-tools',
    'https://user:secret@host/api/riff-host-tools', 'https://host/other',
    'https://host/api/riff-host-tools?token=secret', 'https://host/api/riff-host-tools?',
    'https://host/api/riff-host-tools#', 'https://host/api/riff-host-tools#fragment',
    "http://host/a'b/api/riff-host-tools", 'http://host/a"b/api/riff-host-tools',
    'http://host/a\nb/api/riff-host-tools', 'http://host/a\tb/api/riff-host-tools',
    'http://host/a\0b/api/riff-host-tools', 'http://host/a\\b/api/riff-host-tools',
  ])('rejects unsafe endpoint %#', value => expect(isValidRiffHostToolsUrl(value)).toBe(false));

  it.each(['ENOTDIR', 'EEXIST', 'ENOSPC', 'invalid URL'])('still delivers initial and follow-up messages when binding throws: %s', async reason => {
    const warning = vi.spyOn(logger, 'warn'); warning.mockClear();
    const { instance, requests } = backend(() => {
      if (reason === 'invalid URL') new URL('private-token-must-not-leak');
      throw Object.assign(new Error(`${reason}: private-token-must-not-leak`), { code: reason });
    });
    for (const message of ['first request', 'follow-up request']) {
      expect(instance.write(message)).toBe(true);
      await (instance as any).writeChain;
    }
    const initial = requests.find(r => r.url.endsWith('/api/task-execute'))!.body;
    const followUp = requests.find(r => r.url.endsWith('/api/task-follow-up'))!.body;
    expect(initial.config.userPrompt).toContain('first request');
    expect(followUp.prompt).toContain('follow-up request');
    for (const prompt of [initial.config.userPrompt, followUp.prompt]) {
      expect(prompt).not.toContain('<botmux_host_tools>');
      expect(prompt).not.toContain('botmux riff-host-bind');
      expect(prompt).not.toContain('private-token-must-not-leak');
    }
    expect(initial.config.env.BOTMUX_RIFF_HOST_TOOLS).toBe('1');
    expect(initial.config.env.BOTMUX_LARK_APP_SECRET).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-token-must-not-leak');
  });
});

describe('Riff verified CLI bootstrap shell boundary', () => {
  it.each(['literal', 'quotes and substitutions', 'control characters', 'checksum injection'])('runs generated bootstrap safely: %s', async variant => {
    const root = mkdtempSync(join(tmpdir(), 'riff-bootstrap-')); roots.push(root);
    const bin = join(root, 'bin'); mkdirSync(bin);
    const artifact = '#!/bin/sh\nprintf "%s\\0" "$BOTMUX_RIFF_HOST_TOOLS" "$@" > "$BOUND_ARGS"\n';
    writeFileSync(join(root, 'artifact'), artifact);
    writeFileSync(join(bin, 'botmux'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    const digest = createHash('sha256').update(artifact).digest('hex');
    const hostile = variant === 'quotes and substitutions' ? "a'; touch \"$PWNED\"; #$(touch \"$PWNED\")`touch \"$PWNED\"`"
      : variant === 'control characters' ? 'a\nb\tc\r' : 'literal';
    const binding: RiffHostBinding = { url: `http://host/${hostile}/api/riff-host-tools`, token: hostile,
      sessionId: 'session-1', turnId: 'turn-1',
      cliSha256: variant === 'checksum injection' ? "'; touch \"$PWNED\"; #" : digest };
    const { instance, requests } = backend(() => binding);
    instance.write('request'); await (instance as any).writeChain;
    const prompt = requests.find(r => r.url.endsWith('/api/task-execute'))!.body.config.userPrompt;
    const command = /before binding:\n([\s\S]*?)\nFor EVERY/.exec(prompt)![1]!;
    expect(spawnSync('bash', ['-n'], { input: command }).status).toBe(0);
    const result = spawnSync('bash', ['-c', `
      curl() {
        printf '%s\\0' "$@" > "$CURL_ARGS"
        while [ "$#" -gt 0 ]; do
          if [ "$1" = '-o' ]; then cp "$ARTIFACT_SOURCE" "$2"; return; fi
          shift
        done
        return 92
      }
      ${command}
    `], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root, ARTIFACT_SOURCE: join(root, 'artifact'), CURL_ARGS: join(root, 'curl-args'),
      BOUND_ARGS: join(root, 'bound-args'), PWNED: join(root, 'pwned') } });
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    const args = readFileSync(join(root, 'curl-args'), 'utf8').split('\0');
    expect(args).toContain(`${binding.url}?artifact=cli`);
    expect(args[args.indexOf('-H') + 1]).toBe(`x-riff-host-token: ${binding.token}`);
    if (variant === 'checksum injection') {
      expect(result.status).not.toBe(0);
      expect(existsSync(join(root, 'bound-args'))).toBe(false);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(bin, 'botmux'), 'utf8')).toBe(artifact);
      const bound = readFileSync(join(root, 'bound-args'), 'utf8').split('\0');
      expect(bound.slice(0, 2)).toEqual(['1', 'riff-host-bind']);
      expect(JSON.parse(Buffer.from(bound[2]!, 'base64url').toString())).toEqual(binding);
    }
  });
});
