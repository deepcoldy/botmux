import { join } from 'node:path';

/**
 * Neutralise the env vars that point DIRECTLY at a live Botmux/CLI home, so a
 * test run cannot reach the caller's real data through them.
 *
 * WHY THIS IS SEPARATE FROM THE `homedir()` OVERRIDE: these are explicit escape
 * hatches, not home-derivation APIs. `src/bot-registry.ts` treats `BOTS_CONFIG`
 * as the TOP of its resolution chain — an exact file path that deliberately wins
 * over anything derived from `homedir()` — and `src/cli/pm2-existing-client.ts`
 * reads `PM2_HOME` the same way. Mocking `node:os` does nothing for either. In a
 * normal Botmux shell these are already set to the live fleet (measured in a real
 * session: `BOTS_CONFIG=/root/.botmux/bots.json`, `PM2_HOME=/root/.botmux/pm2`),
 * so without this the fence's safety would depend on the runner's environment
 * happening to be clean.
 *
 * DELETE rather than redirect, deliberately. Redirecting `BOTS_CONFIG` into the
 * fenced home looks tidier but changes behaviour for every test that never set it:
 * `resolveBotConfigPath()` THROWS when the var is set and the file is missing
 * ("refusing to fall back to a different registry") instead of falling through to
 * `<home>/.botmux/bots.json`. Deleting lets the normal resolution chain run, and
 * that chain is already fenced because it derives from the mocked `homedir()`. A
 * test that wants an exact path sets the var itself.
 *
 * Shared by both runners' setup files (`test/unit-setup.ts` for vitest,
 * `test/bun-test-fence.ts` for `bun test`) so the two fences cannot drift apart —
 * the `userInfo` gap existed precisely because one side was patched and the other
 * was not.
 */
/**
 * @param env The environment to mutate. Defaults to the real `process.env`, which
 *   is what both setup files want. Tests pass a throwaway object so they can
 *   exercise the key list without touching (or having to restore) the live
 *   environment — the helper rewrites CLI homes and `XDG_*` too, not just the
 *   exact-path list, so a caller that snapshots only part of it leaves later tests
 *   pointing at a deleted directory.
 */
export function fenceHomeRootedEnv(fencedHome: string, env: NodeJS.ProcessEnv = process.env): void {
  // Exact-path pointers into a Botmux home. Nothing here has a safe fenced
  // default worth inventing, so drop them and let home-derived resolution win.
  //
  // Every one of these is an exact FILE or DIRECTORY override that bypasses
  // `homedir()`/`userInfo()` entirely, and every one leads to real writes — so a
  // value inherited from the caller's shell would have the test mutate live state.
  // Verified write paths behind each: usage-ledger mkdir/write/rename/append,
  // control-audit mkdir+append (a key the daemon genuinely persists),
  // mir-local-runtime read-modify-write+rename of the miramcp config and
  // create/delete of its pidfile (and it can start a bridge process),
  // index-core-only mkdir at module load which then becomes SESSION_DATA_DIR.
  const exactPathOverrides = [
    'BOTS_CONFIG',
    'PM2_HOME',
    'PLUGIN_PM2_HOME',
    'BOTMUX_USAGE_DIR',
    'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH',
    'BOTMUX_CORE_STATE_DIR',
    'MIRAMCP_CONFIG_PATH',
    'MIRA_CONFIG_PATH',
    'MIRAMCP_PID_FILE',
  ];
  for (const name of exactPathOverrides) delete env[name];

  // Per-CLI config homes that production reads directly (verified present in
  // `src/`: codex, claude, grok, traex, hermes, relay, lark-cli). Each bypasses
  // `homedir()`, so an inherited value would escape the fence. Only rewritten when
  // the caller had one set — an unset value means the adapter derives its own
  // default from the mocked `homedir()`, and inventing a path here could change
  // what a test is asserting.
  const cliHomes: Array<[string, string]> = [
    ['CODEX_HOME', '.codex'],
    ['CLAUDE_CONFIG_DIR', '.claude'],
    ['GROK_HOME', '.grok'],
    ['TRAE_HOME', '.trae'],
    ['HERMES_HOME', '.hermes'],
    ['HERMES_BOTMUX_SOURCE_HOME', '.hermes-source'],
    ['RELAY_CONFIG_DIR', '.relay'],
    ['LARKSUITE_CLI_DATA_DIR', join('.local', 'share', 'lark-cli')],
  ];
  for (const [name, relative] of cliHomes) {
    if (env[name]) env[name] = join(fencedHome, relative);
  }

  // XDG + Windows profile dirs — defensive. Nothing in `src/` currently resolves a
  // Botmux root from them, but they are the conventional way a spawned CLI gets
  // pointed at a config tree, and a stray inherited value would escape the fence.
  const xdg: Array<[string, string]> = [
    ['XDG_CONFIG_HOME', '.config'],
    ['XDG_DATA_HOME', join('.local', 'share')],
    ['XDG_STATE_HOME', join('.local', 'state')],
    ['XDG_CACHE_HOME', '.cache'],
    ['APPDATA', join('AppData', 'Roaming')],
    ['LOCALAPPDATA', join('AppData', 'Local')],
  ];
  for (const [name, relative] of xdg) {
    if (env[name]) env[name] = join(fencedHome, relative);
  }
}
