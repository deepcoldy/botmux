/**
 * Ensure `opusenc` (opus-tools) is installed — the voice-summary feature
 * encodes synthesized PCM into the ogg/opus a Feishu voice bubble needs.
 *
 * Reuses the same package-manager / sudo machinery as ensure-tmux
 * (brew / conda / apt / dnf / yum / pacman / apk / zypper, NOPASSWD-sudo or
 * TTY-prompt escalation). Like tmux it's non-fatal: callers inspect the
 * result and fall back to a manual hint. Package name `opus-tools` is the
 * same across every supported manager; the binary it provides is `opusenc`.
 */
import { spawnSync } from 'node:child_process';
import { detectPlatform, type PlatformInfo } from './detect-platform.js';
import { aptUpdateBeforeInstall, buildInstallArgv, runInstall, suggestManualCommand } from './ensure-tmux.js';

const PKG = 'opus-tools';

export interface OpusToolsResult {
  installed: boolean;
  version?: string;
  /** True iff we ran an installer (vs. it was already present). */
  freshInstall: boolean;
  reason?: string;
  manualCommand?: string;
}

/** `opusenc --version` → first line, or undefined if the binary is absent. */
export function probeOpusenc(): string | undefined {
  const r = spawnSync('opusenc', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  if (r.error || r.status !== 0) return undefined;
  return (r.stdout?.trim().split('\n')[0]) || PKG;
}

export async function ensureOpusTools(info?: PlatformInfo): Promise<OpusToolsResult> {
  const present = probeOpusenc();
  if (present) return { installed: true, version: present, freshInstall: false };

  const platform = info ?? detectPlatform();
  console.log('⚠️  The Opus encoder (opus-tools) was not found. Installing it...');

  const tried: string[] = [];
  for (const pm of platform.packageManagers) {
    if (pm === 'unknown') continue;
    const argv = buildInstallArgv(pm, PKG, platform);
    if (!argv) { tried.push(`${pm} (skipped: the current user has neither sudo nor a TTY)`); continue; }
    if (pm === 'apt') aptUpdateBeforeInstall(platform);
    console.log(`   Trying ${pm}: ${argv.join(' ')}`);
    if (runInstall(argv)) {
      const v = probeOpusenc();
      if (v) {
        console.log(`✅ opus-tools installed (via ${pm})`);
        return { installed: true, version: v, freshInstall: true };
      }
      tried.push(`${pm} (the command succeeded, but opusenc is still unavailable)`);
    } else {
      tried.push(`${pm} (command exited non-zero)`);
    }
  }

  const preferred = platform.packageManagers.find(p => p !== 'unknown') ?? 'unknown';
  const reasonLines = ['Automatic opus-tools installation failed', 'Attempted:', ...tried.map(t => `  - ${t}`)];
  if (platform.os === 'darwin' && !platform.packageManagers.includes('brew')) {
    reasonLines.push('On macOS, install Homebrew first, then run `brew install opus-tools`.');
  }
  return {
    installed: false,
    freshInstall: false,
    reason: reasonLines.join('\n'),
    manualCommand: suggestManualCommand(preferred, PKG),
  };
}
