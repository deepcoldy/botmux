export interface SpawnCommand {
  command: string;
  args: string[];
  shell?: boolean;
}

export function buildPm2SpawnCommand(
  pm2Script: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): SpawnCommand {
  if (platform === 'win32' && pm2Script !== 'pm2') {
    if (pm2Script.toLowerCase().endsWith('.cmd')) {
      return { command: pm2Script, args, shell: true };
    }
    return { command: nodePath, args: [pm2Script, ...args] };
  }
  return { command: pm2Script, args };
}
