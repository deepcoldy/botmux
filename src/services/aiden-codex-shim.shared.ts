/**
 * Zero-dependency constants shared by the Node-side Aiden Codex shim
 * (`aiden-codex-shim.ts`, which imports node:fs) and the wrapper launch
 * builder (`setup/cli-selection.ts`, also pulled into the browser dashboard
 * bundle). Keep this file free of any Node-only import so referencing these
 * names from cli-selection cannot drag node:fs into the esbuild browser build.
 */

/**
 * Env var carrying the path of a file with one complete Codex `-c key=value`
 * override per line — overrides the Aiden gateway rejects from
 * `aiden x codex` passthrough argv but which Botmux must still deliver to the
 * REAL codex that Aiden spawns through the PATH shim: the
 * `shell_environment_policy.*` session/identity overrides plus the
 * `service_tier` / `tui.auto_recap` root overrides. A file (not a multiline env
 * value) keeps the values out of the tmux command string and lets the shim read
 * them with plain `read` instead of eval/quoting.
 */
export const AIDEN_CODEX_SHELL_CONFIG_FILE_ENV = 'BOTMUX_AIDEN_CODEX_SHELL_CONFIG_FILE';
