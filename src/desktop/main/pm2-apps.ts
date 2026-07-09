import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync as pathExistsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { DesktopPaths } from '../shared/types.js';
import type { ExternalRuntimeCandidate } from './runtime-service.js';
import { parsePm2Apps, type Pm2AppSummary } from './runtime-source.js';

interface Pm2ListDeps {
  existsSync?: (path: string) => boolean;
  spawn?: typeof spawnProcess;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export const defaultPm2ListTimeoutMs = 25_000;

export function listPm2Apps(
  paths: DesktopPaths,
  runtime: ExternalRuntimeCandidate,
  deps: Pm2ListDeps = {},
): Promise<Pm2AppSummary[]> {
  const existsSync = deps.existsSync ?? pathExistsSync;
  const packageRoot = runtime.root;
  const pm2Bin = join(packageRoot, 'node_modules', 'pm2', 'bin', 'pm2');
  if (!existsSync(pm2Bin)) {
    return Promise.reject(new Error(`PM2 binary not found: ${pm2Bin}`));
  }

  const command = pm2Bin;
  const args = ['jlist'];
  const baseEnv = deps.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    // External PM2 bins use /usr/bin/env node; Finder-launched apps need a
    // repaired PATH so discovery does not depend on the user's shell startup.
    PATH: withRuntimePath(baseEnv.PATH, runtime.binPath, runtime.pathEnv),
    PM2_HOME: paths.pm2Home,
    SESSION_DATA_DIR: paths.dataDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;

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
