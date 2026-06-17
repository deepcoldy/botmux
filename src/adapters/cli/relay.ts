import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCommand } from './registry.js';
import { createClaudeFamilyAdapter } from './claude-code.js';
import { logger } from '../../utils/logger.js';
import type { CliAdapter } from './types.js';

/** Relay CLI (binary `relay`) is the current release name of what used to ship
 *  as Seed — a fork of Claude Code. It is identical to Claude Code in flags,
 *  slash commands and on-disk session layout (per-project JSONL transcripts,
 *  `sessions/<pid>.json`, `tasks/` fd locks, keybindings.json, settings.json
 *  hooks); it differs only in the binary name, its auth, and its data root —
 *  which it isolates to a `.claude-runtime` directory *inside its own install
 *  package* (rather than `~/.claude`), respecting `CLAUDE_CONFIG_DIR` when set.
 *
 *  Relay and Seed share the same package internals, so this adapter is a near
 *  clone of `seed.ts`; it lives as its own file (and CliId) because they are
 *  distinct binaries — a user may have either one, or both, on PATH, and
 *  botmux must spawn/resume each by its real name. */

/** Derive Relay's `.claude-runtime` data root from the resolved binary.
 *
 *  `which relay` returns an ephemeral fnm/nvm shim (e.g.
 *  `/run/user/.../fnm_multishells/<pid>_.../bin/relay`); realpath follows the
 *  symlink chain to the package's `dist/cli.js`, whose package root is two
 *  levels up. `.claude-runtime` sits at that package root. Deriving from the
 *  binary on every spawn means a node/fnm switch (which moves the binary)
 *  auto-tracks to the matching runtime dir — and it equals the path a bare
 *  `relay` uses by default, so botmux-spawned and hand-started Relay sessions
 *  share one config (settings, history, cross-resume).
 *
 *  Falls back to `~/.claude-runtime` only if realpath fails (unusual install
 *  layout) — Relay still runs, but the JSONL bridge may target the wrong dir;
 *  we log so it's diagnosable rather than silently degraded. */
export function deriveRelayDataDir(bin: string): string {
  try {
    const real = realpathSync(bin);          // <pkg>/dist/cli.js
    const pkgRoot = dirname(dirname(real));   // <pkg>
    return join(pkgRoot, '.claude-runtime');
  } catch (err) {
    const fallback = join(homedir(), '.claude-runtime');
    logger.warn(`[relay] could not resolve .claude-runtime from binary "${bin}" (${err instanceof Error ? err.message : String(err)}); falling back to ${fallback}`);
    return fallback;
  }
}

export function createRelayAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'relay');
  const dataDir = deriveRelayDataDir(bin);
  return createClaudeFamilyAdapter({
    id: 'relay',
    // Relay reuses bytedcli login state (RELAY_BYTEDCLI_DATA_DIR overrides it;
    // SEED_BYTEDCLI_DATA_DIR is a migration-era fallback) — keep the bytedcli
    // dir real + writable inside the file sandbox so token refresh/login persist.
    authPaths: ['~/.local/share/bytedcli'],
    resumeBin: 'relay',
    dataDir,
    // Relay keeps `.claude.json` inside its data root (CLAUDE_CONFIG_DIR layout),
    // unlike Claude Code which puts it at `~/.claude.json`.
    stateJsonPath: join(dataDir, '.claude.json'),
    // Pin CLAUDE_CONFIG_DIR to Relay's own default so the dir botmux watches and
    // the dir Relay writes to are provably identical — and still equal to what a
    // hand-started `relay` resolves, preserving config alignment.
    spawnEnv: { CLAUDE_CONFIG_DIR: dataDir },
    // Relay's model set is SuperRelay-gateway-defined, not the Anthropic
    // aliases — skip the setup model prompt; users pick via /model.
    modelChoices: undefined,
  }, bin);
}

export const create = createRelayAdapter;
