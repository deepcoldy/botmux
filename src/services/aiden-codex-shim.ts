import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { CODEX_REASONING_EFFORTS } from './codex-reasoning-effort.js';
import { AIDEN_CODEX_SHELL_CONFIG_FILE_ENV } from './aiden-codex-shim.shared.js';

export { AIDEN_CODEX_SHELL_CONFIG_FILE_ENV };

const SHIM_NAME = 'codex';

export function renderAidenCodexShim(): string {
  const allowed = CODEX_REASONING_EFFORTS.join('|');
  return [
    '#!/bin/sh',
    'set -eu',
    '',
    'real_bin=${BOTMUX_AIDEN_CODEX_REAL_BIN:-}',
    'effort=${BOTMUX_AIDEN_CODEX_REASONING_EFFORT:-}',
    'config_file=${' + AIDEN_CODEX_SHELL_CONFIG_FILE_ENV + ':-}',
    // Effort is optional: shell-env-only launches (trigger-user identity, lark
    // tool binding) route configs through this shim without a reasoning level.
    // Both empty is still a misconfiguration (shim installed with nothing to
    // inject) — fail closed rather than silently exec'ing as a pass-through.
    `case "$effort" in ${allowed}) ;;`,
    '  "") [ -n "$config_file" ] || { echo "botmux aiden-codex shim: missing launch configuration" >&2; exit 1; } ;;',
    '  *) echo "botmux aiden-codex shim: invalid reasoning effort configuration" >&2; exit 1 ;;',
    'esac',
    'if [ -z "$real_bin" ] || [ ! -x "$real_bin" ]; then',
    '  echo "botmux aiden-codex shim: real codex executable is unavailable" >&2',
    '  exit 1',
    'fi',
    'if [ -n "${BOTMUX_AIDEN_CODEX_PARENT_PATH:-}" ]; then export PATH="$BOTMUX_AIDEN_CODEX_PARENT_PATH"; fi',
    'unset BOTMUX_AIDEN_CODEX_REAL_BIN BOTMUX_AIDEN_CODEX_REASONING_EFFORT BOTMUX_AIDEN_CODEX_PARENT_PATH ' + AIDEN_CODEX_SHELL_CONFIG_FILE_ENV,
    // Read one complete `key=value` per line and PREPEND each `-c <line>`:
    // codex clap accepts -c only before the `resume` subcommand. Prepending
    // reverses the file order, but every line sets a DISTINCT key, so the
    // resulting config is order-independent. The input redirection runs in
    // this shell (not a pipeline subshell), so the rebuilt positional params
    // survive. `read -r` takes the line verbatim — no quoting/eval, and
    // whitespace inside a value stays inside the single quoted argv element.
    'if [ -n "$config_file" ]; then',
    '  while IFS= read -r line || [ -n "$line" ]; do',
    '    [ -n "$line" ] || continue',
    '    set -- -c "$line" "$@"',
    '  done < "$config_file"',
    'fi',
    'if [ -n "$effort" ]; then set -- -c "model_reasoning_effort=\\"$effort\\"" "$@"; fi',
    'exec "$real_bin" "$@"',
    '',
  ].join('\n');
}

/** Materialize the PATH shim outside Bun's virtual /$bunfs filesystem. */
export function installAidenCodexShim(binDir: string): string {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const path = join(binDir, SHIM_NAME);
  atomicWriteFileSync(path, renderAidenCodexShim(), { mode: 0o755 });
  accessSync(path, constants.X_OK);
  // Run after the pane shell has loaded its PATH. childEnv.PATH is deliberately
  // not transported by tmux/zellij, so prepending it in the worker is ineffective.
  atomicWriteFileSync(join(binDir, 'launch'), [
    '#!/bin/sh', 'set -eu',
    'export BOTMUX_AIDEN_CODEX_PARENT_PATH="$PATH"',
    'export PATH="$(dirname -- "$0"):$PATH"',
    'exec "$@"', '',
  ].join('\n'), { mode: 0o755 });
  return binDir;
}

/**
 * Persist the transported Codex `-c key=value` overrides (one per line) for the
 * PATH shim to read back. Lives next to the shim inside the session identity dir
 * (0700); the file itself is 0600 because a co-tenant could otherwise read the
 * session paths/IDs it carries. Kept as its own exported seam so the file mode
 * is directly testable (the worker only derives the path).
 */
export function writeAidenCodexShellConfigs(shimDir: string, configs: readonly string[]): string {
  const file = join(shimDir, 'shell-configs');
  // A config value never contains a newline (JSON.stringify keeps it escaped),
  // so one line per override round-trips exactly through the shim's `read -r`.
  atomicWriteFileSync(file, `${configs.join('\n')}\n`, { mode: 0o600 });
  return file;
}
