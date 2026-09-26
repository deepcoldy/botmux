/**
 * Ensure the `herdr` binary is installed before HerdrBackend tries to spawn
 * agents. Strategy is intentionally narrow per user request — only the
 * official curl installer (https://herdr.dev/install.sh) is used; brew/nix
 * paths exist in the upstream docs but live outside our auto-bootstrap.
 *
 * Like ensureTmux, herdr is treated as nice-to-have at this layer: a failed
 * install never throws. The caller (ensureDependencies) decides whether to
 * surface the warning, and HerdrBackend itself will refuse to run when the
 * binary is missing — falling back to PTY/tmux through bots.json's
 * backendType remains the user's responsibility.
 */
import { execSync, spawnSync } from 'node:child_process';

export interface HerdrResult {
  installed: boolean;
  version?: string;
  /** True iff we ran the installer (vs. herdr was already present). */
  freshInstall: boolean;
  /** When installed=false: human-readable reason for the caller's warning. */
  reason?: string;
  /** When installed=false: the manual command we'd have run. */
  manualCommand?: string;
}

/** Probe `herdr --version` (or `-V`). Returns the trimmed version string, or
 *  undefined if the binary is missing / errors out. */
function probeHerdrVersion(): string | undefined {
  try {
    const out = execSync('herdr --version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return out.trim();
  } catch {
    return undefined;
  }
}

/** Run `curl -fsSL https://herdr.dev/install.sh | sh`. Returns true on
 *  exit 0. Output is inherited so the user sees the installer's progress
 *  and any error it prints. */
function runCurlInstaller(): boolean {
  // Use bash -c with a pipeline so we can capture failure of either side via
  // pipefail. Without pipefail, `curl ... | sh` reports `sh`'s status only,
  // which is useless when the network fetch silently 404s.
  const cmd = 'set -o pipefail; curl -fsSL https://herdr.dev/install.sh | sh';
  const result = spawnSync('bash', ['-c', cmd], {
    stdio: 'inherit',
    timeout: 5 * 60_000, // 5 min — slow networks downloading a release binary
  });
  return result.status === 0;
}

export async function ensureHerdr(): Promise<HerdrResult> {
  const existing = probeHerdrVersion();
  if (existing) {
    return { installed: true, version: existing, freshInstall: false };
  }

  console.log('⚠️  herdr was not found. Installing it through the official install.sh...');
  const ok = runCurlInstaller();
  if (ok) {
    const after = probeHerdrVersion();
    if (after) {
      console.log(`✅ herdr ${after} 安装完成`);
      return { installed: true, version: after, freshInstall: true };
    }
    return {
      installed: false,
      freshInstall: true,
      reason: 'The installer exited successfully, but herdr is still not on PATH. Restart the shell or check whether ~/.local/bin / ~/.cargo/bin is on PATH.',
      manualCommand: 'curl -fsSL https://herdr.dev/install.sh | sh',
    };
  }
  return {
    installed: false,
    freshInstall: false,
    reason: 'The official install.sh failed (curl, network, or permission error)',
    manualCommand: 'curl -fsSL https://herdr.dev/install.sh | sh',
  };
}
