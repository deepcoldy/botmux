import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionCodexAuth } from '../src/services/codex-auth-sync.js';

const roots: string[] = [];
function tmp(): string {
  const value = mkdtempSync(join(tmpdir(), 'botmux-codex-auth-'));
  roots.push(value);
  return value;
}
function writeAuth(codexHome: string, value: object): string {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  chmodSync(codexHome, 0o700);
  const path = join(codexHome, 'auth.json');
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('per-bot Codex auth synchronization', () => {
  it('defaults to shared and refreshes global auth on every cold provisioning', () => {
    const root = tmp();
    const globalHome = join(root, 'global');
    const botHome = join(root, 'bots', 'a');
    const globalAuth = writeAuth(globalHome, { auth_mode: 'chatgpt', tokens: { access_token: 'global-v1' } });
    const logs: string[] = [];

    provisionCodexAuth({ botHome, globalCodexHome: globalHome, log: line => logs.push(line) });
    const botAuth = join(botHome, 'codex', 'auth.json');
    expect(readFileSync(botAuth, 'utf8')).toContain('global-v1');

    writeFileSync(globalAuth, `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'global-v2' } })}\n`, { mode: 0o600 });
    provisionCodexAuth({ botHome, mode: 'shared', globalCodexHome: globalHome, log: line => logs.push(line) });
    expect(readFileSync(botAuth, 'utf8')).toContain('global-v2');
    expect(lstatSync(botAuth).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).not.toContain('global-v1');
    expect(logs.join('\n')).not.toContain('global-v2');
  });

  it('keeps an isolated API-key auth byte-identical across start, restart and resume provisioning', () => {
    const root = tmp();
    const globalHome = join(root, 'global');
    const botHome = join(root, 'bots', 'isolated');
    writeAuth(globalHome, { auth_mode: 'chatgpt', tokens: { access_token: 'global-secret' } });
    const botAuth = writeAuth(join(botHome, 'codex'), { auth_mode: 'apikey', OPENAI_API_KEY: 'bot-secret' });
    chmodSync(botAuth, 0o644); // legacy/permissive leaf is tightened without rewriting bytes
    const before = readFileSync(botAuth);
    const logs: string[] = [];

    for (const _lifecycle of ['first-start', 'daemon-restart', 'suspend-resume']) {
      provisionCodexAuth({ botHome, mode: 'isolated', globalCodexHome: globalHome, log: line => logs.push(line) });
      expect(readFileSync(botAuth)).toEqual(before);
    }
    expect(logs.join('\n')).not.toContain('bot-secret');
    expect(logs.join('\n')).not.toContain('global-secret');
    expect(lstatSync(botAuth).mode & 0o777).toBe(0o600);
  });

  it('does not copy global auth when isolated auth is missing and gives a login warning', () => {
    const root = tmp();
    const globalHome = join(root, 'global');
    const botHome = join(root, 'bots', 'missing');
    writeAuth(globalHome, { auth_mode: 'chatgpt', tokens: { access_token: 'never-copy-me' } });
    const logs: string[] = [];

    provisionCodexAuth({ botHome, mode: 'isolated', globalCodexHome: globalHome, log: line => logs.push(line) });
    expect(() => readFileSync(join(botHome, 'codex', 'auth.json'))).toThrow();
    expect(logs.join('\n')).toContain('credential=missing');
    expect(logs.join('\n')).toContain('codex login --with-api-key');
    expect(logs.join('\n')).not.toContain('never-copy-me');
  });

  it('keeps two isolated bots on different keys without cross-over', () => {
    const root = tmp();
    const globalHome = join(root, 'global');
    writeAuth(globalHome, { auth_mode: 'chatgpt', tokens: { access_token: 'global' } });
    const botA = join(root, 'bots', 'a');
    const botB = join(root, 'bots', 'b');
    const authA = writeAuth(join(botA, 'codex'), { auth_mode: 'apikey', OPENAI_API_KEY: 'key-a' });
    const authB = writeAuth(join(botB, 'codex'), { auth_mode: 'apikey', OPENAI_API_KEY: 'key-b' });

    provisionCodexAuth({ botHome: botA, mode: 'isolated', globalCodexHome: globalHome, log: () => {} });
    provisionCodexAuth({ botHome: botB, mode: 'isolated', globalCodexHome: globalHome, log: () => {} });
    expect(readFileSync(authA, 'utf8')).toContain('key-a');
    expect(readFileSync(authA, 'utf8')).not.toContain('key-b');
    expect(readFileSync(authB, 'utf8')).toContain('key-b');
    expect(readFileSync(authB, 'utf8')).not.toContain('key-a');
  });

  it('rejects bot-home, codex-home and auth symlinks instead of writing outside BOT_HOME', () => {
    const root = tmp();
    const globalHome = join(root, 'global');
    writeAuth(globalHome, { auth_mode: 'chatgpt' });
    const outside = join(root, 'outside');
    mkdirSync(outside);

    const linkedBotHome = join(root, 'bots', 'linked-bot');
    mkdirSync(join(root, 'bots'), { recursive: true });
    symlinkSync(outside, linkedBotHome);
    expect(() => provisionCodexAuth({ botHome: linkedBotHome, mode: 'shared', globalCodexHome: globalHome, log: () => {} }))
      .toThrow(/per-bot home is not a regular directory/);

    const linkedHome = join(root, 'bots', 'linked-home');
    mkdirSync(linkedHome, { recursive: true });
    symlinkSync(outside, join(linkedHome, 'codex'));
    expect(() => provisionCodexAuth({ botHome: linkedHome, mode: 'shared', globalCodexHome: globalHome, log: () => {} }))
      .toThrow(/not a regular directory/);

    const linkedAuthHome = join(root, 'bots', 'linked-auth');
    mkdirSync(join(linkedAuthHome, 'codex'), { recursive: true });
    const victim = writeAuth(outside, { auth_mode: 'apikey', OPENAI_API_KEY: 'victim' });
    symlinkSync(victim, join(linkedAuthHome, 'codex', 'auth.json'));
    expect(() => provisionCodexAuth({ botHome: linkedAuthHome, mode: 'shared', globalCodexHome: globalHome, log: () => {} }))
      .toThrow(/not a regular file/);
    expect(readFileSync(victim, 'utf8')).toContain('victim');
  });
});
