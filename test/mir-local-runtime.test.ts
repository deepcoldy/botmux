import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMiramcpSandboxAllows, getMiraRuntimePaths } from '../src/mir-local-runtime.js';

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
