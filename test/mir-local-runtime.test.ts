import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMiramcpBridgeStarted, ensureMiramcpSandboxAllows, getMiraRuntimePaths } from '../src/mir-local-runtime.js';

describe('getMiraRuntimePaths', () => {
  it('derives a logical home alias when cwd is under a symlinked home realpath', () => {
    const paths = getMiraRuntimePaths({
      cwd: '/data00/home/alice/.botmux/workspace/mira',
      home: '/home/alice',
      realHome: '/data00/home/alice',
    });

    expect(paths.cwd).toBe('/data00/home/alice/.botmux/workspace/mira');
    expect(paths.logicalCwd).toBe('/home/alice/.botmux/workspace/mira');
    expect(paths.allowedPathCandidates).toEqual([
      '/data00/home/alice/.botmux/workspace/mira',
      '/home/alice/.botmux/workspace/mira',
    ]);
  });

  it('keeps an absolute PWD alias when it is different from the physical cwd', () => {
    const paths = getMiraRuntimePaths({
      cwd: '/mnt/data/project',
      home: '/home/alice',
      envPwd: '/home/alice/project',
      realHome: '/home/alice',
    });

    expect(paths.allowedPathCandidates).toEqual([
      '/mnt/data/project',
      '/home/alice/project',
    ]);
  });
});

describe('ensureMiramcpSandboxAllows', () => {
  it('adds the physical cwd when only the logical home path is allowed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mcps: [{
        id: 'mira_local',
        protocol: 'stdio',
        command: '/usr/bin/node',
        args: ['mira_local_mcp.js'],
        sandbox: {
          enabled: true,
          write_allow_paths: ['/home/alice', '/tmp'],
          write_deny_paths: ['/home/alice/.ssh'],
          read_deny_paths: ['/home/alice/.ssh'],
        },
      }],
    }, null, 2));

    const result = ensureMiramcpSandboxAllows([
      '/data00/home/alice/.botmux/workspace/mira',
      '/home/alice/.botmux/workspace/mira',
    ], configPath);

    expect(result.changed).toBe(true);
    expect(result.added).toEqual(['/data00/home/alice/.botmux/workspace/mira']);
    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.mcps[0].sandbox.write_allow_paths).toEqual([
      '/home/alice',
      '/tmp',
      '/data00/home/alice/.botmux/workspace/mira',
    ]);
  });

  it('does not add duplicates when the physical cwd is already under an allowed raw prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mcps: [{
        id: 'mira_local',
        sandbox: {
          write_allow_paths: ['/data00/home/alice'],
        },
      }],
    }));

    const result = ensureMiramcpSandboxAllows(['/data00/home/alice/project'], configPath);

    expect(result.changed).toBe(false);
    expect(result.added).toEqual([]);
    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(updated.mcps[0].sandbox.write_allow_paths).toEqual(['/data00/home/alice']);
  });

  it('accumulates paths across sequential (locked) calls and cleans up the lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mcps: [{ id: 'mira_local', sandbox: { write_allow_paths: [] } }],
    }));

    ensureMiramcpSandboxAllows(['/ws/a'], configPath);
    ensureMiramcpSandboxAllows(['/ws/b'], configPath);

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    // Second call must NOT clobber the first call's addition.
    expect(updated.mcps[0].sandbox.write_allow_paths).toEqual(['/ws/a', '/ws/b']);
    // Lock released (no leftover .lock).
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });
});

describe('ensureMiramcpBridgeStarted', () => {
  it('starts miramcp in the background when enabled and not already running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-start-'));
    const configPath = join(dir, 'mira-config.json');
    const pidFile = join(dir, 'miramcp.pid');
    const binPath = join(dir, 'miramcp');
    writeFileSync(configPath, JSON.stringify({ device_id: 'alice_devbox' }));
    writeFileSync(binPath, '#!/bin/sh\n', 'utf8');
    chmodSync(binPath, 0o755);

    const calls: Array<{ command: string; args: readonly string[] }> = [];
    let lockSeenDuringSpawn = false;
    let errorListener: ((err: Error) => void) | undefined;
    let lsofCalls = 0;
    const result = ensureMiramcpBridgeStarted({
      configPath,
      pidFile,
      binPath,
      env: { PATH: '' },
      processExists: pid => pid === 4242,
      spawnSyncImpl: () => ({ stdout: ++lsofCalls >= 2 ? '4242\n' : '' }),
      startupTimeoutMs: 0,
      spawnImpl: (command, args) => {
        calls.push({ command, args });
        lockSeenDuringSpawn = existsSync(`${pidFile}.lock`);
        return {
          pid: 4242,
          unref() { /* detached */ },
          once(event, listener) {
            if (event === 'error') errorListener = listener;
          },
        };
      },
    });

    expect(result).toMatchObject({
      status: 'started',
      deviceId: 'alice_devbox',
      binPath,
      pid: 4242,
    });
    expect(calls).toEqual([{ command: binPath, args: ['run', '--device-id', 'alice_devbox'] }]);
    expect(lockSeenDuringSpawn).toBe(true);
    expect(existsSync(`${pidFile}.lock`)).toBe(false);
    expect(errorListener).toBeDefined();
    expect(readFileSync(pidFile, 'utf8')).toBe('4242');
    expect(() => errorListener?.(new Error('async spawn failure'))).not.toThrow();
    expect(existsSync(pidFile)).toBe(false);
  });

  it('removes the pid file when a started bridge exits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-exit-'));
    const configPath = join(dir, 'mira-config.json');
    const pidFile = join(dir, 'miramcp.pid');
    const binPath = join(dir, 'miramcp');
    writeFileSync(configPath, JSON.stringify({ device_id: 'alice_devbox' }));
    writeFileSync(binPath, '#!/bin/sh\n', 'utf8');
    chmodSync(binPath, 0o755);

    let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let lsofCalls = 0;
    const result = ensureMiramcpBridgeStarted({
      configPath,
      pidFile,
      binPath,
      env: { PATH: '' },
      processExists: pid => pid === 4242,
      spawnSyncImpl: () => ({ stdout: ++lsofCalls >= 2 ? '4242\n' : '' }),
      startupTimeoutMs: 0,
      spawnImpl: () => ({
        pid: 4242,
        unref() { /* detached */ },
        once(event, listener) {
          if (event === 'exit') exitListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
        },
      }),
    });

    expect(result.status).toBe('started');
    expect(readFileSync(pidFile, 'utf8')).toBe('4242');
    expect(exitListener).toBeDefined();
    exitListener?.(1, null);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('does not write a pid file when the spawned bridge dies during startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-dies-'));
    const configPath = join(dir, 'mira-config.json');
    const pidFile = join(dir, 'miramcp.pid');
    const binPath = join(dir, 'miramcp');
    writeFileSync(configPath, JSON.stringify({ device_id: 'alice_devbox' }));
    writeFileSync(binPath, '#!/bin/sh\n', 'utf8');
    chmodSync(binPath, 0o755);

    const result = ensureMiramcpBridgeStarted({
      configPath,
      pidFile,
      binPath,
      env: { PATH: '' },
      processExists: () => false,
      spawnSyncImpl: () => ({ stdout: '' }),
      startupTimeoutMs: 0,
      spawnImpl: () => ({
        pid: 4343,
        unref() { /* detached */ },
        once() { /* listeners attached by production code */ },
      }),
    });

    expect(result).toMatchObject({
      status: 'spawn_failed',
      pid: 4343,
      error: 'miramcp exited during startup',
    });
    expect(existsSync(pidFile)).toBe(false);
  });

  it('tracks a slow-starting bridge after startup timeout and avoids duplicate spawns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-pending-'));
    const configPath = join(dir, 'mira-config.json');
    const pidFile = join(dir, 'miramcp.pid');
    const binPath = join(dir, 'miramcp');
    writeFileSync(configPath, JSON.stringify({ device_id: 'alice_devbox' }));
    writeFileSync(binPath, '#!/bin/sh\n', 'utf8');
    chmodSync(binPath, 0o755);

    let spawnCount = 0;
    const common = {
      configPath,
      pidFile,
      binPath,
      env: { PATH: '' },
      processExists: (pid: number) => pid === 4242,
      spawnSyncImpl: () => ({ stdout: '' }),
      startupTimeoutMs: 0,
    };

    const first = ensureMiramcpBridgeStarted({
      ...common,
      spawnImpl: () => {
        spawnCount++;
        return {
          pid: 4242,
          unref() { /* detached */ },
          once() { /* listeners attached by production code */ },
        };
      },
    });

    expect(first).toMatchObject({
      status: 'started_pending',
      pid: 4242,
      error: 'miramcp did not bind port 9801 during startup',
    });
    expect(readFileSync(pidFile, 'utf8')).toBe('4242');

    const second = ensureMiramcpBridgeStarted({
      ...common,
      spawnImpl: () => {
        throw new Error('must not spawn twice');
      },
    });

    expect(second).toMatchObject({
      status: 'started_pending',
      pid: 4242,
      error: 'miramcp pid is still starting; port 9801 is not listening yet',
    });
    expect(spawnCount).toBe(1);
    expect(readFileSync(pidFile, 'utf8')).toBe('4242');
  });

  it('does not trust a live pid file when port 9801 is not listening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-stale-pid-'));
    const configPath = join(dir, 'mira-config.json');
    const pidFile = join(dir, 'miramcp.pid');
    const binPath = join(dir, 'miramcp');
    writeFileSync(configPath, JSON.stringify({ device_id: 'alice_devbox' }));
    writeFileSync(pidFile, '1234');
    const old = new Date(Date.now() - 60_000);
    utimesSync(pidFile, old, old);
    writeFileSync(binPath, '#!/bin/sh\n', 'utf8');
    chmodSync(binPath, 0o755);

    let lsofCalls = 0;
    const result = ensureMiramcpBridgeStarted({
      configPath,
      pidFile,
      binPath,
      env: { PATH: '' },
      processExists: pid => pid === 1234 || pid === 4242,
      spawnSyncImpl: () => ({ stdout: ++lsofCalls >= 3 ? '4242\n' : '' }),
      startupTimeoutMs: 0,
      spawnImpl: () => ({
        pid: 4242,
        unref() { /* detached */ },
        once() { /* listeners attached by production code */ },
      }),
    });

    expect(result).toMatchObject({ status: 'started', pid: 4242 });
    expect(readFileSync(pidFile, 'utf8')).toBe('4242');
  });

  it('respects auto_start_bridge false in ~/.mira/config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-disabled-'));
    const configPath = join(dir, 'mira-config.json');
    writeFileSync(configPath, JSON.stringify({ device_id: 'alice_devbox', auto_start_bridge: false }));

    const result = ensureMiramcpBridgeStarted({
      configPath,
      pidFile: join(dir, 'miramcp.pid'),
      binPath: join(dir, 'miramcp'),
      env: { PATH: '' },
      spawnImpl: () => {
        throw new Error('must not spawn');
      },
    });

    expect(result.status).toBe('disabled');
  });

  it('does not spawn when the pid file points to a live process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-miramcp-running-'));
    const configPath = join(dir, 'mira-config.json');
    const pidFile = join(dir, 'miramcp.pid');
    writeFileSync(configPath, JSON.stringify({ device_id: 'alice_devbox' }));
    writeFileSync(pidFile, '1234');

    const result = ensureMiramcpBridgeStarted({
      configPath,
      pidFile,
      env: { PATH: '' },
      processExists: pid => pid === 1234,
      spawnSyncImpl: () => ({ stdout: '1234\n' }),
      spawnImpl: () => {
        throw new Error('must not spawn');
      },
    });

    expect(result).toMatchObject({ status: 'already_running', deviceId: 'alice_devbox', pid: 1234 });
  });
});
