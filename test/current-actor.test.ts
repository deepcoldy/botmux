import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CURRENT_ACTOR_SCHEMA,
  CurrentActorError,
  normalizeActorEmail,
  parseCurrentActorArgs,
  resolveBotmuxAncestorContext,
  resolveCurrentActor,
} from '../src/cli/current-actor.js';

function writeProcEnv(
  root: string,
  pid: number,
  parent: number,
  env: Record<string, string>,
  options: { comm?: string; exe?: string } = {},
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), `${pid} (${options.comm ?? 'proc'}) S ${parent} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100\n`);
  writeFileSync(join(dir, 'environ'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0'));
  if (options.exe) symlinkSync(options.exe, join(dir, 'exe'));
}

describe('current actor client contract', () => {
  it.skipIf(process.platform !== 'linux')('gets route hints from a consistent BotMux ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    const env = {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_app',
      BOTMUX_DAEMON_IPC_PORT: '7951',
    };
    writeProcEnv(root, 20, 10, env);
    writeProcEnv(root, 10, 1, env);
    expect(resolveBotmuxAncestorContext(20, root)).toEqual({
      sessionId: 's1', larkAppId: 'cli_app', ipcPort: 7951,
    });
  });

  it.skipIf(process.platform !== 'linux')('rejects conflicting BotMux ancestors', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    writeProcEnv(root, 20, 10, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    writeProcEnv(root, 10, 1, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's2', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    expect(() => resolveBotmuxAncestorContext(20, root)).toThrow(CurrentActorError);
  });

  it.skipIf(process.platform !== 'linux')('stops before a shared tmux server with stale BotMux routing', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    const current = {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's-current', BOTMUX_LARK_APP_ID: 'cli_current',
      BOTMUX_DAEMON_IPC_PORT: '7951',
    };
    const stale = {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's-stale', BOTMUX_LARK_APP_ID: 'cli_stale',
      BOTMUX_DAEMON_IPC_PORT: '7952',
    };
    writeProcEnv(root, 30, 20, current);
    writeProcEnv(root, 20, 10, current);
    writeProcEnv(root, 10, 5, stale, { comm: 'tmux: server', exe: '/usr/bin/tmux' });
    writeProcEnv(root, 5, 1, stale);

    expect(resolveBotmuxAncestorContext(30, root)).toEqual({
      sessionId: 's-current', larkAppId: 'cli_current', ipcPort: 7951,
    });
  });

  it.skipIf(process.platform !== 'linux')('does not trust a process merely named like a tmux server', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    writeProcEnv(root, 20, 10, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    writeProcEnv(root, 10, 1, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's2', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_DAEMON_IPC_PORT: '7951',
    }, { comm: 'tmux: server', exe: '/tmp/not-tmux' });

    expect(() => resolveBotmuxAncestorContext(20, root)).toThrow(CurrentActorError);
  });

  it('republishes the opening turn after the live CLI pid is attested', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const start = worker.indexOf('function publishLocalProcessAttestation');
    const body = worker.slice(start, worker.indexOf('/** Deliver a terminal IPC', start));
    expect(body).toContain("type: 'local_process_attestation'");
    expect(body).toContain('if (currentBotmuxTurnId) publishSandboxRelayCapability()');
  });

  it('accepts only the machine-readable current command', () => {
    expect(parseCurrentActorArgs(['current', '--json'])).toEqual({ ok: true });
    expect(parseCurrentActorArgs(['current'])).toEqual({
      ok: false,
      error: '用法: botmux actor current --json',
    });
  });

  it('accepts only an exact verified daemon response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      schema: CURRENT_ACTOR_SCHEMA,
      status: 'verified',
      actor: { email: 'current.user@example.com' },
    }), { status: 200 }));
    await expect(resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ status: 'verified', actor: { email: 'current.user@example.com' } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:7951/api/current-actor',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 'sess-1' }) }),
    );
  });

  it.each([
    [{ schema: 'botmux.current-actor.v1', status: 'verified', actor: { email: 'x@example.com' } }],
    [{ schema: CURRENT_ACTOR_SCHEMA, status: 'verified', actor: { email: 'X@example.com' } }],
    [{ schema: CURRENT_ACTOR_SCHEMA, status: 'verified', actor: { email: 'not-an-email' } }],
    [{ schema: CURRENT_ACTOR_SCHEMA, status: 'verified', actor: { email: 'x@example.com', username: 'x' } }],
  ])('rejects an invalid daemon document: %j', async (payload) => {
    await expect(resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    })).rejects.toThrow(CurrentActorError);
  });

  it('fails closed when the daemon refuses the request', async () => {
    await expect(resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      fetchImpl: vi.fn(async () => new Response('{}', { status: 403 })) as typeof fetch,
    })).rejects.toThrow(CurrentActorError);
  });

  it.each([undefined, '', 'not-an-email', '@example.com', 'a@b@c'])(
    'normalizer rejects an invalid email: %s',
    (email) => expect(() => normalizeActorEmail(email)).toThrow(CurrentActorError),
  );

  it('normalizes an actor email without enforcing a tenant domain', () => {
    expect(normalizeActorEmail(' Current.User@Example.COM ')).toBe('current.user@example.com');
  });
});
