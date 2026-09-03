import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { createClaudeFamilyAdapter } from './claude-code.js';
import type { CliAdapter } from './types.js';

/** Relay CLI (binary `relay`) is the current
 *  release name of what used to ship as Seed — a fork of Claude Code.
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
    // Relay 是 Claude Code 的 fork，落盘 transcript 与 Claude Code 逐字同构：
    // per-project JSONL 里带权威回合终态（最终 assistant `stop_reason:end_turn`
    // 非工具停 + system 回合标记），与 claude-code 依赖的边界完全一致（在真实
    // ~/.relay/projects/*.jsonl 上核实）。因此它能诚实兑现同一份 turn-terminal
    // 契约，opt-in 让 relay 系 bot 可当会议 agent（产出受管纪要/会中发言，靠这个
    // 权威边界终结投递回合、去重防同一投递外部副作用执行两次）。
    reliableTurnTerminal: true,
    // Relay's SuperRelay apiKey lives in `<configDir>/byted-cloud-auth.json`
    // (NOT under bytedcli), and bytedcli SSO state lives under
    // ~/.local/share/bytedcli — keep BOTH real + writable inside the file sandbox
    // so token refresh / login persist (else the refreshed token lands somewhere
    // the sandbox doesn't expose and the session 401s on the next refresh).
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
