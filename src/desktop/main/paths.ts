import { join } from 'node:path';
import type { DesktopPaths } from '../shared/types.js';

export interface ResolveDesktopPathsInput {
  homeDir: string;
  userDataDir: string;
  resourcesPath: string;
  appVersion: string;
  isPackaged: boolean;
  devRepoRoot?: string;
}

export function resolveDesktopPaths(input: ResolveDesktopPathsInput): DesktopPaths {
  // Keep user data shared with the CLI/dashboard while storing app-managed
  // process state outside ~/.botmux's package tree, so CLI config survives.
  const botmuxHome = join(input.homeDir, '.botmux');

  return {
    botmuxHome,
    dataDir: join(botmuxHome, 'data'),
    logsDir: join(botmuxHome, 'logs'),
    pm2Home: join(botmuxHome, 'pm2'),
  };
}
