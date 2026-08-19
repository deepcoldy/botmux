import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync as pathExistsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { DesktopPaths } from '../shared/types.js';
import { buildBundledPath } from './node-command.js';
import type { RuntimeLaunchTarget } from './runtime-service.js';
import { parsePm2Apps, type Pm2AppSummary } from './runtime-source.js';
import {
  inspectLinuxPm2ReadonlyTarget,
  type LinuxPm2GodProcess,
} from '../../core/pm2-lifecycle-owner.js';

interface Pm2ListDeps {
  existsSync?: (path: string) => boolean;
  spawn?: typeof spawnProcess;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Probed user shell PATH for bundled runtimes (see probeShellPathEnv). */
  pathEnv?: string;
  /** Test seam for the side-effect-free PM2 lifecycle preflight. */
  pm2QueryAvailable?: (home: string) => boolean | LinuxPm2GodProcess;
}

export const defaultPm2ListTimeoutMs = 25_000;

function pm2QueryAvailable(home: string): boolean | LinuxPm2GodProcess {
  // The direct-RPC helper is side-effect free and determines absence without
  // relying on process.title, which is not reflected in Windows CIM CommandLine.
  if (process.platform !== 'linux') return true;
  return inspectLinuxPm2ReadonlyTarget(home);
}

export function listPm2Apps(
  paths: DesktopPaths,
  runtime: RuntimeLaunchTarget,
  deps: Pm2ListDeps = {},
): Promise<Pm2AppSummary[]> {
  const existsSync = deps.existsSync ?? pathExistsSync;
  const packageRoot = runtime.root;
  const pm2Bin = join(packageRoot, 'node_modules', 'pm2', 'bin', 'pm2');
  if (!existsSync(pm2Bin)) {
    return Promise.reject(new Error(`PM2 binary not found: ${pm2Bin}`));
  }
  let expectedGod: LinuxPm2GodProcess | undefined;
  try {
    const query = (deps.pm2QueryAvailable ?? pm2QueryAvailable)(paths.pm2Home);
    if (!query) return Promise.resolve([]);
    expectedGod = typeof query === 'object' ? query : undefined;
  } catch (error) {
    return Promise.reject(error);
  }

  const command = runtime.kind === 'bundled'
    ? runtime.nodePath
    : (deps.execPath ?? process.execPath);
  const args = [join(packageRoot, 'dist', 'cli', 'pm2-readonly-client.js'), 'jlist'];
  const baseEnv = deps.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    // Finder-launched apps still need a repaired PATH for app metadata and
    // follow-up launches. The observer itself uses an absolute Node path and
    // direct RPC; it never creates a missing PM2 daemon.
    PATH: runtime.kind === 'bundled'
      ? buildBundledPath(baseEnv.PATH, runtime.nodePath, deps.pathEnv)
      : withRuntimePath(baseEnv.PATH, runtime.binPath, runtime.pathEnv),
    PM2_HOME: paths.pm2Home,
    SESSION_DATA_DIR: paths.dataDir,
  };
  delete env.BOTMUX_PM2_EXPECTED_GOD;
  if (expectedGod) env.BOTMUX_PM2_EXPECTED_GOD = JSON.stringify(expectedGod);
  if (runtime.kind === 'bundled') delete env.ELECTRON_RUN_AS_NODE;
  else if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  return new Promise((resolve, reject) => {
    // PM2 discovery is a status input, not decorative data: errors reject so
    // runtime-service can surface a degraded state instead of pretending stopped.
    const child = (deps.spawn ?? spawnProcess)(command, args, { cwd: packageRoot, env }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`PM2 jlist timed out after ${deps.timeoutMs ?? defaultPm2ListTimeoutMs}ms`));
    }, deps.timeoutMs ?? defaultPm2ListTimeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => {
      finish(() => reject(new Error(`PM2 jlist failed: ${error.message}`)));
    });
    child.on('close', code => {
      finish(() => {
        if (code === 3) {
          resolve([]);
          return;
        }
        if (code !== 0 || !stdout) {
          const detail = concise(stderr || `exit code ${code ?? 1}`);
          reject(new Error(`PM2 jlist failed: ${detail}`));
          return;
        }
        try {
          resolve(parsePm2Apps(stdout));
        } catch (error) {
          reject(new Error(`PM2 jlist parse failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
  });
}

function withRuntimePath(current: string | undefined, binPath: string, pathEnv: string | undefined): string {
  const entries = [
    dirname(binPath),
    ...(pathEnv ? pathEnv.split(delimiter) : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...(current ? current.split(delimiter) : []),
  ];
  const seen = new Set<string>();
  return entries
    .map(entry => entry.trim())
    .filter(entry => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(delimiter);
}

function concise(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
