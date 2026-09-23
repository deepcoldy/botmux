import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { CODEX_REASONING_EFFORTS } from './codex-reasoning-effort.js';

const SHIM_NAME = 'codex';

export function renderAidenCodexShim(): string {
  const allowed = CODEX_REASONING_EFFORTS.join('|');
  return [
    '#!/bin/sh',
    'set -eu',
    '',
    'real_bin=${BOTMUX_AIDEN_CODEX_REAL_BIN:-}',
    'effort=${BOTMUX_AIDEN_CODEX_REASONING_EFFORT:-}',
    `case "$effort" in ${allowed}) ;;`,
    '  *) echo "botmux aiden-codex shim: missing launch configuration" >&2; exit 1 ;;',
    'esac',
    'if [ -z "$real_bin" ] || [ ! -x "$real_bin" ]; then',
    '  echo "botmux aiden-codex shim: real codex executable is unavailable" >&2',
    '  exit 1',
    'fi',
    'unset BOTMUX_AIDEN_CODEX_REAL_BIN BOTMUX_AIDEN_CODEX_REASONING_EFFORT',
    'exec "$real_bin" -c "model_reasoning_effort=\\\"$effort\\\"" "$@"',
    '',
  ].join('\n');
}

/** Materialize the PATH shim outside Bun's virtual /$bunfs filesystem. */
export function installAidenCodexShim(binDir: string): string {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const path = join(binDir, SHIM_NAME);
  atomicWriteFileSync(path, renderAidenCodexShim(), { mode: 0o755 });
  accessSync(path, constants.X_OK);
  return binDir;
}
