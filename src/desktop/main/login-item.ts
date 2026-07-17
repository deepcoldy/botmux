import { join } from 'node:path';

export interface DetectLegacyAutostartInput {
  homeDir: string;
  existsSync(path: string): boolean;
}

export function legacyAutostartPath(homeDir: string): string {
  // The desktop app uses Electron login items, but still reports the older CLI
  // LaunchAgent so users can migrate knowingly.
  return join(homeDir, 'Library', 'LaunchAgents', 'com.botmux.daemon.plist');
}

export function detectLegacyAutostart(input: DetectLegacyAutostartInput): {
  legacyAutostart: boolean;
  legacyPath: string;
} {
  const legacyPath = legacyAutostartPath(input.homeDir);
  return { legacyAutostart: input.existsSync(legacyPath), legacyPath };
}
