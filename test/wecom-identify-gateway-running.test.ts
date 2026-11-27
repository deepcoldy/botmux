import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileLockTimeoutError, withFileLock } from '../src/utils/file-lock.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { setWecomFleetDesiredState } from '../src/im/wecom/config/fleet-desired-state.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import {
  identifyWecomIdentity,
  runWecomIdentifyCommand,
  WecomIdentifyGatewayRunningError,
} from '../src/cli/wecom/identify.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(join(homedir(), '.botmux'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-identify-busy-'));
  dirs.push(root);
  const file = join(root, 'config.json');
  const secret = join(root, 'credential');
  const botId = randomUUID();
  writeFileSync(secret, 'fake-secret', { mode: 0o600 });
  writeFileSync(file, JSON.stringify({ botId, secretFile: secret, coreUrl: 'http://127.0.0.1:19123', allowedUsers: ['u'] }));
  const botRoot = wecomBotRoot(botId);
  mkdirSync(botRoot, { recursive: true });
  const createTransport = vi.fn(() => { throw new Error('must not connect while the gateway runs'); });
  return { file, output: join(root, 'identity.json'), configId: wecomConfigId(file), lock: join(botRoot, 'instance'), createTransport };
}

/** Run `fn` while another process-like holder keeps the bot's instance lock. */
async function whileGatewayHoldsLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let acquired!: () => void;
  const ready = new Promise<void>(done => { acquired = done; });
  const holder = withFileLock(lock, async () => { acquired(); await held; });
  await ready;
  try {
    return await fn();
  } finally {
    release();
    await holder;
  }
}

describe('identify while the gateway holds the instance lock', () => {
  it('still fails, and says whether the fleet runs the connection', async () => {
    const f = fixture();
    const attempt = () => identifyWecomIdentity({
      configFile: f.file, outputFile: f.output, write: () => {}, createTransport: f.createTransport as never,
    });
    const unmanaged = await whileGatewayHoldsLock(f.lock, () => attempt().catch(error => error));
    expect(unmanaged).toBeInstanceOf(WecomIdentifyGatewayRunningError);
    expect(unmanaged).toMatchObject({ configId: f.configId, fleetManaged: false });

    setWecomFleetDesiredState(f.configId, 'running');
    const managed = await whileGatewayHoldsLock(f.lock, () => attempt().catch(error => error));
    expect(managed).toMatchObject({ configId: f.configId, fleetManaged: true });

    setWecomFleetDesiredState(f.configId, 'stopped');
    const stopped = await whileGatewayHoldsLock(f.lock, () => attempt().catch(error => error));
    expect(stopped).toMatchObject({ fleetManaged: false });

    expect(f.createTransport).not.toHaveBeenCalled();
    expect(existsSync(f.output)).toBe(false);
  });

  it('does not call a lock timeout raised inside its own critical section "the gateway is running"', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running');
    const inner = new FileLockTimeoutError('/elsewhere/some-other-file.lock', 1, 1);
    const failure = await identifyWecomIdentity({
      configFile: f.file,
      outputFile: f.output,
      write: () => {},
      // Reached only once the instance lock is held.
      createTransport: (() => { throw inner; }) as never,
    }).catch(error => error);
    expect(failure).toBe(inner);
    expect(failure).not.toBeInstanceOf(WecomIdentifyGatewayRunningError);
  });

  it('exits 1 from the command and names the connection to stop and start again through the fleet', async () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'running');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await whileGatewayHoldsLock(f.lock, () => runWecomIdentifyCommand(['--config', f.file, '--output', f.output]));
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain(f.configId);
    expect(existsSync(f.output)).toBe(false);
  });
});
