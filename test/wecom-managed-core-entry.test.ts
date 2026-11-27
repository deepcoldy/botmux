import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWecomCoreEntry, startWecomManagedCore } from '../src/im/wecom/gateway/managed-core.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * The gateway starts its dedicated core from the same build it runs from, so
 * the two are always the same code: dist/ → dist/index-core-only.js, a source
 * run → src/index-core-only.ts, the compiled binary → `<binary> __core-only`.
 * A source run used to start dist/index-core-only.js: an unbuilt checkout had
 * no core at all, and a stale dist/ ran old core code under a new gateway.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const REAL_ARGV1 = process.argv[1];
const roots: string[] = [];

afterEach(async () => {
  process.argv[1] = REAL_ARGV1;
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wecom-managed-entry-'));
  roots.push(root);
  return root;
}

async function managedCoreConfig() {
  const port = await reserveWecomCorePort();
  const root = tempRoot();
  return {
    managedCore: {
      botId: 'local_wecom_entry',
      cli: 'codex',
      backend: 'pty' as const,
      workingDirectory: root,
      stateDir: join(root, 'state'),
      port,
    },
  };
}

describe('WeCom managed core entry', () => {
  it('runs dist/index-core-only.js next to a gateway running from dist/', () => {
    const root = tempRoot();
    const gatewayModule = pathToFileURL(join(root, 'dist', 'im', 'wecom', 'gateway', 'managed-core.js')).href;

    expect(resolveWecomCoreEntry(gatewayModule)).toEqual({
      command: process.execPath,
      args: [join(root, 'dist', 'index-core-only.js')],
    });
  });

  it('re-executes the compiled binary with the hidden core-only entry', () => {
    process.argv[1] = '/$bunfs/root/cli.js';

    expect(resolveWecomCoreEntry()).toEqual({ command: process.execPath, args: ['__core-only'] });
  });

  it('runs the source core-only entry when the gateway runs from source', async () => {
    const spawned: { command: string; args: string[] }[] = [];
    // The fake child has already exited, so startup gives up right after the
    // spawn call and no process is ever started.
    const fakeSpawn = (command: string, args: string[]) => {
      spawned.push({ command, args });
      const child = Object.assign(new EventEmitter(), { exitCode: 1, signalCode: null, pid: undefined });
      return child as unknown as ChildProcess;
    };

    await startWecomManagedCore(await managedCoreConfig(), { spawn: fakeSpawn }).catch(() => undefined);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe(process.execPath);
    expect(spawned[0].args.at(-1)).toBe(join(repoRoot, 'src', 'index-core-only.ts'));
  });

  it('resolves a source entry this runtime can actually start', async () => {
    const entry = resolveWecomCoreEntry();
    const home = tempRoot();
    // An invalid port makes the real entry exit right after its own startup checks.
    const child = spawn(entry.command, entry.args, {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        BOTMUX_API_PORT: 'invalid',
        BOTMUX_CORE_SKIP_DOTENV: '1',
        BOTMUX_CORE_STATE_DIR: join(home, 'state'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr!.on('data', data => {
      errors += data;
    });
    const [code] = await once(child, 'close');

    expect(code).toBe(1);
    expect(errors).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
  });
});
