/**
 * The ask_question hook botmux writes into agy's global hooks.json
 * (`~/.gemini/config/hooks.json`, hook-installer `antigravity-hooks`).
 *
 * agy (measured on 1.5.12) fails the ask_question call when its PreToolUse
 * handler exits non-zero, prints anything that is not a JSON decision, or is
 * killed at its timeout — so the installed command itself must end as an
 * empty stdout + exit 0 (agy then opens its own picker) whenever botmux is
 * gone or crashes. Those cases run the generated command through a real `sh`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_HOOK_NAME, antigravityHookCommand, installHook } from '../src/adapters/hook-installer.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';

let dir: string;
let configPath: string;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-agy-hooks-'));
  configPath = join(dir, '.gemini', 'config', 'hooks.json');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const install = () => installHook('antigravity', { configPath, format: 'antigravity-hooks' }, 'unused');
const read = () => JSON.parse(readFileSync(configPath, 'utf-8'));

function ourHandler(doc: any): { type: string; command: string; timeout: number } {
  const groups = doc[ANTIGRAVITY_HOOK_NAME].PreToolUse;
  expect(groups).toHaveLength(1);
  expect(groups[0].matcher).toBe('ask_question');
  expect(groups[0].hooks).toHaveLength(1);
  return groups[0].hooks[0];
}

describe('installing the agy ask_question hook', () => {
  it('the agy adapter installs it where agy reads global hooks', () => {
    vi.stubEnv('HOME', dir);
    const adapter = createCliAdapterSync('antigravity');
    expect(adapter.hookInstall).toBeDefined();
    installHook('antigravity', adapter.hookInstall!, 'unused');
    const handler = ourHandler(read());
    expect(handler.type).toBe('command');
    expect(handler.command).toMatch(/; then exec .* hook antigravity; fi; /);
  });

  it('the ACP transport declares the same install (agy runs PreToolUse hooks under `agy acp` too)', () => {
    vi.stubEnv('HOME', dir);
    const terminal = createCliAdapterSync('antigravity').hookInstall;
    expect(createCliAdapterSync('antigravity', undefined, { antigravityTransport: 'acp' }).hookInstall).toEqual(terminal);
  });

  it('only matches ask_question, and outlives the hook client\'s own ask wait', () => {
    install();
    const handler = ourHandler(read());
    // runHook waits 24h by default (cli.ts DEFAULT_TIMEOUT_MS); agy kills the
    // handler at `timeout` seconds and fails the call, so it must be later.
    expect(handler.timeout).toBeGreaterThan(24 * 60 * 60);
  });

  it('keeps every other named hook and replaces only its own entry (idempotent)', () => {
    mkdirSync(join(dir, '.gemini', 'config'), { recursive: true });
    const other = {
      herdr: { PreInvocation: [{ type: 'command', command: 'bash herdr.sh session', timeout: 10 }] },
      [ANTIGRAVITY_HOOK_NAME]: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'old botmux' }] }] },
    };
    writeFileSync(configPath, JSON.stringify(other));
    install();
    const first = readFileSync(configPath, 'utf-8');
    install();
    expect(readFileSync(configPath, 'utf-8')).toBe(first);
    const doc = read();
    expect(doc.herdr).toEqual(other.herdr);
    expect(ourHandler(doc).command).not.toBe('old botmux');
  });

  it('an explicit "enabled": false on its own hook is the user\'s choice and survives', () => {
    mkdirSync(join(dir, '.gemini', 'config'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ [ANTIGRAVITY_HOOK_NAME]: { enabled: false } }));
    install();
    expect(read()[ANTIGRAVITY_HOOK_NAME].enabled).toBe(false);
    ourHandler(read());
  });

  it('reads a file saved with a UTF-8 BOM (agy accepts those) without dropping its hooks', () => {
    mkdirSync(join(dir, '.gemini', 'config'), { recursive: true });
    writeFileSync(configPath, `\uFEFF${JSON.stringify({ mine: { Stop: [{ command: 'true' }] } })}`);
    install();
    expect(read().mine).toEqual({ Stop: [{ command: 'true' }] });
  });

  it.each(['{ not json', '[1, 2]', '"text"'])('never rewrites a hooks.json it cannot read as an object: %s', content => {
    mkdirSync(join(dir, '.gemini', 'config'), { recursive: true });
    writeFileSync(configPath, content);
    install();
    expect(readFileSync(configPath, 'utf-8')).toBe(content);
  });

  it('creates the file and its directory when agy has none yet', () => {
    expect(existsSync(configPath)).toBe(false);
    install();
    ourHandler(read());
  });
});

describe('the installed command (real sh): fails open, and is the process agy kills', () => {
  const PAYLOAD = '{"hookEventName":"PreToolUse","toolCall":{"name":"ask_question"}}';
  const run = (command: string) => spawnSync('sh', ['-c', command], {
    input: PAYLOAD, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });

  function fakeBotmux(body: string, name = 'cli.js'): string {
    const script = join(dir, 'with space', name);
    mkdirSync(join(dir, 'with space'), { recursive: true });
    writeFileSync(script, `#!/bin/sh\n${body}\n`);
    chmodSync(script, 0o755);
    return script;
  }

  it('passes the hook client\'s decision and agy\'s stdin through', () => {
    const script = fakeBotmux(`stdin=$(cat); printf '{"decision":"deny","reason":"%s"}' "$(printf %s "$stdin" | wc -c | tr -d ' ')"`);
    const r = run(antigravityHookCommand({ cmd: '/bin/sh', args: [script, 'hook', 'antigravity'] }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ decision: 'deny', reason: String(PAYLOAD.length) });
  });

  it('botmux script gone (moved checkout / uninstalled): empty stdout, exit 0', () => {
    const r = run(antigravityHookCommand({ cmd: '/bin/sh', args: [join(dir, 'gone', 'cli.js'), 'hook', 'antigravity'] }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('runtime gone: empty stdout, exit 0', () => {
    const r = run(antigravityHookCommand({ cmd: join(dir, 'no-such-node'), args: ['hook', 'antigravity'] }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('the process agy kills is the hook client itself (no shell left in between to orphan it)', async () => {
    const pidFile = join(dir, 'client.pid');
    const script = fakeBotmux(`echo $$ > '${pidFile}'; cat >/dev/null; exec sleep 30`);
    const child = spawn('sh', ['-c', antigravityHookCommand({ cmd: '/bin/sh', args: [script, 'hook', 'antigravity'] })], {
      stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    try {
      child.stdin!.end(PAYLOAD);
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim() !== '');
      const clientPid = Number(readFileSync(pidFile, 'utf-8').trim());
      // agy SIGKILLs the pid it started; that must be the client.
      expect(clientPid).toBe(child.pid);
      child.kill('SIGKILL');
      await until(() => !alive(clientPid));
    } finally {
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf-8').trim()) : 0;
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
