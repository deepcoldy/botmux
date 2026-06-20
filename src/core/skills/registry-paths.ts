import { homedir } from 'node:os';
import { join } from 'node:path';

export function botmuxSkillsHome(): string {
  return join(homedir(), '.botmux', 'skills');
}

export function skillRegistryPath(): string {
  return join(botmuxSkillsHome(), 'registry.json');
}

export function skillStoreDir(): string {
  return join(botmuxSkillsHome(), 'store');
}

export function skillSourcesDir(): string {
  return join(botmuxSkillsHome(), 'sources');
}
