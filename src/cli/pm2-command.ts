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
      // Node's spawn with `{ shell: true }` does NOT quote the command or args —
      // it joins them verbatim into the cmd.exe command line. Without quoting, a
      // space anywhere (the pm2.cmd path under "C:\Program Files\…", or the
      // ecosystem config path under "C:\Users\First Last\.botmux\…") gets
      // word-split by cmd.exe and pm2 receives a truncated path. Wrap each token
      // in double quotes; cmd.exe (/s) strips them when it re-parses, and the
      // npm .cmd shim forwards the quoted args through %* intact. Windows paths
      // can't contain `"`, so simple wrapping is sufficient here.
      const quote = (s: string): string => `"${s}"`;
      return { command: quote(pm2Script), args: args.map(quote), shell: true };
    }
    return { command: nodePath, args: [pm2Script, ...args] };
  }
  return { command: pm2Script, args };
}
