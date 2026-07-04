import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function locateExecutable(cmd: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!cmd) return null;
  if (isAbsolute(cmd)) return isExecutable(cmd) ? cmd : null;
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, cmd);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
