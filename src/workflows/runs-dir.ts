import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

export function getRunsDir(): string {
  return process.env.BOTMUX_WORKFLOW_RUNS_DIR ?? join(config.session.dataDir, 'workflow-runs');
}

export function runDir(runId: string, baseDir = getRunsDir()): string {
  return join(baseDir, runId);
}

export async function ensureRunDir(runId: string, baseDir = getRunsDir()): Promise<string> {
  const dir = runDir(runId, baseDir);
  await mkdir(dir, { recursive: true });
  return dir;
}
