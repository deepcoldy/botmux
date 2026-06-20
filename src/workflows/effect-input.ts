import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.js';
import type { EventLog } from './events/append.js';

export async function writeEffectInputSidecar(
  log: EventLog,
  activityId: string,
  attemptId: string,
  input: unknown,
): Promise<string> {
  const dir = await effectInputDir(log, activityId, attemptId);
  const path = join(dir, 'effect-input.json');
  await atomicWriteFile(path, JSON.stringify(input, null, 2));
  return path;
}

export async function loadEffectInputSidecar(
  log: EventLog,
  activityId: string,
  attemptId: string,
): Promise<unknown> {
  const path = join(log.runDir, 'attempts', activityId, attemptId, 'effect-input.json');
  return JSON.parse(await fs.readFile(path, 'utf-8'));
}

async function effectInputDir(
  log: EventLog,
  activityId: string,
  attemptId: string,
): Promise<string> {
  const dir = join(log.runDir, 'attempts', activityId, attemptId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
