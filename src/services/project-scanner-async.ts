import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ProjectInfo, ProjectScanOptions } from './project-scanner.js';

interface ScanRequest {
  baseDirs: string[];
  maxDepth: number;
  options: ProjectScanOptions;
}

type ScanResponse =
  | { ok: true; projects: ProjectInfo[] }
  | { ok: false; error: string };

function childEntryPoint(): { path: string; execArgv: string[] } {
  const compiledPath = fileURLToPath(new URL('./project-scanner-child.js', import.meta.url));
  if (existsSync(compiledPath)) return { path: compiledPath, execArgv: [] };

  return {
    path: fileURLToPath(new URL('./project-scanner-child.ts', import.meta.url)),
    execArgv: ['--import', 'tsx'],
  };
}

function runScan(request: ScanRequest): Promise<ProjectInfo[]> {
  return new Promise((resolve, reject) => {
    const entryPoint = childEntryPoint();
    const child = fork(entryPoint.path, [], {
      execArgv: entryPoint.execArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let response: ScanResponse | undefined;
    let failure: Error | undefined;

    child.once('message', (message) => {
      response = message as ScanResponse;
    });
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code, signal) => {
      if (failure) {
        reject(failure);
      } else if (!response) {
        reject(new Error(`Project scanner child exited without a response (code=${code}, signal=${signal ?? 'none'})`));
      } else if (!response.ok) {
        reject(new Error(response.error));
      } else if (code !== 0) {
        reject(new Error(`Project scanner child exited with code ${code}`));
      } else {
        resolve(response.projects);
      }
    });

    try {
      child.send(request, (error) => {
        if (!error) return;
        failure ??= error;
        child.kill();
      });
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
      child.kill();
    }
  });
}

let scanQueue: Promise<void> = Promise.resolve();

export function scanMultipleProjectsAsync(
  baseDirs: string[],
  maxDepth: number = 3,
  options: ProjectScanOptions = {},
): Promise<ProjectInfo[]> {
  const request: ScanRequest = {
    baseDirs: [...baseDirs],
    maxDepth,
    options: { ...options },
  };
  const result = scanQueue.then(() => runScan(request));
  scanQueue = result.then(() => undefined, () => undefined);
  return result;
}
