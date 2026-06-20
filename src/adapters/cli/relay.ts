import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { createClaudeFamilyAdapter } from './claude-code.js';
import type { CliAdapter } from './types.js';

/** Relay CLI (`@bytedance-relay/claude-code`, binary `relay`) is the current
 *  release name of what used to ship as Seed — a ByteDance fork of Claude Code.
 *  It is identical to Claude Code in flags, slash commands and on-disk session
 *  layout (per-project JSONL transcripts, `sessions/<pid>.json`, `tasks/` fd
 *  locks, keybindings.json, settings.json hooks); it differs only in the binary
 *  name, its auth (ByteCloud / bytedcli / SuperRelay), and its data root.
 *
 *  IMPORTANT — Relay 3.x moved its default config dir.  Older Seed/Relay kept a
 *  `.claude-runtime` directory *inside the install package*; Relay 3.x now
 *  defaults to `~/.relay` (honoring `RELAY_CONFIG_DIR`) for the standard
 *  node_modules install and AUTO-MIGRATES the legacy `.claude-runtime` away —
 *  but only when `CLAUDE_CONFIG_DIR` is unset.  Botmux pins `CLAUDE_CONFIG_DIR`,
 *  so the migration never fires; we must therefore point at Relay's *real*
 *  default ourselves.  This is hard-coded to track the installed Relay; if a
 *  future Relay changes the location again, update `deriveRelayDataDir` to match
 *  (see the still-different Seed adapter, which keeps `.claude-runtime`). */

/** Relay's config/data root: `RELAY_CONFIG_DIR` override, else `~/.relay`.
 *  This is exactly what a bare `relay` resolves on a node_modules install, so a
 *  hand-run `relay login` (token written to `~/.relay/byted-cloud-auth.json`)
 *  and a botmux-spawned Relay share one login — fixing the 401 caused by the old
 *  `<pkg>/.claude-runtime` derivation, where Relay 3.x never writes. */
export function deriveRelayDataDir(): string {
  return process.env.RELAY_CONFIG_DIR?.trim() || join(homedir(), '.relay');
}

export function createRelayAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'relay');
  const dataDir = deriveRelayDataDir();
  return createClaudeFamilyAdapter({
    id: 'relay',
    // Relay's SuperRelay apiKey lives in `<configDir>/byted-cloud-auth.json`
    // (NOT under bytedcli), and bytedcli SSO state lives under
    // ~/.local/share/bytedcli — keep BOTH real + writable inside the file sandbox
    // so token refresh / login persist (else the overlay isolates the refreshed
    // token and the session 401s on the next refresh).
    authPaths: ['~/.local/share/bytedcli', join(dataDir, 'byted-cloud-auth.json')],
    resumeBin: 'relay',
    dataDir,
    // Relay keeps `.claude.json` inside its config dir (CLAUDE_CONFIG_DIR layout),
    // unlike Claude Code which puts it at `~/.claude.json`.
    stateJsonPath: join(dataDir, '.claude.json'),
    // Pin CLAUDE_CONFIG_DIR to Relay's own default so the dir botmux watches and
    // the dir Relay writes to are provably identical — and still equal to what a
    // hand-started `relay` resolves, preserving config + login alignment.
    spawnEnv: { CLAUDE_CONFIG_DIR: dataDir },
    // Relay's model set is SuperRelay-gateway-defined, not the Anthropic
    // aliases — skip the setup model prompt; users pick via /model.
    modelChoices: undefined,
  }, bin);
}

export const create = createRelayAdapter;
