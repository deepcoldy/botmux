import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCommand } from './registry.js';
import { createClaudeFamilyAdapter } from './claude-code.js';
import { logger } from '../../utils/logger.js';
import type { CliAdapter } from './types.js';

/** Seed CLI (`@bytedance-seed/claude-code`, binary `seed`) is a ByteDance fork
 *  of Claude Code: identical flags, slash commands, and on-disk session layout
 *  (per-project JSONL transcripts, `sessions/<pid>.json`, `tasks/` fd locks,
 *  keybindings.json, settings.json hooks). It differs only in the binary name,
 *  its auth, and its data root — which it isolates to a
 *  `.claude-runtime` directory *inside its own install package* (rather than
 *  `~/.claude`), respecting `CLAUDE_CONFIG_DIR` when set.
 *
 *  So Seed reuses the entire Claude-family adapter; the only work here is
 *  locating that `.claude-runtime` so botmux watches exactly where Seed writes. */

/** Derive Seed's `.claude-runtime` data root from the resolved binary.
 *
 *  `which seed` returns an ephemeral fnm/nvm shim (e.g.
 *  `/run/user/.../fnm_multishells/<pid>_.../bin/seed`); realpath follows the
 *  symlink chain to the package's `dist/cli.js`, whose package root is two
 *  levels up. `.claude-runtime` sits at that package root. Deriving from the
 *  binary on every spawn means a node/fnm switch (which moves the binary)
 *  auto-tracks to the matching runtime dir — and it equals the path a bare
 *  `seed` uses by default, so botmux-spawned and hand-started Seed sessions
 *  share one config (settings, history, cross-resume).
 *
 *  Falls back to `~/.claude-runtime` only if realpath fails (unusual install
 *  layout) — Seed still runs, but the JSONL bridge may target the wrong dir;
 *  we log so it's diagnosable rather than silently degraded. */
export function deriveSeedDataDir(bin: string): string {
  try {
    const real = realpathSync(bin);          // <pkg>/dist/cli.js
    const pkgRoot = dirname(dirname(real));   // <pkg>
    return join(pkgRoot, '.claude-runtime');
  } catch (err) {
    const fallback = join(homedir(), '.claude-runtime');
    logger.warn(`[seed] could not resolve .claude-runtime from binary "${bin}" (${err instanceof Error ? err.message : String(err)}); falling back to ${fallback}`);
    return fallback;
  }
}

export function createSeedAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'seed');
  const dataDir = deriveSeedDataDir(bin);
  return createClaudeFamilyAdapter({
    id: 'seed',
    authPaths: ['~/.local/share/bytedcli'],
    resumeBin: 'seed',
    dataDir,
    // Seed keeps `.claude.json` inside its data root (CLAUDE_CONFIG_DIR layout),
    // unlike Claude Code which puts it at `~/.claude.json`.
    stateJsonPath: join(dataDir, '.claude.json'),
    // Pin CLAUDE_CONFIG_DIR to Seed's own default so the dir botmux watches and
    // the dir Seed writes to are provably identical — and still equal to what a
    // hand-started `seed` resolves, preserving config alignment.
    spawnEnv: { CLAUDE_CONFIG_DIR: dataDir },
    // Seed's model set is gateway-defined, not the
    // Anthropic aliases — skip the setup model prompt; users pick via /model.
    modelChoices: undefined,
  }, bin);
}

export const create = createSeedAdapter;
